import {
  getDb,
  getIssue,
  getPR,
  getContributor,
  getEdgesFrom,
  getEdgesTo,
} from "../graph/db.js";
import { populateFromIssue } from "../fetcher/populate.js";

export interface RelatedPR {
  number: number;
  title: string;
  outcome: string | null;
  files_touched: string[];
  author: string | null;
  reviewers: string[];
  thread: string | null;
}

export interface IssueIntelligence {
  repo: string;
  issue: {
    number: number;
    title: string;
    state: string;
    body_summary: string | null;
    thread: string | null;
  };
  related_prs: RelatedPR[];
  contributors: string[];
}

export async function researchIssue(
  repo: string,
  issueNumber: number
): Promise<IssueIntelligence> {
  await populateFromIssue(repo, issueNumber);

  const db = getDb(repo);
  const issueId = `${repo}#${issueNumber}`;

  const issueNode = getIssue(db, issueId);
  if (!issueNode) throw new Error(`Issue ${issueId} not found after population`);

  // ── Related PRs ────────────────────────────────────────────────────────────
  const prEdges = getEdgesTo(db, "issue", issueId, "FIXES");
  const related_prs: RelatedPR[] = prEdges
    .map((e) => {
      const pr = getPR(db, e.from_id);
      if (!pr) return null;

      const fileEdges = getEdgesFrom(db, "pr", pr.id, "TOUCHES");
      const files_touched = fileEdges.map((fe) => fe.to_id.replace(`${repo}::`, ""));

      const authorEdge = getEdgesFrom(db, "pr", pr.id, "AUTHORED_BY")[0];
      const author = authorEdge ? getContributor(db, authorEdge.to_id)?.username ?? null : null;

      const reviewerEdges = getEdgesFrom(db, "pr", pr.id, "REVIEWED_BY");
      const reviewers = reviewerEdges
        .map((re) => getContributor(db, re.to_id)?.username)
        .filter((u): u is string => !!u);

      return {
        number: pr.number,
        title: pr.title,
        outcome: pr.outcome,
        files_touched,
        author,
        reviewers,
        thread: pr.raw_json,
      };
    })
    .filter((p): p is RelatedPR => p !== null);

  // ── All contributors (issue author + commenters + PR participants) ─────────
  const allContributors = new Set<string>();

  const issueContribEdges = [
    ...getEdgesFrom(db, "issue", issueId, "AUTHORED_BY"),
    ...getEdgesFrom(db, "issue", issueId, "COMMENTED_BY"),
  ];
  for (const e of issueContribEdges) {
    const c = getContributor(db, e.to_id);
    if (c) allContributors.add(c.username);
  }
  for (const pr of related_prs) {
    if (pr.author) allContributors.add(pr.author);
    for (const r of pr.reviewers) allContributors.add(r);
  }

  return {
    repo,
    issue: {
      number: issueNode.number,
      title: issueNode.title,
      state: issueNode.state,
      body_summary: issueNode.body_summary,
      thread: issueNode.raw_json,
    },
    related_prs,
    contributors: [...allContributors],
  };
}
