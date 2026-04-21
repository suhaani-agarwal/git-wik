import { getDb } from "../../graph/db.js";
import { searchAll } from "../../graph/fts.js";
import { formatSimilarResults } from "../../intelligence/formatter.js";

export const findSimilarTool = {
  name: "find_similar",
  description: `Search the indexed graph for issues and PRs similar to a query.
Uses BM25 full-text search to find the most relevant issues and pull requests, ranked by relevance.
Useful for discovering prior art before starting an implementation, or finding duplicates before filing an issue.
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
        description: "Natural-language search query",
      },
      limit: {
        type: "number",
        description: "Max number of results to return (default: 5, max: 10)",
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
