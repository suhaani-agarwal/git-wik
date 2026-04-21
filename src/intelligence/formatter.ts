import { formatWithBudget } from "../shared/token-budget.js";
import type { IssueIntelligence } from "./issue.js";
import type { FileLore } from "./file-lore.js";
import type { ImplementationContext } from "./implementation-context.js";
import type { FtsResult } from "../graph/fts.js";

// ── Issue intelligence ────────────────────────────────────────────────────────

export function formatIssueIntelligence(
  intel: IssueIntelligence,
  depth: "brief" | "full" = "brief"
): string {
  const { repo, issue, related_prs, contributors } = intel;
  const lines: string[] = [];

  lines.push(`# ${repo}#${issue.number}: ${issue.title}`);
  lines.push(`**State:** ${issue.state} | **Contributors:** ${contributors.join(", ") || "none"}`);
  lines.push("");

  if (issue.body_summary) {
    lines.push("## Description");
    lines.push(issue.body_summary);
    lines.push("");
  }

  if (related_prs.length > 0) {
    lines.push(`## Related PRs (${related_prs.length})`);
    for (const pr of related_prs) {
      const outcome = pr.outcome ? ` [${pr.outcome}]` : "";
      const author = pr.author ? ` by @${pr.author}` : "";
      const reviewers =
        pr.reviewers.length
          ? ` · reviewed by ${pr.reviewers.map((r) => `@${r}`).join(", ")}`
          : "";
      lines.push(`### PR #${pr.number}${outcome}${author}${reviewers}`);
      lines.push(`**Title:** ${pr.title}`);
      if (pr.files_touched.length > 0) {
        lines.push(`**Files:** ${pr.files_touched.join(", ")}`);
      }
      if (depth === "full" && pr.thread) {
        lines.push("");
        lines.push("**Discussion:**");
        lines.push(pr.thread);
      }
      lines.push("");
    }
  } else {
    lines.push("## Related PRs");
    lines.push(
      "No related PRs found in graph. The issue may not have linked PRs, or they haven't been indexed yet."
    );
    lines.push("");
  }

  if (depth === "full" && issue.thread) {
    lines.push("## Issue Thread");
    lines.push(issue.thread);
  }

  const content = lines.join("\n");
  return depth === "brief" ? formatWithBudget(content, 300) : formatWithBudget(content, 1200);
}

// ── File lore ─────────────────────────────────────────────────────────────────

