import { execa } from "execa";
import { getDb, getPR, getEdgesFrom, getIssue } from "../graph/db.js";
import { fetchCommitPRs, fetchCommitDetails } from "../fetcher/gh.js";
import { populateFromPR } from "../fetcher/populate.js";
import { truncateAt } from "../shared/token-budget.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BlameInfo {
  sha: string;
  shortSha: string;
  summary: string;    // commit subject line
  author: string;
  date: string;
  lineContent: string;
}

export interface WhyResult {
  file: string;
  line: number | null;
  blame: BlameInfo | null;
  pr: {
    number: number;
    title: string;
    outcome: string | null;
    mergedAt: string | null;
    author: string | null;
    reviewers: string[];
    filesChanged: string[];
    why: string | null;          // LLM-inferred rationale (confidence-gated)
    choice: string | null;       // LLM-inferred decision
    constraints: string[];
    rejectedAlts: Array<{ option: string; reason: string | null }>;
    fixesIssues: Array<{ number: number; title: string; state: string }>;
  } | null;
  fallback: string | null;       // message when no PR found
}

// ── Git blame ─────────────────────────────────────────────────────────────────

export async function blameFileLine(
  filePath: string,
  lineNumber: number
): Promise<BlameInfo | null> {
  try {
    const { stdout } = await execa("git", [
      "blame",
      `-L${lineNumber},${lineNumber}`,
      "--porcelain",
      "--",
      filePath,
    ]);

    const lines = stdout.split("\n");
    const firstLine = lines[0] ?? "";
    const sha = firstLine.slice(0, 40);
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;

    const get = (prefix: string): string =>
      lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";

    const lineContent = lines.find((l) => l.startsWith("\t"))?.slice(1) ?? "";

    return {
      sha,
      shortSha: sha.slice(0, 8),
      summary:  get("summary "),
      author:   get("author "),
      date:     new Date(parseInt(get("author-time "), 10) * 1000)
                  .toISOString().slice(0, 10),
      lineContent: lineContent.trim(),
    };
  } catch {
    return null;
  }
}

// ── PR context assembly ────────────────────────────────────────────────────────

