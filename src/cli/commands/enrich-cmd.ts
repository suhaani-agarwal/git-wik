import type { Command } from "commander";
import { getDb } from "../../graph/db.js";
import { fetchPRWithDetails } from "../../fetcher/gh.js";
import { shouldEnrich } from "../../fetcher/populate.js";
import { buildPRThreadText } from "../../fetcher/parse.js";
import { extractThread, createProvider } from "../../extract/extract.js";
import type { ProviderName } from "../../extract/extract.js";
import { ProgressReporter } from "../progress.js";
import { formatError } from "../errors.js";
import type Database from "better-sqlite3";

export function registerEnrichCommand(program: Command): void {
  program
    .command("enrich <repo>")
    .description("Run LLM enrichment over indexed PRs to extract decisions and constraints")
    .option("--provider <name>", "anthropic|gemini|auto (default: auto)", "auto")
    .option("--force", "Re-enrich already-enriched items")
    .option("--limit <n>", "Max items to enrich in this run", "200")
    .action(async (repo: string, opts: {
      provider: string;
      force: boolean;
      limit: string;
    }) => {
      const reporter = new ProgressReporter();
      const provider = opts.provider as ProviderName;
      const limitN = parseInt(opts.limit, 10);

      // Check provider availability first
      const p = createProvider(provider);
      if (!p) {
        process.stderr.write(
          `\nNo LLM API key found for provider "${provider}".\n` +
          `Set ANTHROPIC_API_KEY or GEMINI_API_KEY and retry.\n\n`
        );
        process.exit(1);
      }

      process.stderr.write(`\nEnriching ${repo} with ${p.name}...\n`);

      try {
        const db = getDb(repo);

        // Find PRs needing enrichment
        const query = opts.force
          ? `SELECT id, number FROM pull_requests WHERE repo=? AND state='MERGED' LIMIT ?`
          : `SELECT id, number FROM pull_requests WHERE repo=? AND state='MERGED' AND (body_summary IS NULL OR body_summary NOT LIKE '{%') LIMIT ?`;

        const prs = db.prepare(query).all(repo, limitN) as Array<{ id: string; number: number }>;

        if (prs.length === 0) {
          process.stderr.write(`  Nothing to enrich. Run: git-wik index ${repo} first.\n\n`);
          return;
        }

        process.stderr.write(`  Items to enrich: ${prs.length} PRs\n`);

        let enriched = 0;
        let skipped = 0;

        for (let i = 0; i < prs.length; i++) {
          const prStub = prs[i]!;
          reporter.progress("Enriching", i + 1, prs.length);

          try {
            const pr = await fetchPRWithDetails(repo, prStub.number);
            if (!pr || !shouldEnrich(pr)) {
              skipped++;
              continue;
            }

            const threadText = buildPRThreadText(pr);
            const result = await extractThread(threadText, provider);

            if (result.confidence >= 0.4 && result.choice_made) {
              const summary = JSON.stringify({
                problem: result.problem_statement,
                choice: result.choice_made,
                rationale: result.rationale,
                confidence: result.confidence,
                constraints: result.constraints,
                rejected: result.rejected_alternatives,
              }).slice(0, 500);

              db.prepare("UPDATE pull_requests SET body_summary=? WHERE id=?")
                .run(summary, prStub.id);
              enriched++;
            } else {
              skipped++;
            }
          } catch {
            skipped++;
          }
        }

        reporter.done(`Done. Enriched: ${enriched} · Skipped: ${skipped}`);
      } catch (err) {
        reporter.error(formatError(err));
        process.exit(1);
      }
    });
}
