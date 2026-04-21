import type { GhIssueRaw, GhPRRaw, GhTimelineEvent } from "./gh.js";

// ── Issue relationship parsing ─────────────────────────────────────────────────

const FIXES_RE = /(?:fix(?:es|ed)?|clos(?:es|ed)|resolv(?:es|ed))\s+#(\d+)/gi;
const REFS_RE  = /(?:ref(?:erences?)?|related\s+to|see)\s+#(\d+)/gi;

export function parseIssueRelationships(body: string): {
  fixes: number[];
  references: number[];
} {
  const fixes: number[] = [];
  const references: number[] = [];

  for (const m of body.matchAll(FIXES_RE)) {
    if (m[1]) fixes.push(parseInt(m[1], 10));
  }
  for (const m of body.matchAll(REFS_RE)) {
    if (m[1]) references.push(parseInt(m[1], 10));
  }

  return { fixes: [...new Set(fixes)], references: [...new Set(references)] };
}

// Extract PR numbers from cross-referenced timeline events
export function extractReferencedPRNumbers(
  timeline: GhTimelineEvent[]
): number[] {
  const prNums = new Set<number>();
  for (const event of timeline) {
    if (
      event.event === "cross-referenced" &&
      event.source?.type === "issue" &&
      event.source.issue?.number &&
      event.source.issue.pull_request !== undefined
    ) {
      prNums.add(event.source.issue.number);
    }
  }
  return [...prNums];
}

// ── PR parsing ─────────────────────────────────────────────────────────────────

export function parsePRFiles(pr: GhPRRaw): string[] {
  return (pr.files ?? []).map((f) => f.path);
}

export function parsePRReviewers(pr: GhPRRaw): string[] {
  const author = pr.author?.login ?? "";
  const seen = new Set<string>();
  for (const r of pr.reviews ?? []) {
    const login = r.author?.login ?? "";
    if (login && login !== author && !login.endsWith("[bot]")) {
      seen.add(login);
    }
  }
  return [...seen];
}

export function parsePROutcome(
  pr: GhPRRaw
): "merged" | "rejected" | "abandoned" | "open" {
  if (pr.mergedAt || pr.state === "MERGED") return "merged";
  if (pr.state === "OPEN") return "open";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "rejected";
  return "abandoned";
}

// ── Thread text builders ───────────────────────────────────────────────────────

function truncateMid(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + "\n\n[...truncated...]\n\n" + text.slice(-half);
}

function isBot(login: string): boolean {
  return login.endsWith("[bot]") || login === "github-actions";
}

export function buildThreadText(issue: GhIssueRaw): string {
  const nonBotComments = (issue.comments ?? []).filter(
    (c) => !isBot(c.author?.login ?? "")
  );

  const parts = [
    `ISSUE #${issue.number}: ${issue.title}`,
    issue.body ?? "",
    ...nonBotComments.map(
      (c) => `COMMENT by @${c.author.login}:\n${c.body}`
    ),
  ];

  return truncateMid(parts.join("\n\n---\n\n"));
}

export function buildPRThreadText(pr: GhPRRaw): string {
  const reviewComments = (pr.reviews ?? [])
    .filter((r) => !isBot(r.author?.login ?? "") && r.state !== "APPROVED")
    .map((r) => `REVIEW by @${r.author.login} (${r.state}):\n(no inline body)`);

  const parts = [
    `PR #${pr.number}: ${pr.title}`,
    pr.body ?? "",
    ...reviewComments,
  ];

  return truncateMid(parts.join("\n\n---\n\n"));
}

// ── PR-to-PR relationship extraction ──────────────────────────────────────────

const PR_DEPENDS_RE   = /(?:depends\s+on|stacks?\s+on|based\s+on|blocked\s+by)\s+#(\d+)/gi;
const PR_SUPERSEDES_RE = /(?:supersedes|replaces|closes\s+in\s+favor\s+of)\s+#(\d+)/gi;