export function formatFileLore(lore: FileLore): string {
  const lines: string[] = [];

  lines.push(`# File: ${lore.path}`);
  lines.push("");

  if (lore.prs.length > 0) {
    lines.push(`## PRs that touched this file (${lore.prs.length})`);
    for (const pr of lore.prs) {
      lines.push(`- PR #${pr.number} [${pr.outcome ?? "unknown"}]: ${pr.title}`);
    }
    lines.push("");
  }

  if (lore.co_changes.length > 0) {
    lines.push("## Files frequently changed together");
    for (const c of lore.co_changes) {
      lines.push(`- ${c.path} (${c.count}x)`);
    }
    lines.push("");
  }

  if (lore.decisions.length > 0) {
    lines.push("## Decisions extracted from related PRs");
    for (const d of lore.decisions) {
      lines.push(`**Problem:** ${d.problem}`);
      lines.push(`**Choice:** ${d.choice}`);
      if (d.rationale) lines.push(`**Why:** ${d.rationale}`);
      lines.push(`*(confidence: ${d.confidence})*`);
      lines.push("");
    }
  }

  if (lore.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of lore.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  return formatWithBudget(lines.join("\n"), 500);
}

// ── Implementation context ────────────────────────────────────────────────────

export function formatImplementationContext(ctx: ImplementationContext): string {
  if (ctx.cold_start) {
    return [
      `# Implementation Context: "${ctx.query}"`,
      "",
      `**No data indexed for \`${ctx.repo}\`.**`,
      "",
      ctx.cold_start_hint ?? `Run: \`git-wik index ${ctx.repo}\``,
    ].join("\n");
  }

  const lines: string[] = [];
  const age = ctx.last_indexed ? relativeAge(ctx.last_indexed) : "never";

  lines.push(`# Implementation Context: "${ctx.query}"`);
  lines.push(`*${ctx.repo} · last indexed ${age}*`);
  lines.push("");

  // ── Relevant PRs ──────────────────────────────────────────────────────────
  if (ctx.relevant_prs.length > 0) {
    lines.push("## Relevant PRs");
    for (const pr of ctx.relevant_prs) {
      const outcome = pr.outcome ? ` [${pr.outcome}]` : "";
      lines.push(`- **PR #${pr.number}**${outcome}: ${pr.title}`);
      if (pr.files_changed.length > 0) {
        lines.push(`  Files: ${pr.files_changed.join(", ")}`);
      }
      if (pr.approach) {
        lines.push(`  Approach: ${pr.approach}`);
      }
      lines.push(`  *(${pr.why_relevant})*`);
    }
    lines.push("");
  }

  // ── Design decisions ──────────────────────────────────────────────────────
  if (ctx.design_decisions.length > 0) {
    lines.push("## Design Decisions");
    for (const d of ctx.design_decisions) {
      lines.push(`- **Problem:** ${d.problem}`);
      lines.push(`  **Choice:** ${d.choice}`);
      if (d.rationale) lines.push(`  **Why:** ${d.rationale}`);
      lines.push(`  *(confidence: ${d.confidence.toFixed(2)})*`);
    }
    lines.push("");
  }

  // ── Constraints ───────────────────────────────────────────────────────────
  if (ctx.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of ctx.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  // ── Rejected alternatives ─────────────────────────────────────────────────
  if (ctx.rejected_alternatives.length > 0) {
    lines.push("## Rejected Approaches");
    for (const r of ctx.rejected_alternatives) {
      lines.push(`- **${r.option}**${r.reason ? `: ${r.reason}` : ""}`);
    }
    lines.push("");
  }

  // ── Relevant files ────────────────────────────────────────────────────────
  if (ctx.relevant_files.length > 0) {
    lines.push("## Relevant Files");
    for (const f of ctx.relevant_files) {
      const coStr =
        f.co_changes.length > 0
          ? ` · co-changes: ${f.co_changes.join(", ")}`
          : "";
      lines.push(`- \`${f.path}\` (${f.pr_count} PRs)${coStr}`);
    }
    lines.push("");
  }

  if (
    ctx.relevant_prs.length === 0 &&
    ctx.design_decisions.length === 0 &&
    ctx.relevant_files.length === 0
  ) {
    lines.push("*No matching context found. Try running `git-wik enrich` to add LLM-extracted decisions.*");
    lines.push("");
  }

  return formatWithBudget(lines.join("\n"), 700);
}

// ── Similar results ───────────────────────────────────────────────────────────

export function formatSimilarResults(
  repo: string,
  query: string,
  results: FtsResult[]
): string {
  const lines: string[] = [];
  lines.push(`# Similar to: "${query}"`);
  lines.push(`*${repo}*`);
  lines.push("");

  if (results.length === 0) {
    lines.push("*No similar issues or PRs found.*");
    return lines.join("\n");
  }

  const issues = results.filter((r) => r.type === "issue");
  const prs = results.filter((r) => r.type === "pr");

  if (issues.length > 0) {
    lines.push("## Similar Issues");
    for (const r of issues) {
      const state = "state" in r ? ` [${r.state}]` : "";
      lines.push(`- Issue #${r.number}${state}: ${r.title}`);
    }
    lines.push("");
  }

  if (prs.length > 0) {
    lines.push("## Similar PRs");
    for (const r of prs) {
      const outcome = "outcome" in r && r.outcome ? ` [${r.outcome}]` : "";
      lines.push(`- PR #${r.number}${outcome}: ${r.title}`);
    }
    lines.push("");
  }

  return formatWithBudget(lines.join("\n"), 400);
}

// ── PR context ────────────────────────────────────────────────────────────────

export interface PRContextData {
  repo: string;
  number: number;
  title: string;
  outcome: string | null;
  approach: string | null;
  files_changed: string[];
  design_decisions: Array<{
    problem: string;
    choice: string;
    rationale: string | null;
    confidence: number;
  }>;
  constraints: string[];
  rejected_alternatives: Array<{ option: string; reason: string | null }>;
}

export function formatPRContext(ctx: PRContextData): string {
  const lines: string[] = [];
  const outcome = ctx.outcome ? ` [${ctx.outcome}]` : "";

  lines.push(`# PR #${ctx.number}${outcome}: ${ctx.title}`);
  lines.push(`*${ctx.repo}*`);
  lines.push("");

  if (ctx.approach) {
    lines.push("## Approach");
    lines.push(ctx.approach);
    lines.push("");
  }

  if (ctx.files_changed.length > 0) {
    lines.push("## Files Changed");
    for (const f of ctx.files_changed) lines.push(`- \`${f}\``);
    lines.push("");
  }

  if (ctx.design_decisions.length > 0) {
    lines.push("## Design Decisions");
    for (const d of ctx.design_decisions) {
      lines.push(`- **Problem:** ${d.problem}`);
      lines.push(`  **Choice:** ${d.choice}`);
      if (d.rationale) lines.push(`  **Why:** ${d.rationale}`);
      lines.push(`  *(confidence: ${d.confidence.toFixed(2)})*`);
    }
    lines.push("");
  }

  if (ctx.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of ctx.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  if (ctx.rejected_alternatives.length > 0) {
    lines.push("## Rejected Approaches");
    for (const r of ctx.rejected_alternatives) {
      lines.push(`- **${r.option}**${r.reason ? `: ${r.reason}` : ""}`);
    }
    lines.push("");
  }

  if (
    ctx.design_decisions.length === 0 &&
    ctx.constraints.length === 0 &&
    ctx.rejected_alternatives.length === 0
  ) {
    lines.push("*No enrichment data available. Run `git-wik enrich` to extract decisions.*");
  }

  return formatWithBudget(lines.join("\n"), 500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeAge(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}
