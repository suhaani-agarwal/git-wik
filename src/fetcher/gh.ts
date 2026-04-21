import { ghJson, ghApi } from "./retry.js";

// ── Raw types from gh CLI ──────────────────────────────────────────────────────

export interface GhAuthor {
  login: string;
}

export interface GhComment {
  author: GhAuthor;
  body: string;
  createdAt: string;
}

export interface GhLabel {
  name: string;
  color: string;
}

export interface GhMilestone {
  number: number;
  title: string;
  state: string;
}

export interface GhIssueRaw {
  number: number;
  title: string;
  body: string;
  state: string;             // OPEN | CLOSED
  createdAt: string;
  closedAt: string | null;
  author: GhAuthor;
  comments: GhComment[];
  labels?: GhLabel[];
  milestone?: GhMilestone | null;
}

export interface GhIssueListItem {
  number: number;
  title: string;
  state: string;
  labels: GhLabel[];
  milestone: GhMilestone | null;
  createdAt: string;
  closedAt: string | null;
}

export interface GhPRFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GhReview {
  author: GhAuthor;
  state: string;             // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  submittedAt: string;
}

export interface GhReviewComment {
  author: GhAuthor;
  body: string;
  path: string;
  createdAt: string;
}

export interface GhPRRaw {
  number: number;
  title: string;
  body: string;
  state: string;             // OPEN | CLOSED | MERGED
  mergedAt: string | null;
  closedAt: string | null;
  reviewDecision: string | null;
  author: GhAuthor;
  reviews: GhReview[];
  files: GhPRFile[];
  labels?: GhLabel[];
  milestone?: GhMilestone | null;
}

export interface GhPRListItem {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  labels: GhLabel[];
  milestone: GhMilestone | null;
  headRefName: string;
}

export interface GhTimelineEvent {
  event: string;
  source?: {
    type?: string;
    issue?: { number: number; pull_request?: unknown };
  };
  actor?: GhAuthor;
}

export interface GhCommit {
  sha: string;
  commit: { message: string };
}

export interface GhCommitDetail {
  files?: Array<{ filename: string }>;
}

export interface GhCommitAuthor {
  name: string;
  email: string;
  date: string;
}

export interface GhCommitFull {
  sha: string;
  commit: { message: string; author: GhCommitAuthor };
  author: GhAuthor | null;
}

// ── Single-item fetch functions ────────────────────────────────────────────────

export async function fetchIssueWithComments(
  repo: string,
  issueNumber: number
): Promise<GhIssueRaw> {
  return ghJson<GhIssueRaw>([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--comments",
    "--json", "number,title,body,state,createdAt,closedAt,author,comments,labels,milestone",
  ]);
}

export async function fetchPRWithDetails(
  repo: string,
  prNumber: number
): Promise<GhPRRaw | null> {
  try {
    return await ghJson<GhPRRaw>([
      "pr", "view", String(prNumber),
      "--repo", repo,
      "--json", "number,title,body,state,mergedAt,closedAt,reviewDecision,author,reviews,files,labels,milestone",
    ]);
  } catch {
    return null;
  }
}

export async function fetchIssueTimeline(
  repo: string,
  issueNumber: number
): Promise<GhTimelineEvent[]> {
  try {
    return await ghApi<GhTimelineEvent[]>(
      `/repos/${repo}/issues/${issueNumber}/timeline`
    );
  } catch {
    return [];
  }
}

// ── Bulk list fetch functions (paginated) ─────────────────────────────────────

/**
 * Fetch all issues for a repo (stubs only — no comments).
 * Uses gh issue list with --limit to stay within rate limits.
 * Pass `since` to fetch only items updated after that date.
 */
