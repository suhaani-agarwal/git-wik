import {
  getDb,
  isStale,
  markFetched,
  upsertIssue,
  upsertPR,
  upsertFile,
  upsertContributor,
  upsertEdge,
  upsertLabel,
  upsertMilestone,
  upsertNodeKeywords,
  rebuildFts,
} from "../graph/db.js";
import type { IndexStats } from "../graph/db.js";
import {
  fetchIssueWithComments,
  fetchPRWithDetails,
  fetchIssueTimeline,
  fetchAllIssues,
  fetchAllPRs,
  fetchPRCommits,
  fetchLabels,
  fetchMilestones,
} from "./gh.js";
import type { GhPRRaw, GhLabel, GhMilestone } from "./gh.js";
import {
  parseIssueRelationships,
  extractReferencedPRNumbers,
  parsePRFiles,
  parsePRReviewers,
  parsePROutcome,
  buildThreadText,
  buildPRThreadText,
  parsePRRelationships,
  parseCommitIssueRefs,
  parseMentions,
} from "./parse.js";
import { extractThread } from "../extract/extract.js";
import type { ProviderName } from "../extract/extract.js";
import { extractKeywords } from "../shared/keywords.js";

// ── TTLs ───────────────────────────────────────────────────────────────────────

const ISSUE_TTL    = 2 * 60 * 60;   // 2 hours
const PR_TTL       = 2 * 60 * 60;   // 2 hours
const INDEX_TTL    = 24 * 60 * 60;  // 24 hours
const LABELS_TTL   = 12 * 60 * 60;  // 12 hours

// ── Enrichment guard ───────────────────────────────────────────────────────────

/**
 * Only enrich PRs that are likely to have real decision content:
 * - Merged (not abandoned/rejected)
 * - Touched ≥3 files OR has CHANGES_REQUESTED review OR body > 200 chars
 */
export function shouldEnrich(pr: GhPRRaw): boolean {
  if ((pr.mergedAt == null) && pr.state !== "MERGED") return false;
  const hasSubstantialBody = (pr.body?.length ?? 0) > 200;
  const hasReviewDiscussion = pr.reviews?.some(
    (r) => r.state === "CHANGES_REQUESTED" || r.state === "COMMENTED"
  ) ?? false;
  const touchesManyFiles = (pr.files?.length ?? 0) >= 3;
  return touchesManyFiles || hasReviewDiscussion || hasSubstantialBody;
}

// ── Helper: upsert label nodes + HAS_LABEL edges ───────────────────────────────

function upsertLabelsForNode(
  db: ReturnType<typeof getDb>,
  repo: string,
  nodeType: string,
  nodeId: string,
  labels: GhLabel[] | undefined
): void {
  for (const label of labels ?? []) {
    const labelId = `${repo}::${label.name}`;
    upsertLabel(db, { id: labelId, repo, name: label.name, color: label.color });
    upsertEdge(db, {
      from_type: nodeType, from_id: nodeId,
      edge_type: "HAS_LABEL",
      to_type: "label", to_id: labelId,
      weight: 1, metadata_json: null,
    });
  }
}

function upsertMilestoneForNode(
  db: ReturnType<typeof getDb>,
  repo: string,
  nodeType: string,
  nodeId: string,
  milestone: GhMilestone | null | undefined
): void {
  if (!milestone) return;
  const msId = `${repo}::milestone::${milestone.number}`;
  upsertMilestone(db, {
    id: msId, repo,
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
  });
  upsertEdge(db, {
    from_type: nodeType, from_id: nodeId,
    edge_type: "IN_MILESTONE",
    to_type: "milestone", to_id: msId,
    weight: 1, metadata_json: null,
  });
}

// ── Single-issue population ────────────────────────────────────────────────────

