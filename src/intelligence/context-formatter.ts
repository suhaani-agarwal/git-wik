import type Database from "better-sqlite3";
import { getEdgesFrom, getEdgesTo, getDecision, getConstraint } from "../graph/db.js";
import type { PRNode, IssueNode, DecisionNode } from "../graph/db.js";
import { estimateTokens, truncateAt } from "../shared/token-budget.js";
import type { TraversalResult, ScoredPR, ScoredIssue, ScoredFile } from "./context.js";

const HEADER_TOKEN_RESERVE = 30;

// ── Review outcome helper ──────────────────────────────────────────────────────

interface ReviewerOutcome {
  username: string;
  states: string[];
}

function getReviewerOutcomes(
  db: Database.Database,
  prId: string,
  repo: string
): ReviewerOutcome[] {
  const edges = getEdgesFrom(db, "pr", prId, "REVIEWED_BY");
  return edges.map((e) => {
    const username = e.to_id.replace(`${repo}::`, "");
    let states: string[] = [];
    try {
      const meta = e.metadata_json ? JSON.parse(e.metadata_json) as { states?: string[] } : null;
      states = meta?.states ?? [];
    } catch { /* ignore */ }
    return { username, states };
  });
}

function formatReviewLine(reviewers: ReviewerOutcome[]): string {
  if (reviewers.length === 0) return "";
  return reviewers.map((r) => {
    if (r.states.length === 0) return `@${r.username}`;
    return `@${r.username} ${r.states.join("→")}`;
  }).join(" | ");
}

// ── Inferred decision helper ───────────────────────────────────────────────────

interface InferredItem {
  label: string;
  text: string;
  confidence: number;
}

function getInferredItems(
  db: Database.Database,
  prId: string
): { items: InferredItem[]; omittedCount: number } {
  const decEdges = getEdgesFrom(db, "pr", prId, "PRODUCED");
  const items: InferredItem[] = [];
  let omittedCount = 0;

  for (const de of decEdges) {
    const d = getDecision(db, de.to_id);
    if (!d) continue;

    const hasEvidence = d.rationale !== null && d.rationale.trim() !== "";
    if (d.confidence >= 0.7 && hasEvidence) {
      items.push({ label: "WHY", text: truncateAt(d.rationale!, 120), confidence: d.confidence });
      if (d.choice) {
        items.push({ label: "CHOICE", text: truncateAt(d.choice, 100), confidence: d.confidence });
      }
    } else if (d.confidence >= 0.4) {
      omittedCount++;
    }
  }

  // Also check inline enrichment in body_summary JSON
  const pr = db.prepare("SELECT body_summary FROM pull_requests WHERE id=?").get(prId) as { body_summary: string | null } | undefined;
  if (pr?.body_summary?.startsWith("{")) {
    try {
      const parsed = JSON.parse(pr.body_summary) as {
        rationale?: string | null;
        choice?: string | null;
        confidence?: number;
      };
      if (parsed.confidence != null && parsed.confidence >= 0.7 && parsed.rationale) {
        const alreadyHave = items.some((i) => i.label === "WHY");
        if (!alreadyHave) {
          items.push({ label: "WHY", text: truncateAt(parsed.rationale, 120), confidence: parsed.confidence });
        }
      } else if (parsed.confidence != null && parsed.confidence >= 0.4) {
        omittedCount++;
      }
    } catch { /* ignore */ }
  }

  return { items, omittedCount };
}

// ── Rejected alternatives helper ───────────────────────────────────────────────

function getRejectedAlts(
  db: Database.Database,
  prId: string
): Array<{ option: string; reason: string | null }> {
  const rEdges = getEdgesFrom(db, "pr", prId, "REJECTS");
  const alts: Array<{ option: string; reason: string | null }> = [];
  for (const re of rEdges) {
    const ra = db.prepare("SELECT option_text, rejection_reason FROM rejected_alternatives WHERE id=?").get(re.to_id) as { option_text: string; rejection_reason: string | null } | undefined;
    if (ra) alts.push({ option: truncateAt(ra.option_text, 80), reason: ra.rejection_reason ? truncateAt(ra.rejection_reason, 80) : null });
  }
  return alts.slice(0, 2);
}

// ── PR line formatter ──────────────────────────────────────────────────────────

function formatPRBlock(
  db: Database.Database,
  repo: string,
  sp: ScoredPR,
  tokenBudget: number
): { text: string; omittedInferred: number } {
  const { pr } = sp;
  const mergeDate = pr.merged_at
    ? new Date(pr.merged_at * 1000).toISOString().slice(0, 7)
    : null;
  const outcomeStr = mergeDate ? `merged ${mergeDate}` : (pr.outcome ?? pr.state.toLowerCase());

  const lines: string[] = [];
  lines.push(`• PR#${pr.number} "${truncateAt(pr.title, 80)}" [${outcomeStr}]`);

  // Files touched
  const fileEdges = getEdgesFrom(db, "pr", pr.id, "TOUCHES");
  if (fileEdges.length > 0) {
    const filePaths = fileEdges.map((e) => e.to_id.replace(`${repo}::`, "")).slice(0, 4);
    lines.push(`  Files: ${filePaths.join(", ")}`);
  }

  // Fixes
  const fixEdges = getEdgesFrom(db, "pr", pr.id, "FIXES");
  if (fixEdges.length > 0) {
    const nums = fixEdges.map((e) => e.to_id.replace(`${repo}#`, "#")).slice(0, 3);
    lines.push(`  Fixes: ${nums.join(", ")}`);
  }

  // Review outcomes
  const reviewers = getReviewerOutcomes(db, pr.id, repo);
  const reviewLine = formatReviewLine(reviewers);
  if (reviewLine) lines.push(`  Review: ${reviewLine}`);

  // Inferred items (only if budget allows)
  const baseTokens = estimateTokens(lines.join("\n"));
  const remainingBudget = tokenBudget - baseTokens;
  const { items, omittedCount } = getInferredItems(db, pr.id);
  let omittedInferred = omittedCount;

  if (remainingBudget > 20) {
    for (const item of items) {
      const line = `  [inferred:${item.confidence.toFixed(2)}] ${item.label}: ${item.text}`;
      if (estimateTokens(line) < remainingBudget) {
        lines.push(line);
      } else {
        omittedInferred++;
      }
    }
  } else {
    omittedInferred += items.length;
  }

  // Rejected alternatives
  const rejectedAlts = getRejectedAlts(db, pr.id);
  for (const r of rejectedAlts) {
    const line = `  REJECTS: ${r.option}${r.reason ? ` — ${r.reason}` : ""}`;
    lines.push(line);
  }

  return { text: lines.join("\n"), omittedInferred };
}

