import type Database from "better-sqlite3";
import { getEdgesFrom, getEdgesTo, getIssue, getPR } from "../graph/db.js";
import type { IssueNode, PRNode } from "../graph/db.js";
import { searchAll } from "../graph/fts.js";

// ── Scoring constants (configurable) ──────────────────────────────────────────

export const SCORE_WEIGHTS = {
  DISTANCE_BASE: 3,
  MERGE_WEIGHT: { merged: 3, open: 2, closed: 1 },
  RECENCY_HALF_LIFE_DAYS: 180,
  FTS_MATCH_BONUS: 0.5,
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export type SeedType = "file" | "issue" | "pr" | "keyword";

export interface Seed {
  type: SeedType;
  value: string;
  displayLabel: string;
}

export interface ScoredPR {
  pr: PRNode;
  score: number;
  distance: number;
  fromFts: boolean;
}

export interface ScoredIssue {
  issue: IssueNode;
  score: number;
  distance: number;
  fromFts: boolean;
}

export interface ScoredFile {
  id: string;
  path: string;
  coChangeCount: number;
}

export interface TraversalResult {
  prs: ScoredPR[];
  issues: ScoredIssue[];
  files: ScoredFile[];
  seedType: SeedType;
  seedFellBack: boolean;
}

// ── Seed detection ─────────────────────────────────────────────────────────────

const FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|cpp|c|h|md|yaml|yml|json|toml|sh|sql)$/i;