export async function populateFromIssue(
  repo: string,
  issueNumber: number,
  opts: { provider?: ProviderName; token?: string } = {}
): Promise<void> {
  const db = getDb(repo);
  const resourceType = `issue:${issueNumber}`;

  if (!isStale(db, repo, resourceType, ISSUE_TTL)) return;

  const [issue, timeline] = await Promise.all([
    fetchIssueWithComments(repo, issueNumber),
    fetchIssueTimeline(repo, issueNumber),
  ]);

  const issueId = `${repo}#${issue.number}`;
  const threadText = buildThreadText(issue);

  upsertIssue(db, {
    id: issueId,
    repo,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body_summary: (issue.body ?? "").slice(0, 500) || null,
    created_at: issue.createdAt
      ? Math.floor(new Date(issue.createdAt).getTime() / 1000)
      : null,
    closed_at: issue.closedAt
      ? Math.floor(new Date(issue.closedAt).getTime() / 1000)
      : null,
    fetched_at: Math.floor(Date.now() / 1000),
    raw_json: threadText,
  });

  // Keywords for FTS
  const issueKeywords = extractKeywords(
    issue.title,
    (issue.labels ?? []).map((l) => l.name),
    (issue.body ?? "").slice(0, 500)
  );
  upsertNodeKeywords(db, issueId, "issue", issueKeywords);

  // Labels + milestone
  upsertLabelsForNode(db, repo, "issue", issueId, issue.labels);
  upsertMilestoneForNode(db, repo, "issue", issueId, issue.milestone);

  // Author
  if (issue.author?.login) {
    const contribId = `${repo}::${issue.author.login}`;
    upsertContributor(db, { id: contribId, repo, username: issue.author.login, display_name: null });
    upsertEdge(db, { from_type: "issue", from_id: issueId, edge_type: "AUTHORED_BY", to_type: "contributor", to_id: contribId, weight: 1, metadata_json: null });
  }

  // Comment authors
  for (const comment of issue.comments ?? []) {
    if (comment.author?.login && !comment.author.login.endsWith("[bot]")) {
      const contribId = `${repo}::${comment.author.login}`;
      upsertContributor(db, { id: contribId, repo, username: comment.author.login, display_name: null });
      upsertEdge(db, { from_type: "issue", from_id: issueId, edge_type: "COMMENTED_BY", to_type: "contributor", to_id: contribId, weight: 1, metadata_json: null });
    }
  }

  // Cross-reference edges from body + all comment bodies
  const allIssueText = [issue.body ?? "", ...(issue.comments ?? []).map((c) => c.body ?? "")].join("\n");
  for (const mention of parseMentions(allIssueText, issueId, "issue")) {
    const toId = `${repo}#${mention.to_number}`;
    upsertEdge(db, { from_type: "issue", from_id: issueId, edge_type: mention.edge_type, to_type: "issue", to_id: toId, weight: 1, metadata_json: null });
  }

  // Discover related PRs
  const { fixes: bodyFixedPRs } = parseIssueRelationships(issue.body ?? "");
  const timelinePRNums = extractReferencedPRNumbers(timeline);
  const allPRNums = [...new Set([...bodyFixedPRs, ...timelinePRNums])].slice(0, 5);

  const prResults = await Promise.all(
    allPRNums.map((num) => fetchPRWithDetails(repo, num))
  );

  for (const pr of prResults) {
    if (!pr) continue;
    await _upsertPR(db, repo, pr, issueId, opts.provider);
  }

  markFetched(db, repo, resourceType);
}

// ── Single-PR population ───────────────────────────────────────────────────────

export async function populateFromPR(
  repo: string,
  prNumber: number,
  opts: { provider?: ProviderName } = {}
): Promise<void> {
  const db = getDb(repo);
  const resourceType = `pr:${prNumber}`;

  if (!isStale(db, repo, resourceType, PR_TTL)) return;

  const pr = await fetchPRWithDetails(repo, prNumber);
  if (!pr) return;

  await _upsertPR(db, repo, pr, null, opts.provider);
  markFetched(db, repo, resourceType);
}

// ── Shared PR upsert (used by both populateFromIssue and populateFromPR) ───────

