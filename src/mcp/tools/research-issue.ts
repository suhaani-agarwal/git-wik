import { researchIssue } from "../../intelligence/issue.js";
import { formatIssueIntelligence } from "../../intelligence/formatter.js";

export const researchIssueTool = {
  name: "research_issue",
  description: `Fetch structured intelligence about a GitHub issue from a local graph cache.
Returns the issue description, related PRs (with code review threads, files changed, reviewers), and contributor list.
Use this when you need context on why a decision was made, what alternatives were considered, or what the history of a bug/feature is.
The graph is populated on first call using the gh CLI; subsequent calls within 2 hours are instant (served from local SQLite).
No API key required. Requires the gh CLI to be authenticated.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'GitHub repo in "owner/name" format, e.g. "expressjs/express"',
      },
      issue_number: {
        type: "number",
        description: "The issue number",
      },
      depth: {
        type: "string",
        enum: ["brief", "full"],
        description: 'Response verbosity. "brief" (default, <300 tokens) or "full" (includes raw discussion threads, up to 1200 tokens)',
      },
    },
    required: ["repo", "issue_number"],
  },
} as const;

export async function handleResearchIssue(args: Record<string, unknown>) {
  const repo = args["repo"] as string | undefined;
  const issue_number = args["issue_number"] as number | undefined;
  const depth = (args["depth"] as "brief" | "full" | undefined) ?? "brief";

  if (!repo || typeof repo !== "string") {
    return { content: [{ type: "text" as const, text: 'Error: missing or invalid `repo` (expected "owner/name")' }], isError: true };
  }
  if (!issue_number || typeof issue_number !== "number") {
    return { content: [{ type: "text" as const, text: "Error: missing or invalid `issue_number`" }], isError: true };
  }
  if (!repo.includes("/")) {
    return { content: [{ type: "text" as const, text: `Error: repo must be "owner/name", got: ${repo}` }], isError: true };
  }

  try {
    const intel = await researchIssue(repo, issue_number);
    return { content: [{ type: "text" as const, text: formatIssueIntelligence(intel, depth) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error fetching issue: ${msg}` }], isError: true };
  }
}
