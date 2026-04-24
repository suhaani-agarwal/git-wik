import { getDb, isStale } from "../../graph/db.js";
import { populateRepoIndex } from "../../fetcher/populate.js";
import { detectSeed, traverseFromSeed } from "../../intelligence/context.js";
import { formatContextPackage } from "../../intelligence/context-formatter.js";
import { hydrateFileContextIfSparse } from "./hydrate-file-context.js";

export const getContextTool = {
  name: "get_context",
  description: `Repo history intelligence. Pass a file path, issue#, PR#, or keyword — returns related PRs/issues, co-changed files, and design decisions in ≤700 tokens. Use before git log/blame. Auto-indexes on first call.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'owner/name, e.g. "expressjs/express"',
      },
      query: {
        type: "string",
        description: 'File path, "#123", "pr#456", or keyword',
      },
      token_budget: {
        type: "number",
        description: "Max tokens (default 700, max 900)",
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
    if (seed.type === "file") {
      await Promise.race([
        hydrateFileContextIfSparse(db, repo, seed.value),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    }
    const traversal = traverseFromSeed(db, repo, seed, { maxPRs: 12, maxIssues: 8 });
    const output = formatContextPackage(traversal, db, query.trim(), repo, tokenBudget);

    return { content: [{ type: "text" as const, text: output }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
}