async function _upsertPR(
  db: ReturnType<typeof getDb>,
  repo: string,
  pr: GhPRRaw,
  fixesIssueId: string | null,
  provider?: ProviderName
): Promise<void> {
  const prId = `${repo}#pr#${pr.number}`;
  const outcome = parsePROutcome(pr);
  const prThreadText = buildPRThreadText(pr);

  upsertPR(db, {
    id: prId,
    repo,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    outcome,
    body_summary: (pr.body ?? "").slice(0, 500) || null,
    merged_at: pr.mergedAt ? Math.floor(new Date(pr.mergedAt).getTime() / 1000) : null,
    closed_at: pr.closedAt ? Math.floor(new Date(pr.closedAt).getTime() / 1000) : null,
    fetched_at: Math.floor(Date.now() / 1000),
    raw_json: prThreadText,
  });

  // Keywords for FTS
  const prKeywords = extractKeywords(
    pr.title,
    (pr.labels ?? []).map((l) => l.name),
    (pr.body ?? "").slice(0, 500)
  );
  upsertNodeKeywords(db, prId, "pr", prKeywords);

  // Labels + milestone
  upsertLabelsForNode(db, repo, "pr", prId, pr.labels);
  upsertMilestoneForNode(db, repo, "pr", prId, pr.milestone);

  // FIXES edge back to issue
  if (fixesIssueId) {
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "FIXES", to_type: "issue", to_id: fixesIssueId, weight: 1, metadata_json: null });
  }

  // Also parse FIXES from the PR body itself
  const { fixes: bodyFixes } = parseIssueRelationships(pr.body ?? "");
  for (const issueNum of bodyFixes) {
    const iId = `${repo}#${issueNum}`;
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "FIXES", to_type: "issue", to_id: iId, weight: 1, metadata_json: null });
  }

  // Cross-reference edges from PR body
  for (const mention of parseMentions(pr.body ?? "", prId, "pr")) {
    // Route to issue or PR based on whether "pr#N" pattern was used — default to issue
    const toId = `${repo}#${mention.to_number}`;
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: mention.edge_type, to_type: "issue", to_id: toId, weight: 1, metadata_json: null });
  }

  // PR→PR relationship edges (depends on, supersedes)
  const prRels = parsePRRelationships(pr.body ?? "");
  for (const depNum of prRels.dependsOn) {
    const depId = `${repo}#pr#${depNum}`;
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "DEPENDS_ON", to_type: "pr", to_id: depId, weight: 1, metadata_json: null });
  }
  for (const supNum of prRels.supersedes) {
    const supId = `${repo}#pr#${supNum}`;
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "SUPERSEDES", to_type: "pr", to_id: supId, weight: 1, metadata_json: null });
  }

  // Commit→issue links
  const commits = await fetchPRCommits(repo, pr.number);
  for (const commit of commits) {
    const { fixes } = parseCommitIssueRefs(commit.commit.message);
    for (const issueNum of fixes) {
      const iId = `${repo}#${issueNum}`;
      upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "FIXES", to_type: "issue", to_id: iId, weight: 1, metadata_json: null });
    }
  }

  // Files touched
  for (const filePath of parsePRFiles(pr)) {
    const fileId = `${repo}::${filePath}`;
    upsertFile(db, { id: fileId, repo, path: filePath, last_seen_at: Math.floor(Date.now() / 1000) });
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "TOUCHES", to_type: "file", to_id: fileId, weight: 1, metadata_json: null });
  }

  // Author
  if (pr.author?.login) {
    const contribId = `${repo}::${pr.author.login}`;
    upsertContributor(db, { id: contribId, repo, username: pr.author.login, display_name: null });
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "AUTHORED_BY", to_type: "contributor", to_id: contribId, weight: 1, metadata_json: null });
  }

  // Reviewers
  for (const login of parsePRReviewers(pr)) {
    const contribId = `${repo}::${login}`;
    upsertContributor(db, { id: contribId, repo, username: login, display_name: null });
    upsertEdge(db, { from_type: "pr", from_id: prId, edge_type: "REVIEWED_BY", to_type: "contributor", to_id: contribId, weight: 1, metadata_json: null });
  }

  // LLM enrichment (opt-in, gated on API key + quality signal)
  if (shouldEnrich(pr)) {
    const result = await extractThread(prThreadText, provider ?? "auto");
    if (result.confidence >= 0.4) {
      // Store extracted decision data in the PR's body_summary for now
      // Full decision nodes will be added in Phase 3 with upsertDecision
      // For now, append a structured summary to raw_json for the MCP to surface
      const enriched = JSON.stringify({
        problem: result.problem_statement,
        choice: result.choice_made,
        rationale: result.rationale,
        confidence: result.confidence,
        constraints: result.constraints,
        rejected: result.rejected_alternatives,
      });
      db.prepare(
        "UPDATE pull_requests SET body_summary=? WHERE id=?"
      ).run(enriched.slice(0, 500), prId);
    }
  }
}

