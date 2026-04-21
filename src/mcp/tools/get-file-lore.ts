import { getFileLore } from "../../intelligence/file-lore.js";
import { formatFileLore } from "../../intelligence/formatter.js";

export const getFileLoreTool = {
  name: "get_file_lore",
  description: `Return the history and context behind a specific file in a GitHub repo.
Shows which PRs changed the file, what decisions were made in those PRs, constraints that apply, and which other files tend to change together (co-change coupling).
Use this to understand why a file exists or is structured the way it is, before making changes.
Only covers data already in the local graph — run \`git-wik index\` to populate context for the repo.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'GitHub repo in "owner/name" format',
      },
      path: {
        type: "string",
        description: "File path relative to repo root, e.g. lib/router/index.js",
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
    const lore = await getFileLore(repo, filePath);
    return { content: [{ type: "text" as const, text: formatFileLore(lore) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error fetching file lore: ${msg}` }], isError: true };
  }
}
