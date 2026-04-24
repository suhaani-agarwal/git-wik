import { researchIssue } from "../../intelligence/issue.js";
import { formatIssueIntelligence } from "../../intelligence/formatter.js";

export const researchIssueTool = {
  name: "research_issue",
  description: `Full context for a GitHub issue: related PRs, contributors, discussion. Cached 2h via gh CLI.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "owner/name",
      },
      issue_number: {
        type: "number",
        description: "Issue number",
      },
      depth: {
        type: "string",
        enum: ["brief", "full"],
        description: '"brief" (<300 tokens, default) or "full" (up to 1200 tokens)',
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
