import Database from "better-sqlite3";
import { getDb, getPR, getDecision, getConstraint, getEdgesFrom } from "../graph/db.js";
import type { PRNode, DecisionNode } from "../graph/db.js";
import { truncateAt } from "../shared/token-budget.js";
import { detectSeed, traverseFromSeed } from "./context.js";

// ── Result types ───────────────────────────────────────────────────────────────

export interface RelevantPR {
  number: number;
  title: string;
  outcome: string | null;
  files_changed: string[];
  approach: string | null;      // extracted from body_summary JSON if enriched
  why_relevant: string;
}

export interface RelevantFile {
  path: string;
  pr_count: number;
  co_changes: string[];         // top 3 co-change partner paths
}

export interface DesignDecision {
  problem: string;
  choice: string;
  rationale: string | null;
  confidence: number;
}

export interface ImplementationContext {
  query: string;
  repo: string;
  last_indexed: string | null;  // ISO timestamp or null
  relevant_prs: RelevantPR[];
  relevant_files: RelevantFile[];
  design_decisions: DesignDecision[];
  constraints: string[];
  rejected_alternatives: Array<{ option: string; reason: string | null }>;
  cold_start: boolean;
  cold_start_hint?: string;
}

// ── Main function ──────────────────────────────────────────────────────────────

export interface FindImplementationContextOptions {
  includFiles?: boolean;        // default true
  maxPRs?: number;              // default 3
  maxFiles?: number;            // default 3
}

export async function findImplementationContext(
  repo: string,
  query: string,
  opts: FindImplementationContextOptions = {}
): Promise<ImplementationContext> {
  const maxPRs   = opts.maxPRs   ?? 3;
  const maxFiles = opts.maxFiles ?? 3;

  const db = getDb(repo);

  // ── Cold-start detection ───────────────────────────────────────────────────
  const syncRow = db
    .prepare("SELECT last_fetched_at FROM sync_state WHERE repo=? AND resource_type='repo:index'")
    .get(repo) as { last_fetched_at: number } | undefined;

  if (!syncRow?.last_fetched_at) {
    return {
      query,
      repo,
      last_indexed: null,
      relevant_prs: [],
      relevant_files: [],
      design_decisions: [],
      constraints: [],
      rejected_alternatives: [],
      cold_start: true,
      cold_start_hint: `No data indexed for ${repo}. Run: git-wik index ${repo}`,
    };
  }

  const lastIndexed = new Date(syncRow.last_fetched_at * 1000).toISOString();

  // ── Hybrid traversal via new context engine ────────────────────────────────
  const seed = detectSeed(query);
  const traversal = traverseFromSeed(db, repo, seed, { maxPRs: maxPRs * 2, maxIssues: 5 });

  const topPRs = traversal.prs.slice(0, maxPRs);

  // ── Build relevant_prs ────────────────────────────────────────────────────
  const relevant_prs: RelevantPR[] = topPRs.map(({ pr, score }) => {
    const fileEdges = getEdgesFrom(db, "pr", pr.id, "TOUCHES");
    const files_changed = fileEdges
      .map((e) => e.to_id.replace(`${repo}::`, ""))
      .slice(0, 5);
    const approach = extractApproach(pr.body_summary);
    return {
      number: pr.number,
      title: pr.title,
      outcome: pr.outcome,
      files_changed,
      approach,
      why_relevant: `score: ${score.toFixed(2)}`,
    };
  });

  // ── Build relevant_files from co-change data ──────────────────────────────
  const relevant_files: RelevantFile[] = traversal.files.slice(0, maxFiles).map((f) => ({
    path: f.path,
    pr_count: 0,
    co_changes: [],
  }));

  // ── Gather decisions, constraints, rejected alts from top PRs ─────────────
  const design_decisions: DesignDecision[] = [];
  const constraints = new Set<string>();
  const rejected_alternatives: Array<{ option: string; reason: string | null }> = [];
  const decisionSeen = new Set<string>();

  for (const { pr } of topPRs) {
    const decEdges = getEdgesFrom(db, "pr", pr.id, "PRODUCED");
    for (const de of decEdges) {
      if (decisionSeen.has(de.to_id)) continue;
      const d = getDecision(db, de.to_id);
      if (d && d.confidence >= 0.4) {
        decisionSeen.add(d.id);
        design_decisions.push({
          problem:    truncateAt(d.problem, 120),
          choice:     truncateAt(d.choice, 150),
          rationale:  d.rationale ? truncateAt(d.rationale, 150) : null,
          confidence: d.confidence,
        });
      }
    }

    const cEdges = getEdgesFrom(db, "pr", pr.id, "REQUIRES");
    for (const ce of cEdges) {
      const c = getConstraint(db, ce.to_id);
      if (c) constraints.add(truncateAt(c.text, 100));
    }

    const rEdges = getEdgesFrom(db, "pr", pr.id, "REJECTS");
    for (const re of rEdges) {
      const ra = db
        .prepare("SELECT * FROM rejected_alternatives WHERE id=?")
        .get(re.to_id) as { option_text: string; rejection_reason: string | null } | undefined;
      if (ra) {
        rejected_alternatives.push({
          option: truncateAt(ra.option_text, 100),
          reason: ra.rejection_reason ? truncateAt(ra.rejection_reason, 100) : null,
        });
      }
    }

    const inlineData = parseInlineEnrichment(pr.body_summary);
    if (inlineData) {
      if (inlineData.choice && !design_decisions.some((d) => d.choice === inlineData.choice)) {
        design_decisions.push({
          problem:    inlineData.problem ? truncateAt(inlineData.problem, 120) : "Not specified",
          choice:     truncateAt(inlineData.choice, 150),
          rationale:  inlineData.rationale ? truncateAt(inlineData.rationale, 150) : null,
          confidence: inlineData.confidence ?? 0.5,
        });
      }
      for (const c of inlineData.constraints ?? []) {
        constraints.add(truncateAt(c, 100));
      }
      for (const r of inlineData.rejected ?? []) {
        if (r.option) {
          rejected_alternatives.push({
            option: truncateAt(r.option, 100),
            reason: r.reason ? truncateAt(r.reason, 100) : null,
          });
        }
      }
    }
  }

  return {
    query,
    repo,
    last_indexed: lastIndexed,
    relevant_prs,
    relevant_files,
    design_decisions: design_decisions.slice(0, 5),
    constraints: [...constraints].slice(0, 5),
    rejected_alternatives: rejected_alternatives.slice(0, 4),
    cold_start: false,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Extract the "approach" (choice_made) from an inline-enriched body_summary. */
function extractApproach(bodySummary: string | null): string | null {
  const data = parseInlineEnrichment(bodySummary);
  return data?.choice ? truncateAt(data.choice, 150) : null;
}

/** Parse the JSON stored in body_summary by the Phase 2 inline enrichment path. */
function parseInlineEnrichment(bodySummary: string | null): {
  problem?: string | null;
  choice?: string | null;
  rationale?: string | null;
  confidence?: number;
  constraints?: string[];
  rejected?: Array<{ option: string; reason?: string | null }>;
} | null {
  if (!bodySummary?.startsWith("{")) return null;
  try {
    return JSON.parse(bodySummary) as ReturnType<typeof parseInlineEnrichment>;
  } catch {
    return null;
  }
}
