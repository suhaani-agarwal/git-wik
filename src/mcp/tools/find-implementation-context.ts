import { findImplementationContext } from "../../intelligence/implementation-context.js";
import { formatImplementationContext } from "../../intelligence/formatter.js";

export const findImplementationContextTool = {
  name: "find_implementation_context",
  description: `Find relevant PRs, design decisions, constraints, and file context for implementing a feature or fixing a bug.
Given a natural-language query like "add rate limiting" or "fix auth token refresh", searches the indexed graph for:
- PRs that solved similar problems (with their outcomes and approaches)
- Design decisions made during those PRs (problem → choice → rationale)
- Constraints that must be respected
- Approaches that were explicitly rejected
- Files most relevant to the change, plus their co-change partners

Returns a structured, token-efficient context package (<700 tokens).
Requires the repo to have been indexed with \`git-wik index <repo>\`.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'GitHub repo in "owner/name" format, e.g. "expressjs/express"',
      },
      query: {
        type: "string",
        description: "Natural-language description of what you want to implement or investigate",
      },
      max_prs: {
        type: "number",
        description: "Max number of relevant PRs to return (default: 3)",
      },
      max_files: {
        type: "number",
        description: "Max number of relevant files to return (default: 3)",
      },
    },
    required: ["repo", "query"],
  },
} as const;

export async function handleFindImplementationContext(args: Record<string, unknown>) {
  const repo = args["repo"] as string | undefined;
  const query = args["query"] as string | undefined;
  const maxPRs = typeof args["max_prs"] === "number" ? args["max_prs"] : undefined;
  const maxFiles = typeof args["max_files"] === "number" ? args["max_files"] : undefined;

  if (!repo || typeof repo !== "string") {
    return { content: [{ type: "text" as const, text: 'Error: missing or invalid `repo` (expected "owner/name")' }], isError: true };
  }
  if (!query || typeof query !== "string" || !query.trim()) {
    return { content: [{ type: "text" as const, text: "Error: missing or invalid `query`" }], isError: true };
  }
  if (!repo.includes("/")) {
    return { content: [{ type: "text" as const, text: `Error: repo must be "owner/name", got: ${repo}` }], isError: true };
  }

  try {
    const ctx = await findImplementationContext(repo, query, {
      maxPRs,
      maxFiles,
    });
    return { content: [{ type: "text" as const, text: formatImplementationContext(ctx) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error finding implementation context: ${msg}` }], isError: true };
  }
}