export function detectSeed(query: string): Seed {
  const trimmed = query.trim();

  // PR: "pr#123", "pr 123", "pr123"
  const prMatch = /^pr\s*#?(\d+)$/i.exec(trimmed);
  if (prMatch) {
    return { type: "pr", value: prMatch[1]!, displayLabel: `PR #${prMatch[1]}` };
  }

  // Issue: "#123" or bare number
  const issueMatch = /^#?(\d+)$/.exec(trimmed);
  if (issueMatch) {
    return { type: "issue", value: issueMatch[1]!, displayLabel: `Issue #${issueMatch[1]}` };
  }

  // File: contains "/" or ends in known extension
  if (trimmed.includes("/") || FILE_EXTENSIONS.test(trimmed)) {
    return { type: "file", value: trimmed, displayLabel: trimmed };
  }

  return { type: "keyword", value: trimmed, displayLabel: `"${trimmed}"` };
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

function recencyScore(timestampSeconds: number | null): number {
  if (!timestampSeconds) return 0.5;
  const daysSince = (Date.now() / 1000 - timestampSeconds) / 86400;
  return 1 / (1 + daysSince / SCORE_WEIGHTS.RECENCY_HALF_LIFE_DAYS);
}

function mergeWeight(outcome: string | null, state: string): number {
  if (outcome === "merged" || state === "MERGED") return SCORE_WEIGHTS.MERGE_WEIGHT.merged;
  if (state === "OPEN") return SCORE_WEIGHTS.MERGE_WEIGHT.open;
  return SCORE_WEIGHTS.MERGE_WEIGHT.closed;
}

function structuralScore(distance: number, mw: number, recency: number): number {
  return (SCORE_WEIGHTS.DISTANCE_BASE - distance) * mw * recency;
}

// ── BFS traversal ──────────────────────────────────────────────────────────────

function bfsFromFile(
  db: Database.Database,
  repo: string,
  fileId: string
): { prIds: Set<string>; coFileIds: Array<{ id: string; path: string; weight: number }> } {
  const prIds = new Set<string>();
  const touchEdges = getEdgesTo(db, "file", fileId, "TOUCHES");
  for (const e of touchEdges) prIds.add(e.from_id);

  // depth-2: from those PRs, find DEPENDS_ON + FIXES→issues
  const depth2PRs = new Set<string>();
  for (const prId of prIds) {
    for (const e of getEdgesFrom(db, "pr", prId, "DEPENDS_ON")) depth2PRs.add(e.to_id);
    for (const e of getEdgesTo(db, "pr", prId, "DEPENDS_ON")) depth2PRs.add(e.from_id);
  }
  for (const id of depth2PRs) prIds.add(id);

  const coEdgesFrom = getEdgesFrom(db, "file", fileId, "CO_CHANGES_WITH");
  const coEdgesTo   = getEdgesTo(db, "file", fileId, "CO_CHANGES_WITH");
  const coFileMap = new Map<string, { id: string; path: string; weight: number }>();
  for (const e of [...coEdgesFrom, ...coEdgesTo]) {
    const coId = e.from_id === fileId ? e.to_id : e.from_id;
    const existing = coFileMap.get(coId);
    coFileMap.set(coId, { id: coId, path: coId.replace(`${repo}::`, ""), weight: (existing?.weight ?? 0) + e.weight });
  }

  return {
    prIds,
    coFileIds: [...coFileMap.values()].sort((a, b) => b.weight - a.weight).slice(0, 5),
  };
}

function bfsFromIssue(
  db: Database.Database,
  repo: string,
  issueId: string
): { prIds: Set<string>; relatedIssueIds: Set<string> } {
  const prIds = new Set<string>();
  const relatedIssueIds = new Set<string>();

  // PRs that fix this issue
  for (const e of getEdgesTo(db, "issue", issueId, "FIXES")) prIds.add(e.from_id);

  // REFERENCES/MENTIONS edges
  for (const e of getEdgesFrom(db, "issue", issueId, "REFERENCES")) {
    if (e.to_type === "issue") relatedIssueIds.add(e.to_id);
    else if (e.to_type === "pr") prIds.add(e.to_id);
  }
  for (const e of getEdgesFrom(db, "issue", issueId, "MENTIONS")) {
    if (e.to_type === "issue") relatedIssueIds.add(e.to_id);
  }
  for (const e of getEdgesTo(db, "issue", issueId, "REFERENCES")) prIds.add(e.from_id);
  for (const e of getEdgesTo(db, "issue", issueId, "MENTIONS")) prIds.add(e.from_id);

  // depth-2: from those PRs, get DEPENDS_ON + their FIXES issues
  const extraPRs = new Set<string>();
  for (const prId of prIds) {
    for (const e of getEdgesFrom(db, "pr", prId, "DEPENDS_ON")) extraPRs.add(e.to_id);
    const fixEdges = getEdgesFrom(db, "pr", prId, "FIXES");
    for (const e of fixEdges) if (e.to_id !== issueId) relatedIssueIds.add(e.to_id);
  }
  for (const id of extraPRs) prIds.add(id);

  return { prIds, relatedIssueIds };
}

function bfsFromPR(
  db: Database.Database,
  repo: string,
  prId: string
): { issueIds: Set<string>; relatedPRIds: Set<string>; fileIds: string[] } {
  const issueIds = new Set<string>();
  const relatedPRIds = new Set<string>();

  for (const e of getEdgesFrom(db, "pr", prId, "FIXES")) issueIds.add(e.to_id);
  for (const e of getEdgesFrom(db, "pr", prId, "DEPENDS_ON")) relatedPRIds.add(e.to_id);
  for (const e of getEdgesTo(db, "pr", prId, "DEPENDS_ON")) relatedPRIds.add(e.from_id);
  for (const e of getEdgesFrom(db, "pr", prId, "SUPERSEDES")) relatedPRIds.add(e.to_id);
  for (const e of getEdgesFrom(db, "pr", prId, "REFERENCES")) {
    if (e.to_type === "issue") issueIds.add(e.to_id);
  }

  const fileIds = getEdgesFrom(db, "pr", prId, "TOUCHES").map((e) => e.to_id).slice(0, 8);

  return { issueIds, relatedPRIds, fileIds };
}

// ── Main hybrid candidate pool builder ────────────────────────────────────────

export function buildCandidatePool(
  db: Database.Database,
  repo: string,
  seed: Seed
): { entities: ScoredEntity[]; coFiles: ScoredFile[]; seedFellBack: boolean } {
  const prScores   = new Map<string, { distance: number; fromFts: boolean }>();
  const issueScores = new Map<string, { distance: number; fromFts: boolean }>();
  const coFiles: ScoredFile[] = [];
  let seedFellBack = false;

  // ── BFS pass ──
  if (seed.type === "file") {
    const fileId = `${repo}::${seed.value}`;
    const { prIds, coFileIds } = bfsFromFile(db, repo, fileId);
    if (prIds.size === 0) {
      // Fallback: treat as keyword
      seedFellBack = true;
      seed = { type: "keyword", value: seed.value, displayLabel: seed.displayLabel };
    } else {
      for (const id of prIds) prScores.set(id, { distance: 1, fromFts: false });
      for (const cf of coFileIds) {
        coFiles.push({ id: cf.id, path: cf.path, coChangeCount: cf.weight });
      }
    }
  } else if (seed.type === "issue") {
    const issueId = `${repo}#${seed.value}`;
    const { prIds, relatedIssueIds } = bfsFromIssue(db, repo, issueId);
    if (prIds.size === 0 && relatedIssueIds.size === 0) {
      seedFellBack = true;
      seed = { type: "keyword", value: seed.value, displayLabel: seed.displayLabel };
    } else {
      for (const id of prIds) prScores.set(id, { distance: 1, fromFts: false });
      issueScores.set(issueId, { distance: 0, fromFts: false });
      for (const id of relatedIssueIds) issueScores.set(id, { distance: 2, fromFts: false });
    }
  } else if (seed.type === "pr") {
    const prId = `${repo}#pr#${seed.value}`;
    const { issueIds, relatedPRIds, fileIds } = bfsFromPR(db, repo, prId);
    prScores.set(prId, { distance: 0, fromFts: false });
    for (const id of relatedPRIds) prScores.set(id, { distance: 1, fromFts: false });
    for (const id of issueIds) issueScores.set(id, { distance: 1, fromFts: false });
    // Also get co-files from TOUCHES
    for (const fid of fileIds) {
      const coFrom = getEdgesFrom(db, "file", fid, "CO_CHANGES_WITH");
      const coTo   = getEdgesTo(db, "file", fid, "CO_CHANGES_WITH");
      for (const e of [...coFrom, ...coTo].slice(0, 3)) {
        const coId = e.from_id === fid ? e.to_id : e.from_id;
        coFiles.push({ id: coId, path: coId.replace(`${repo}::`, ""), coChangeCount: e.weight });
      }
    }
  }

  // ── FTS pass (always runs) ──
  const ftsResults = searchAll(db, seed.value, 15);
  const ftsScoreMap = new Map(ftsResults.map((r) => [r.id, r.score]));

  for (const r of ftsResults) {
    if (r.type === "pr") {
      const existing = prScores.get(r.id);
      prScores.set(r.id, { distance: existing?.distance ?? 999, fromFts: true });
    } else {
      const existing = issueScores.get(r.id);
      issueScores.set(r.id, { distance: existing?.distance ?? 999, fromFts: true });
    }
  }

  // ── Score and build entity list ──
  const entities: ScoredEntity[] = [];

  for (const [id, meta] of prScores) {
    const pr = getPR(db, id);
    if (!pr) continue;
    const mw = mergeWeight(pr.outcome, pr.state);
    const recency = recencyScore(pr.merged_at ?? pr.closed_at);
    const distance = meta.distance === 999 ? 2 : meta.distance;
    let score = structuralScore(distance, mw, recency);
    if (meta.fromFts || ftsScoreMap.has(id)) score += SCORE_WEIGHTS.FTS_MATCH_BONUS;
    entities.push({ type: "pr", id, pr, score, distance, fromFts: meta.fromFts });
  }

  for (const [id, meta] of issueScores) {
    const issue = getIssue(db, id);
    if (!issue) continue;
    const mw = issue.state === "OPEN" ? SCORE_WEIGHTS.MERGE_WEIGHT.open : SCORE_WEIGHTS.MERGE_WEIGHT.closed;
    const recency = recencyScore(issue.closed_at ?? issue.created_at);
    const distance = meta.distance === 999 ? 2 : meta.distance;
    let score = structuralScore(distance, mw, recency);
    if (meta.fromFts || ftsScoreMap.has(id)) score += SCORE_WEIGHTS.FTS_MATCH_BONUS;
    entities.push({ type: "issue", id, issue, score, distance, fromFts: meta.fromFts });
  }

  entities.sort((a, b) => b.score - a.score);

  return { entities, coFiles, seedFellBack };
}

// ── Entity union type for the pool ────────────────────────────────────────────

export type ScoredEntity =
  | { type: "pr";    id: string; pr: PRNode;      score: number; distance: number; fromFts: boolean }
  | { type: "issue"; id: string; issue: IssueNode; score: number; distance: number; fromFts: boolean };

// ── Public traversal result builder ───────────────────────────────────────────

export function traverseFromSeed(
  db: Database.Database,
  repo: string,
  seed: Seed,
  opts: { maxPRs?: number; maxIssues?: number } = {}
): TraversalResult {
  const maxPRs    = opts.maxPRs    ?? 10;
  const maxIssues = opts.maxIssues ?? 8;

  const { entities, coFiles, seedFellBack } = buildCandidatePool(db, repo, seed);

  const prs: ScoredPR[]     = [];
  const issues: ScoredIssue[] = [];

  for (const e of entities) {
    if (e.type === "pr" && prs.length < maxPRs) {
      prs.push({ pr: e.pr, score: e.score, distance: e.distance, fromFts: e.fromFts });
    } else if (e.type === "issue" && issues.length < maxIssues) {
      issues.push({ issue: e.issue, score: e.score, distance: e.distance, fromFts: e.fromFts });
    }
  }

  return {
    prs,
    issues,
    files: coFiles,
    seedType: seed.type,
    seedFellBack,
  };
}
