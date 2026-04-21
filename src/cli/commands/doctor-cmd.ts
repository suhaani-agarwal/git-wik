import type { Command } from "commander";
import { execa } from "execa";
import { access } from "fs/promises";
import path from "path";
import { homedir } from "os";
import { detectRepoFromCwd } from "../../shared/detect-repo.js";

type CheckStatus = "pass" | "warn" | "fail";

function render(status: CheckStatus, label: string, detail: string): string {
  const icon = status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  return `${icon}  ${label}: ${detail}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Validate local git-wik setup and dependencies")
    .action(async () => {
      const lines: string[] = [];
      let hasFailure = false;

      const major = Number(process.versions.node.split(".")[0] ?? "0");
      if (major >= 20) {
        lines.push(render("pass", "Node.js", `${process.versions.node} (requires >=20)`));
      } else {
        lines.push(render("fail", "Node.js", `${process.versions.node} (requires >=20)`));
        hasFailure = true;
      }

      try {
        const { stdout } = await execa("gh", ["--version"]);
        const firstLine = stdout.split("\n")[0] ?? "installed";
        lines.push(render("pass", "GitHub CLI", firstLine));
      } catch {
        lines.push(render("fail", "GitHub CLI", "gh not found. Install from https://cli.github.com/"));
        hasFailure = true;
      }

      try {
        await execa("gh", ["auth", "status"]);
        lines.push(render("pass", "GitHub auth", "gh auth looks valid"));
      } catch {
        lines.push(render("warn", "GitHub auth", "Run `gh auth login` before indexing private repos"));
      }

      const repo = await detectRepoFromCwd();
      if (repo) {
        lines.push(render("pass", "Repo detection", `found ${repo}`));
        const [owner, repoName] = repo.split("/");
        const dbPath = path.join(homedir(), ".git-wik", `${owner}-${repoName}`, "graph.db");
        const dbExists = await pathExists(dbPath);
        if (dbExists) {
          lines.push(render("pass", "Indexed graph", dbPath));
        } else {
          lines.push(render("warn", "Indexed graph", `missing (${dbPath}). Run: git-wik index ${repo}`));
        }
      } else {
        lines.push(render("warn", "Repo detection", "not in a GitHub repo directory"));
      }

      const mcpPath = path.resolve(process.cwd(), ".mcp.json");
      const hasMcpConfig = await pathExists(mcpPath);
      if (hasMcpConfig) {
        lines.push(render("pass", "MCP config", `${mcpPath} exists`));
      } else {
        lines.push(render("warn", "MCP config", "missing .mcp.json (run `git-wik init-mcp`)"));
      }

      process.stdout.write("\n");
      process.stdout.write(lines.join("\n"));
      process.stdout.write("\n\n");

      if (hasFailure) {
        process.stdout.write("git-wik doctor found blocking issues.\n");
        process.exit(1);
      } else {
        process.stdout.write("git-wik doctor completed. Non-blocking WARN checks are optional improvements.\n");
      }
    });
}
