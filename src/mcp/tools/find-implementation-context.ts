import { findImplementationContext } from "../../intelligence/implementation-context.js";
import { formatImplementationContext } from "../../intelligence/formatter.js";

export const findImplementationContextTool = {
  name: "find_implementation_context",
  description: `Pre-implementation context for a keyword/feature: prior PRs, decisions, constraints, rejected approaches. Use get_context for file/issue/PR queries.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "owner/name",
      },
      query: {
        type: "string",
        description: "Feature or keyword to research",
      },
      max_prs: {
        type: "number",
        description: "Max PRs (default 3)",
      },
      max_files: {
        type: "number",
        description: "Max files (default 3)",
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
