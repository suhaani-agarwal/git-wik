import type { Command } from "commander";
import { readFile, writeFile } from "fs/promises";
import path from "path";

type McpServerConfig = {
  command: string;
  args: string[];
};

type McpConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

function getDefaultServerConfig(): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", "git-wik", "serve"],
  };
}

export function registerInitMcpCommand(program: Command): void {
  program
    .command("init-mcp")
    .description("Create or update .mcp.json with git-wik server config")
    .option("--target <path>", "Path to mcp config file", ".mcp.json")
    .option("--force", "Overwrite existing mcpServers.git-wik entry")
    .option("--print", "Print generated config instead of writing file")
    .action(async (opts: { target: string; force?: boolean; print?: boolean }) => {
      const targetPath = path.resolve(process.cwd(), opts.target);
      const serverConfig = getDefaultServerConfig();
      let baseConfig: McpConfig = {};

      try {
        const existingRaw = await readFile(targetPath, "utf8");
        const parsed = JSON.parse(existingRaw) as McpConfig;
        baseConfig = parsed && typeof parsed === "object" ? parsed : {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ENOENT")) {
          console.error(`Error: Could not parse existing config at ${targetPath}`);
          console.error("Fix the JSON and retry, or choose a different --target path.");
          process.exit(1);
        }
      }

      const existing = baseConfig.mcpServers?.["git-wik"];
      if (existing && !opts.force) {
        console.error(
          `Error: mcpServers.git-wik already exists in ${targetPath}.\n` +
          "Use --force to overwrite this entry."
        );
        process.exit(1);
      }

      const nextConfig: McpConfig = {
        ...baseConfig,
        mcpServers: {
          ...(baseConfig.mcpServers ?? {}),
          "git-wik": serverConfig,
        },
      };

      const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
      if (opts.print) {
        process.stdout.write(serialized);
        return;
      }

      await writeFile(targetPath, serialized, "utf8");
      process.stdout.write(`Wrote MCP config to ${targetPath}\n`);
      process.stdout.write("You can now use git-wik via MCP clients (Cursor/Claude) in this project.\n");
    });
}
