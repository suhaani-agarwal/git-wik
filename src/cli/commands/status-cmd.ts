import type { Command } from "commander";
import { getDb, getIndexStats } from "../../graph/db.js";
import { homedir } from "os";
import path from "path";
import { statSync } from "fs";

export function registerStatusCommand(program: Command): void {
  program
    .command("status <repo>")
    .description("Show what's indexed for a repo")
    .action((repo: string) => {
      try {
        const db = getDb(repo);
        const stats = getIndexStats(db);

        const [owner, reponame] = repo.split("/");
        const dbPath = path.join(
          homedir(), ".git-wik", `${owner}-${reponame}`, "graph.db"
        );

        let dbSize = "unknown";
        try {
          const s = statSync(dbPath);
          dbSize = (s.size / 1024 / 1024).toFixed(1) + " MB";
        } catch { /* db not on disk (e.g., in-memory) */ }

        // Get last index timestamps
        const syncRows = db
          .prepare("SELECT resource_type, last_fetched_at FROM sync_state WHERE repo=?")
          .all(repo) as Array<{ resource_type: string; last_fetched_at: number }>;

        const syncMap = new Map(syncRows.map((r) => [r.resource_type, r.last_fetched_at]));
        const fmt = (ts: number | undefined) =>
          ts ? new Date(ts * 1000).toLocaleString() : "never";

        // Enrichment coverage
        const enrichedCount = (db
          .prepare("SELECT COUNT(*) as n FROM pull_requests WHERE repo=? AND body_summary LIKE '{%'")
          .get(repo) as { n: number }).n;

        const unenriched = stats.prs - enrichedCount;

        console.log(`
Repository: ${repo}
Database:   ${dbPath} (${dbSize})

Nodes:
  Issues:       ${stats.issues.toLocaleString()}  (last indexed: ${fmt(syncMap.get("repo:index"))})
  PRs:          ${stats.prs.toLocaleString()}  (last indexed: ${fmt(syncMap.get("repo:index"))})
  Files:        ${stats.files.toLocaleString()}
  Decisions:    ${stats.decisions.toLocaleString()}
  Constraints:  ${stats.constraints.toLocaleString()}
  Contributors: ${stats.contributors.toLocaleString()}

Edges:          ${stats.edges.toLocaleString()}

Enrichment:
  Enriched PRs: ${enrichedCount}/${stats.prs}
  Unenriched:   ${unenriched > 0 ? unenriched + "  (run: git-wik enrich " + repo + ")" : "none"}

Co-change:
  Last built (git):    ${fmt(syncMap.get("repo:cochange:git"))}
  Last built (github): ${fmt(syncMap.get("repo:cochange:gh"))}
`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("no such table")) {
          console.error(`No data indexed for ${repo}. Run: git-wik index ${repo}`);
        } else {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    });
}
