import type { Command } from "commander";
import { populateRepoIndex } from "../../fetcher/populate.js";
import { populateCoChangeFromGit, populateCoChangeFromGitHub } from "../../fetcher/cochange.js";
import { getDb, getIndexStats } from "../../graph/db.js";
import { homedir } from "os";
import path from "path";
import { formatError } from "../errors.js";
import { ProgressReporter } from "../progress.js";
import type { ProviderName } from "../../extract/extract.js";
import { detectRepoFromCwd } from "../../shared/detect-repo.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index [repo]")
    .description("Populate the local graph for a GitHub repo")
    .option("--local-path <path>", "Path to local git clone (enables fast co-change analysis)")
    .option("--depth <shallow|full>", "shallow = last 90 days, full = all history", "shallow")
    .option("--provider <name>", "LLM provider for enrichment: anthropic|gemini|auto|none", "auto")
    .option("--concurrency <n>", "Parallel fetch workers (default: 5)", "5")
    .option("--since <date>", "Only index items updated after this ISO date")
    .option("--no-enrich", "Skip LLM enrichment (faster, no API key needed)")
    .action(async (repo: string | undefined, opts: {
      localPath?: string;
      depth: string;
      provider: string;
      concurrency: string;
      since?: string;
      enrich: boolean;
    }) => {
      if (!repo) {
        repo = (await detectRepoFromCwd()) ?? undefined;
        if (!repo) {
          console.error(
            "\nCould not detect GitHub repo from git remote.\n" +
            "Run from inside a git repo, or pass the repo explicitly:\n" +
            "  git-wik index owner/name\n"
          );
          process.exit(1);
        }
        process.stderr.write(`\nAuto-detected repo: ${repo}\n`);
      }

      const reporter = new ProgressReporter();
      process.stderr.write(`\nIndexing ${repo}...\n`);

      try {
        const provider: ProviderName | "none" = opts.enrich === false ? "none" : (opts.provider as ProviderName);
        const since = opts.since ? new Date(opts.since) : undefined;
        const limit = opts.depth === "shallow" ? 200 : 1000;

        // 1. Bulk index (issues + PRs + labels + milestones)
        const stats = await populateRepoIndex(repo, {
          since,
          limit,
          provider: provider === "none" ? undefined : provider,
          onProgress: (phase, done, total) => {
            reporter.phase(phase, done > 0 ? done : undefined, total > 0 ? total : undefined);
          },
        });
        process.stderr.write("\n");

        // 2. Co-change analysis
        reporter.phase("Building co-change graph…");
        let pairCount = 0;
        if (opts.localPath) {
          pairCount = await populateCoChangeFromGit(repo, opts.localPath);
        } else {
          pairCount = await populateCoChangeFromGitHub(repo, 30);
        }

        // 3. Summary
        const db = getDb(repo);
        const finalStats = getIndexStats(db);
        const [owner, reponame] = repo.split("/");
        const dbPath = path.join(homedir(), ".git-wik", `${owner}-${reponame}`, "graph.db");

        reporter.done(
          `Done. ${finalStats.issues + finalStats.prs} nodes · ${finalStats.edges} edges · ${pairCount} file pairs`
        );
        process.stderr.write(`  Stored: ${dbPath}\n\n`);

        if (!process.env["ANTHROPIC_API_KEY"] && !process.env["GEMINI_API_KEY"] && opts.enrich !== false) {
          process.stderr.write(
            `  Tip: Set ANTHROPIC_API_KEY or GEMINI_API_KEY and run:\n` +
            `       git-wik enrich ${repo}\n` +
            `  to extract decisions, rationale, and constraints from PR discussions.\n\n`
          );
        }
      } catch (err) {
        reporter.error(formatError(err));
        process.exit(1);
      }
    });
}
