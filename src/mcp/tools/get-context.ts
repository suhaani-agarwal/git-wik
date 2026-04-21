import { getDb, isStale } from "../../graph/db.js";
import { populateRepoIndex } from "../../fetcher/populate.js";
import { detectSeed, traverseFromSeed } from "../../intelligence/context.js";
import { formatContextPackage } from "../../intelligence/context-formatter.js";

export const getContextTool = {
  name: "get_context",
  description: `Unified repo intelligence for any query type — the fastest way to understand what changed, why, and what constraints exist.

Query can be:
- A file path:       "src/auth/middleware.ts"
- An issue number:   "#123" or "123"
- A PR number:       "pr#456" or "pr456"
- A feature/keyword: "rate limiting" or "session handling"

Returns ≤700 tokens covering:
- PRs that directly relate to the query, with merge date and review outcomes
- Open and closed issues related to the query
- Linked/dependent PRs discovered via comment cross-references and DEPENDS_ON edges
- Co-changed files (from git history)
- LLM-inferred design decisions (confidence ≥0.7 with supporting rationale, marked [inferred:N.NN])
- Count of omitted low-evidence inferences

If the repo isn't indexed yet, returns a setup hint instead of failing.
Index a repo with: npx git-wik index <owner/repo>`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'GitHub repo in "owner/name" format, e.g. "expressjs/express"',
      },
      query: {
        type: "string",
        description: "File path, issue#, PR# (pr#N), or natural-language keyword/feature name",
      },
      token_budget: {
        type: "number",
        description: "Max output tokens (default: 700, max: 900)",
      },
    },
    required: ["repo", "query"],
  },
} as const;

export async function handleGetContext(args: Record<string, unknown>) {
  const repo  = args["repo"]  as string | undefined;
  const query = args["query"] as string | undefined;
  const rawBudget = args["token_budget"];
  const tokenBudget = typeof rawBudget === "number" ? Math.min(rawBudget, 900) : 700;

  if (!repo || typeof repo !== "string" || !repo.includes("/")) {
    return { content: [{ type: "text" as const, text: 'Error: `repo` must be "owner/name"' }], isError: true };
  }
  if (!query || typeof query !== "string" || !query.trim()) {
    return { content: [{ type: "text" as const, text: "Error: `query` is required" }], isError: true };
  }

  try {
    const db = getDb(repo);

    // Cold-start guard
    if (isStale(db, repo, "repo:index", 24 * 60 * 60)) {
      try {
        await populateRepoIndex(repo);
      } catch {
        const text = [
          `# Context: "${query}"  ·  ${repo}`,
          "",
          "**Repo not indexed yet.**",
          "",
          `Run: \`npx git-wik index ${repo}\``,
          "",
          "Then call this tool again.",
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      }
    }

    const seed = detectSeed(query.trim());
    const traversal = traverseFromSeed(db, repo, seed, { maxPRs: 12, maxIssues: 8 });
    const output = formatContextPackage(traversal, db, query.trim(), repo, tokenBudget);

    return { content: [{ type: "text" as const, text: output }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
}
