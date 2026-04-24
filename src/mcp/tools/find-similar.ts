import { getDb } from "../../graph/db.js";
import { searchAll } from "../../graph/fts.js";
import { formatSimilarResults } from "../../intelligence/formatter.js";

export const findSimilarTool = {
  name: "find_similar",
  description: `BM25 search for issues and PRs similar to a query. Use before filing an issue or starting an implementation.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "owner/name",
      },
      query: {
        type: "string",
        description: "Search query",
      },
      limit: {
        type: "number",
        description: "Max results (default 5, max 10)",
      },
    },
    required: ["repo", "query"],
  },
} as const;

export async function handleFindSimilar(args: Record<string, unknown>) {
  const repo = args["repo"] as string | undefined;
  const query = args["query"] as string | undefined;
  const limit = typeof args["limit"] === "number" ? Math.min(args["limit"], 10) : 5;

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
    const db = getDb(repo);
    const results = searchAll(db, query, limit);
    return { content: [{ type: "text" as const, text: formatSimilarResults(repo, query, results) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error searching: ${msg}` }], isError: true };
  }
}