export async function fetchAllIssues(
  repo: string,
  opts: { since?: Date; limit?: number } = {}
): Promise<GhIssueListItem[]> {
  const limit = opts.limit ?? 500;
  const args = [
    "issue", "list",
    "--repo", repo,
    "--state", "all",
    "--limit", String(limit),
    "--json", "number,title,state,labels,milestone,createdAt,closedAt",
  ];
  try {
    const items = await ghJson<GhIssueListItem[]>(args);
    if (opts.since) {
      const since = opts.since.getTime();
      return items.filter((i) => new Date(i.createdAt).getTime() >= since);
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch all PRs for a repo (stubs only — no files/reviews).
 */
export async function fetchAllPRs(
  repo: string,
  opts: { since?: Date; limit?: number } = {}
): Promise<GhPRListItem[]> {
  const limit = opts.limit ?? 500;
  const args = [
    "pr", "list",
    "--repo", repo,
    "--state", "all",
    "--limit", String(limit),
    "--json", "number,title,state,mergedAt,labels,milestone,headRefName",
  ];
  try {
    const items = await ghJson<GhPRListItem[]>(args);
    if (opts.since) {
      const since = opts.since.getTime();
      return items.filter(
        (p) => p.mergedAt && new Date(p.mergedAt).getTime() >= since
      );
    }
    return items;
  } catch {
    return [];
  }
}

// ── PR detail fetch functions ──────────────────────────────────────────────────

/** Fetch commits for a specific PR (for commit→issue link extraction). */
export async function fetchPRCommits(
  repo: string,
  prNumber: number
): Promise<GhCommitFull[]> {
  try {
    return await ghApi<GhCommitFull[]>(
      `/repos/${repo}/pulls/${prNumber}/commits?per_page=100`
    );
  } catch {
    return [];
  }
}

/** Fetch inline review comments for a PR (discussion context for enrichment). */
export async function fetchPRReviewComments(
  repo: string,
  prNumber: number
): Promise<GhReviewComment[]> {
  try {
    return await ghApi<GhReviewComment[]>(
      `/repos/${repo}/pulls/${prNumber}/comments?per_page=100`
    );
  } catch {
    return [];
  }
}

// ── Repo metadata ──────────────────────────────────────────────────────────────

export async function fetchLabels(repo: string): Promise<GhLabel[]> {
  try {
    return await ghApi<GhLabel[]>(`/repos/${repo}/labels?per_page=100`);
  } catch {
    return [];
  }
}

export async function fetchMilestones(repo: string): Promise<GhMilestone[]> {
  try {
    return await ghApi<GhMilestone[]>(
      `/repos/${repo}/milestones?state=all&per_page=100`
    );
  } catch {
    return [];
  }
}

// ── Search / recent helpers ────────────────────────────────────────────────────

export async function searchSimilarPRs(
  repo: string,
  query: string
): Promise<Array<{ number: number; title: string; state: string }>> {
  try {
    return await ghJson([
      "search", "prs",
      query,
      "--repo", repo,
      "--state", "all",
      "--json", "number,title,state",
      "--limit", "10",
    ]);
  } catch {
    return [];
  }
}

export async function fetchRecentPRs(
  repo: string,
  limit = 30
): Promise<Array<{ number: number; title: string; state: string; mergedAt: string | null }>> {
  try {
    return await ghJson([
      "pr", "list",
      "--repo", repo,
      "--state", "all",
      "--limit", String(limit),
      "--json", "number,title,state,mergedAt",
    ]);
  } catch {
    return [];
  }
}

export async function fetchRecentCommits(
  repo: string,
  limit = 50
): Promise<GhCommit[]> {
  try {
    return await ghApi<GhCommit[]>(
      `/repos/${repo}/commits?per_page=${limit}`
    );
  } catch {
    return [];
  }
}

/** Find PRs that contain a given commit SHA (for git-wik why). */
export async function fetchCommitPRs(
  repo: string,
  sha: string
): Promise<Array<{ number: number; title: string; state: string; mergedAt: string | null }>> {
  try {
    return await ghApi<Array<{ number: number; title: string; state: string; mergedAt: string | null }>>(
      `/repos/${repo}/commits/${sha}/pulls`
    );
  } catch {
    return [];
  }
}

export async function fetchCommitDetails(
  repo: string,
  sha: string
): Promise<{ message: string; author: string; date: string } | null> {
  try {
    const data = await ghApi<{ commit: { message: string; author: { name: string; date: string } } }>(
      `/repos/${repo}/commits/${sha}`
    );
    return {
      message: data.commit.message.split("\n")[0]!,
      author: data.commit.author.name,
      date: data.commit.author.date,
    };
  } catch {
    return null;
  }
}

export async function fetchCommitFiles(
  repo: string,
  sha: string
): Promise<string[]> {
  try {
    const detail = await ghApi<GhCommitDetail>(
      `/repos/${repo}/commits/${sha}`
    );
    return (detail.files ?? []).map((f) => f.filename);
  } catch {
    return [];
  }
}

export async function fetchContributingMd(
  repo: string
): Promise<string | null> {
  try {
    const data = await ghApi<{ content?: string }>(
      `/repos/${repo}/contents/CONTRIBUTING.md`
    );
    if (!data.content) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}
