import { Command } from "commander";
import { researchIssue } from "../intelligence/issue.js";
import { getFileLore } from "../intelligence/file-lore.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerEnrichCommand } from "./commands/enrich-cmd.js";
import { registerStatusCommand } from "./commands/status-cmd.js";
import { registerWhyCommand } from "./commands/why-cmd.js";

const program = new Command();

program
  .name("git-wik")
  .description("Local relation graph for GitHub conversation history")
  .version("0.1.0");

// ── Existing commands ──────────────────────────────────────────────────────────

program
  .command("issue <repo> <number>")
  .description("Research a GitHub issue and print structured intelligence")
  .action(async (repo: string, numberStr: string) => {
    const issueNumber = parseInt(numberStr, 10);
    if (isNaN(issueNumber)) {
      console.error("Issue number must be an integer");
      process.exit(1);
    }
    console.error(`Fetching ${repo}#${issueNumber}…`);
    const intel = await researchIssue(repo, issueNumber);
    console.log(JSON.stringify(intel, null, 2));
  });

program
  .command("file <repo> <path>")
  .description("Get the lore for a file in a GitHub repo")
  .action(async (repo: string, filePath: string) => {
    const lore = await getFileLore(repo, filePath);
    console.log(JSON.stringify(lore, null, 2));
  });

program
  .command("serve")
  .description("Start the MCP server on stdio")
  .action(async () => {
    // Dynamically import to avoid loading MCP deps in CLI-only flows
    await import("../mcp/server.js");
  });

// ── New Phase 2 commands ───────────────────────────────────────────────────────

registerIndexCommand(program);
registerEnrichCommand(program);
registerStatusCommand(program);
registerWhyCommand(program);

// ── App server (Phase 4 — dynamic import to avoid loading Hono in non-app paths)

program
  .command("app-server")
  .description("Start the GitHub App webhook server")
  .option("--port <n>", "HTTP port", "3000")
  .option("--secret <s>", "Webhook secret (or set WEBHOOK_SECRET env var)")
  .option("--app-id <id>", "GitHub App ID (or set GH_APP_ID env var)")
  .option("--private-key <path>", "Path to .pem private key (or set GH_PRIVATE_KEY_PATH env var)")
  .action(async (opts: { port: string; secret?: string; appId?: string; privateKey?: string }) => {
    try {
      const { startAppServer } = await import("../app/server.js");
      await startAppServer({
        port: parseInt(opts.port, 10),
        secret: opts.secret ?? process.env["WEBHOOK_SECRET"] ?? "",
        appId: opts.appId ?? process.env["GH_APP_ID"] ?? "",
        privateKeyPath: opts.privateKey ?? process.env["GH_PRIVATE_KEY_PATH"] ?? "",
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot find")) {
        console.error(
          "Error: App server dependencies not installed.\n" +
          "Run: npm install -g hono @hono/node-server @octokit/webhooks @octokit/auth-app"
        );
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