// ── Bulk repo index population ─────────────────────────────────────────────────

export interface PopulateRepoOptions {
  since?: Date;
  limit?: number;
  provider?: ProviderName;
  onProgress?: (phase: string, done: number, total: number) => void;
}

/**
 * Bulk-index a repo's issue and PR stubs (no full threads).
 * Fast: only fetches list metadata, enough for FTS indexing and graph stubs.
 * Full threads are fetched on-demand when specific issues/PRs are queried.
 *
 * TTL: 24 hours. Use `since` for incremental updates.
 */
export async function populateRepoIndex(
  repo: string,
  opts: PopulateRepoOptions = {}
): Promise<IndexStats & { issueCount: number; prCount: number }> {
  const db = getDb(repo);
  const now = Math.floor(Date.now() / 1000);

  const limit = opts.limit ?? 500;
  const report = opts.onProgress ?? (() => {});

  // 1. Issues
  report("Fetching issue list…", 0, 0);
  const issues = await fetchAllIssues(repo, { since: opts.since, limit });
  report("Fetching issue list…", issues.length, issues.length);

  for (const issue of issues) {
    const issueId = `${repo}#${issue.number}`;
    upsertIssue(db, {
      id: issueId, repo, number: issue.number,
      title: issue.title, state: issue.state,
      body_summary: null,
      created_at: issue.createdAt ? Math.floor(new Date(issue.createdAt).getTime() / 1000) : null,
      closed_at: issue.closedAt ? Math.floor(new Date(issue.closedAt).getTime() / 1000) : null,
      fetched_at: now, raw_json: null,
    });

    const kw = extractKeywords(issue.title, (issue.labels ?? []).map((l) => l.name), "");
    upsertNodeKeywords(db, issueId, "issue", kw);
    upsertLabelsForNode(db, repo, "issue", issueId, issue.labels);
    upsertMilestoneForNode(db, repo, "issue", issueId, issue.milestone);
  }

  // 2. PRs
  report("Fetching PR list…", 0, 0);
  const prs = await fetchAllPRs(repo, { since: opts.since, limit });
  report("Fetching PR list…", prs.length, prs.length);

  for (const pr of prs) {
    const prId = `${repo}#pr#${pr.number}`;
    const outcome = pr.mergedAt ? "merged" : pr.state === "OPEN" ? "open" : "abandoned";
    upsertPR(db, {
      id: prId, repo, number: pr.number,
      title: pr.title, state: pr.state, outcome,
      body_summary: null,
      merged_at: pr.mergedAt ? Math.floor(new Date(pr.mergedAt).getTime() / 1000) : null,
      closed_at: null,
      fetched_at: now, raw_json: null,
    });

    const kw = extractKeywords(pr.title, (pr.labels ?? []).map((l) => l.name), "");
    upsertNodeKeywords(db, prId, "pr", kw);
    upsertLabelsForNode(db, repo, "pr", prId, pr.labels);
    upsertMilestoneForNode(db, repo, "pr", prId, pr.milestone);
  }

  // 3. Labels + milestones (repo-level)
  if (isStale(db, repo, "repo:labels", LABELS_TTL)) {
    const labels = await fetchLabels(repo);
    for (const l of labels) {
      upsertLabel(db, { id: `${repo}::${l.name}`, repo, name: l.name, color: l.color });
    }
    const milestones = await fetchMilestones(repo);
    for (const m of milestones) {
      upsertMilestone(db, { id: `${repo}::milestone::${m.number}`, repo, number: m.number, title: m.title, state: m.state });
    }
    markFetched(db, repo, "repo:labels");
  }

  // 4. Rebuild FTS after bulk inserts (faster than per-row triggers)
  report("Rebuilding search index…", 0, 0);
  rebuildFts(db);

  markFetched(db, repo, "repo:index");

  const { getIndexStats } = await import("../graph/db.js");
  const stats = getIndexStats(db);
  return { ...stats, issueCount: issues.length, prCount: prs.length };
}