export function parsePRRelationships(body: string): {
  dependsOn: number[];
  supersedes: number[];
  references: number[];
} {
  const dependsOn: number[] = [];
  const supersedes: number[] = [];
  const references: number[] = [];

  for (const m of body.matchAll(PR_DEPENDS_RE)) {
    if (m[1]) dependsOn.push(parseInt(m[1], 10));
  }
  for (const m of body.matchAll(PR_SUPERSEDES_RE)) {
    if (m[1]) supersedes.push(parseInt(m[1], 10));
  }
  // Re-use the REFS_RE from issue relationships for generic mentions
  for (const m of body.matchAll(REFS_RE)) {
    if (m[1]) references.push(parseInt(m[1], 10));
  }

  return {
    dependsOn:  [...new Set(dependsOn)],
    supersedes: [...new Set(supersedes)],
    references: [...new Set(references)],
  };
}

/** Extract issue fix/ref numbers from a commit message. */
export function parseCommitIssueRefs(message: string): {
  fixes: number[];
  references: number[];
} {
  return parseIssueRelationships(message);
}

// ── Comment cross-reference parsing ───────────────────────────────────────────

const REFERENCE_RE = /\b(?:fix(?:es|ed)?|clos(?:es|ed)|resolv(?:es|ed)|depends?\s+on|related\s+to)\s+#(\d+)/gi;
const MENTION_RE   = /#(\d+)/g;

export interface MentionEdge {
  from_id: string;
  from_type: "issue" | "pr";
  to_number: number;
  edge_type: "REFERENCES" | "MENTIONS";
}

/**
 * Parse cross-references from comment/body text into typed edge specs.
 * REFERENCES: explicit "fixes #N", "closes #N", "related to #N", "depends on #N"
 * MENTIONS: bare "#N" not already captured as a REFERENCES edge
 */
export function parseMentions(
  text: string,
  sourceId: string,
  sourceType: "issue" | "pr"
): MentionEdge[] {
  const results: MentionEdge[] = [];
  const referenced = new Set<number>();

  for (const m of text.matchAll(REFERENCE_RE)) {
    if (m[1]) {
      const n = parseInt(m[1], 10);
      referenced.add(n);
      results.push({ from_id: sourceId, from_type: sourceType, to_number: n, edge_type: "REFERENCES" });
    }
  }

  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1]) {
      const n = parseInt(m[1], 10);
      if (!referenced.has(n)) {
        referenced.add(n);
        results.push({ from_id: sourceId, from_type: sourceType, to_number: n, edge_type: "MENTIONS" });
      }
    }
  }

  return results;
}

/** Extract cross-repo references like "owner/repo#123". */
const CROSS_REPO_RE = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)/g;

export function parseCrossRepoRefs(
  text: string
): Array<{ repo: string; number: number }> {
  const results: Array<{ repo: string; number: number }> = [];
  for (const m of text.matchAll(CROSS_REPO_RE)) {
    if (m[1] && m[2]) {
      results.push({ repo: m[1], number: parseInt(m[2], 10) });
    }
  }
  return results;
}

/**
 * Parse the output of:
 *   git log --name-only --pretty=format:%H -n <limit> --diff-filter=ACDMR
 *
 * Returns an array of { sha, files[] } objects for co-change analysis.
 */
export function parseGitLogOutput(
  stdout: string
): Array<{ sha: string; files: string[] }> {
  const result: Array<{ sha: string; files: string[] }> = [];
  const lines = stdout.split("\n");

  let current: { sha: string; files: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line separates commits; push the current batch
      if (current && current.files.length > 0) {
        result.push(current);
        current = null;
      }
      continue;
    }
    // SHA lines are 40 hex chars
    if (/^[0-9a-f]{40}$/i.test(trimmed)) {
      if (current && current.files.length > 0) {
        result.push(current);
      }
      current = { sha: trimmed, files: [] };
    } else if (current) {
      // File path line
      current.files.push(trimmed);
    }
  }
  if (current && current.files.length > 0) result.push(current);

  return result;
}

// ── Co-change analysis ─────────────────────────────────────────────────────────

export function extractCoChangePairs(
  commitFilesList: string[][]
): Array<{ fileA: string; fileB: string; count: number }> {
  const pairCounts = new Map<string, number>();

  for (const files of commitFilesList) {
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i]!;
        const b = files[j]!;
        const key = a < b ? `${a}|||${b}` : `${b}|||${a}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return [...pairCounts.entries()].map(([key, count]) => {
    const [fileA, fileB] = key.split("|||") as [string, string];
    return { fileA, fileB, count };
  });
}
