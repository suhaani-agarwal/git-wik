import { getFileLore } from "../../intelligence/file-lore.js";
import { formatFileLore } from "../../intelligence/formatter.js";
import { getDb } from "../../graph/db.js";
import { hydrateFileContextIfSparse } from "./hydrate-file-context.js";

export const getFileLoreTool = {
  name: "get_file_lore",
  description: `File history: PRs that changed it, decisions made, constraints enforced, co-change partners.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "owner/name",
      },
      path: {
        type: "string",
        description: "File path relative to repo root",
      },
    },
    required: ["repo", "path"],
  },
} as const;

export async function handleGetFileLore(args: Record<string, unknown>) {
  const repo = args["repo"] as string | undefined;
  const filePath = args["path"] as string | undefined;

  if (!repo || typeof repo !== "string") {
    return { content: [{ type: "text" as const, text: "Error: missing or invalid `repo`" }], isError: true };
  }
  if (!filePath || typeof filePath !== "string") {
    return { content: [{ type: "text" as const, text: "Error: missing or invalid `path`" }], isError: true };
  }

  try {
    const db = getDb(repo);
    await Promise.race([
      hydrateFileContextIfSparse(db, repo, filePath, { maxPrHydrations: 16, targetTouchEdges: 3 }),
      new Promise<void>((resolve) => setTimeout(resolve, 10000)),
    ]);
    const lore = await getFileLore(repo, filePath);
    return { content: [{ type: "text" as const, text: formatFileLore(lore) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error fetching file lore: ${msg}` }], isError: true };
  }
}