async function assemblePRContext(
  repo: string,
  prNumber: number
): Promise<WhyResult["pr"]> {
  const db = getDb(repo);

  // Ensure PR is in graph (populate on-demand if needed)
  const prId = `${repo}#pr#${prNumber}`;
  if (!getPR(db, prId)) {
    try {
      await populateFromPR(repo, prNumber);
    } catch { /* best-effort */ }
  }

  const pr = getPR(db, prId);
  if (!pr) return null;

  // Reviewers
  const reviewerEdges = getEdgesFrom(db, "pr", prId, "REVIEWED_BY");
  const reviewers = reviewerEdges.map((e) => e.to_id.replace(`${repo}::`, ""));

  // Files changed
  const fileEdges = getEdgesFrom(db, "pr", prId, "TOUCHES");
  const filesChanged = fileEdges.map((e) => e.to_id.replace(`${repo}::`, "")).slice(0, 6);

  // Issues fixed
  const fixEdges = getEdgesFrom(db, "pr", prId, "FIXES");
  const fixesIssues: Array<{ number: number; title: string; state: string }> = [];
  for (const e of fixEdges) {
    const issue = getIssue(db, e.to_id);
    if (issue) fixesIssues.push({ number: issue.number, title: issue.title, state: issue.state });
  }

  // LLM-inferred content (confidence + evidence gated)
  let why: string | null = null;
  let choice: string | null = null;
  const constraints: string[] = [];
  const rejectedAlts: Array<{ option: string; reason: string | null }> = [];

  const decEdges = getEdgesFrom(db, "pr", prId, "PRODUCED");
  for (const de of decEdges) {
    const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(de.to_id) as
      { rationale: string | null; choice: string; confidence: number } | undefined;
    if (d && d.confidence >= 0.7 && d.rationale) {
      why   = why   ?? truncateAt(d.rationale, 200);
      choice = choice ?? truncateAt(d.choice,   150);
    }
  }

  // Also check inline enrichment in body_summary
  if (!why && pr.body_summary?.startsWith("{")) {
    try {
      const parsed = JSON.parse(pr.body_summary) as {
        rationale?: string | null; choice?: string | null; confidence?: number;
        constraints?: string[]; rejected?: Array<{ option: string; reason?: string | null }>;
      };
      if ((parsed.confidence ?? 0) >= 0.7 && parsed.rationale) {
        why   = truncateAt(parsed.rationale, 200);
        choice = parsed.choice ? truncateAt(parsed.choice, 150) : null;
      }
      for (const c of parsed.constraints ?? []) constraints.push(truncateAt(c, 100));
      for (const r of parsed.rejected ?? []) {
        if (r.option) rejectedAlts.push({ option: r.option, reason: r.reason ?? null });
      }
    } catch { /* ignore */ }
  }

  const cEdges = getEdgesFrom(db, "pr", prId, "REQUIRES");
  for (const ce of cEdges) {
    const c = db.prepare("SELECT text FROM constraints WHERE id=?").get(ce.to_id) as { text: string } | undefined;
    if (c) constraints.push(truncateAt(c.text, 100));
  }
  const rEdges = getEdgesFrom(db, "pr", prId, "REJECTS");
  for (const re of rEdges) {
    const ra = db.prepare("SELECT option_text, rejection_reason FROM rejected_alternatives WHERE id=?").get(re.to_id) as
      { option_text: string; rejection_reason: string | null } | undefined;
    if (ra) rejectedAlts.push({ option: ra.option_text, reason: ra.rejection_reason });
  }

  const mergedAt = pr.merged_at
    ? new Date(pr.merged_at * 1000).toISOString().slice(0, 10)
    : null;

  const authorEdge = getEdgesFrom(db, "pr", prId, "AUTHORED_BY")[0];
  const author = authorEdge ? authorEdge.to_id.replace(`${repo}::`, "") : null;

  return {
    number: pr.number,
    title: pr.title,
    outcome: pr.outcome,
    mergedAt,
    author,
    reviewers,
    filesChanged,
    why,
    choice,
    constraints,
    rejectedAlts,
    fixesIssues,
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function whyLine(
  repo: string,
  filePath: string,
  lineNumber: number | null
): Promise<WhyResult> {
  const result: WhyResult = { file: filePath, line: lineNumber, blame: null, pr: null, fallback: null };

  // ── Step 1: git blame ──
  if (lineNumber !== null) {
    result.blame = await blameFileLine(filePath, lineNumber);
  }

  if (!result.blame) {
    // No blame data (file not tracked, or line number not given)
    // Fall back to file-level: find latest PR that touched this file
    const db = getDb(repo);
    const fileId = `${repo}::${filePath}`;
    const touchEdges = getEdgesFrom(db, "file", fileId, "TOUCHES");

    if (touchEdges.length === 0) {
      result.fallback = `No PR history found for ${filePath}. Run: git-wik index ${repo}`;
      return result;
    }

    // Get the most recently merged PR
    let bestPRNum: number | null = null;
    let bestMergedAt = 0;
    for (const e of touchEdges) {
      const pr = getPR(db, e.from_id);
      if (pr && (pr.merged_at ?? 0) > bestMergedAt) {
        bestMergedAt = pr.merged_at ?? 0;
        bestPRNum = pr.number;
      }
    }

    if (bestPRNum) {
      result.pr = await assemblePRContext(repo, bestPRNum);
    } else {
      result.fallback = `Found ${touchEdges.length} PRs touching this file but none are merged.`;
    }
    return result;
  }

  // ── Step 2: Commit → PR via GitHub API ──
  const prs = await fetchCommitPRs(repo, result.blame.sha);

  if (prs.length === 0) {
    // Commit not associated with any PR (direct push, or API limitation)
    const details = await fetchCommitDetails(repo, result.blame.sha);
    result.fallback = [
      `Commit ${result.blame.shortSha} was not part of a PR.`,
      details ? `Committed by ${details.author} on ${details.date.slice(0, 10)}: "${details.message}"` : "",
    ].filter(Boolean).join("\n");
    return result;
  }

  // Use the most recently merged PR
  const targetPR = prs.find((p) => p.mergedAt) ?? prs[0]!;
  result.pr = await assemblePRContext(repo, targetPR.number);

  return result;
}