// ── Issue line formatter ───────────────────────────────────────────────────────

function formatIssueBlock(issue: IssueNode, repo: string): string {
  const stateStr = issue.state === "OPEN" ? "open" : "closed";
  return `• #${issue.number} "${truncateAt(issue.title, 80)}" [${stateStr}]`;
}

// ── File line formatter ────────────────────────────────────────────────────────

function formatFileBlock(f: ScoredFile): string {
  return `• ${f.path} (${f.coChangeCount}×)`;
}

// ── Main formatter ─────────────────────────────────────────────────────────────

export function formatContextPackage(
  result: TraversalResult,
  db: Database.Database,
  query: string,
  repo: string,
  tokenBudget = 700
): string {
  const effectiveBudget = tokenBudget - HEADER_TOKEN_RESERVE;

  const headerLines = [
    `# Context: ${result.seedType === "keyword" ? `"${query}"` : query}  ·  ${repo}`,
  ];
  if (result.seedFellBack) {
    headerLines.push(`*(seed not found in index — searched as keyword)*`);
  }
  headerLines.push("");

  let usedTokens = estimateTokens(headerLines.join("\n"));
  const sections: string[] = [...headerLines];

  let totalOmittedInferred = 0;

  // ── PRs section ──
  const openPRs  = result.prs.filter((sp) => sp.pr.state === "OPEN");
  const otherPRs = result.prs.filter((sp) => sp.pr.state !== "OPEN");
  const allPRsSorted = [...otherPRs, ...openPRs]; // merged first (more useful), then open

  if (allPRsSorted.length > 0) {
    const sectionHeader = `## PRs (${allPRsSorted.length} matched)\n`;
    usedTokens += estimateTokens(sectionHeader);
    sections.push(sectionHeader);

    for (const sp of allPRsSorted) {
      const remaining = effectiveBudget - usedTokens;
      if (remaining < 15) break;
      const { text, omittedInferred } = formatPRBlock(db, repo, sp, Math.min(remaining, 80));
      totalOmittedInferred += omittedInferred;
      const cost = estimateTokens(text);
      if (usedTokens + cost > effectiveBudget) break;
      sections.push(text);
      usedTokens += cost;
    }
    sections.push("");
    usedTokens += 1;
  }

  // ── Open issues section ──
  const openIssues   = result.issues.filter((si) => si.issue.state === "OPEN");
  const closedIssues = result.issues.filter((si) => si.issue.state !== "OPEN");

  if (openIssues.length > 0 && usedTokens < effectiveBudget) {
    const sectionHeader = `## Open Issues (${openIssues.length} related)\n`;
    usedTokens += estimateTokens(sectionHeader);
    sections.push(sectionHeader);
    for (const si of openIssues) {
      const line = formatIssueBlock(si.issue, repo);
      const cost = estimateTokens(line);
      if (usedTokens + cost > effectiveBudget) break;
      sections.push(line);
      usedTokens += cost;
    }
    sections.push("");
    usedTokens += 1;
  }

  // ── Closed issues section ──
  if (closedIssues.length > 0 && usedTokens < effectiveBudget) {
    const sectionHeader = `## Closed Issues\n`;
    usedTokens += estimateTokens(sectionHeader);
    sections.push(sectionHeader);
    for (const si of closedIssues) {
      const line = formatIssueBlock(si.issue, repo);
      const cost = estimateTokens(line);
      if (usedTokens + cost > effectiveBudget) break;
      sections.push(line);
      usedTokens += cost;
    }
    sections.push("");
    usedTokens += 1;
  }

  // ── Co-changed files section ──
  if (result.files.length > 0 && usedTokens < effectiveBudget) {
    const sectionHeader = `## Co-Changed Files (top ${result.files.length})\n`;
    usedTokens += estimateTokens(sectionHeader);
    sections.push(sectionHeader);
    for (const f of result.files) {
      const line = formatFileBlock(f);
      const cost = estimateTokens(line);
      if (usedTokens + cost > effectiveBudget) break;
      sections.push(line);
      usedTokens += cost;
    }
    sections.push("");
  }

  // ── Footer ──
  if (totalOmittedInferred > 0) {
    sections.push(`*${totalOmittedInferred} inferred item${totalOmittedInferred > 1 ? "s" : ""} omitted (low evidence)*`);
  }

  if (result.prs.length === 0 && result.issues.length === 0) {
    sections.push("*No matching context found. Try running `git-wik enrich <repo>` to add LLM-extracted decisions, or `git-wik index <repo>` if not indexed.*");
  }

  return sections.join("\n");
}
