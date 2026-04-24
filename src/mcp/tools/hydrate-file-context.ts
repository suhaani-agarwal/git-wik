import type Database from "better-sqlite3";
import { populateFromPR } from "../../fetcher/populate.js";

const PR_TIMEOUT_MS = 4000;

interface HydrationOptions {
  maxPrHydrations?: number;
  targetTouchEdges?: number;
}

function getTouchEdgeCount(db: Database.Database, fileId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as n FROM edges WHERE edge_type='TOUCHES' AND to_type='file' AND to_id=?"
    )
    .get(fileId) as { n: number };
  return row.n;
}

function listCandidatePRNumbers(
  db: Database.Database,
  repo: string,
  filePath: string,
  limit = 80
): number[] {
  const baseName = filePath.split("/").pop() ?? filePath;
  const stem = baseName.includes(".") ? baseName.slice(0, baseName.lastIndexOf(".")) : baseName;
  const likeStem = `%${stem}%`;
  const likeBase = `%${baseName}%`;

  const titleHits = db
    .prepare(
      `SELECT number
       FROM pull_requests
       WHERE repo = ? AND (title LIKE ? OR title LIKE ?)
       ORDER BY COALESCE(merged_at, closed_at, fetched_at) DESC
       LIMIT 30`
    )
    .all(repo, likeStem, likeBase) as Array<{ number: number }>;

  const recents = db
    .prepare(
      `SELECT number
       FROM pull_requests
       WHERE repo = ?
       ORDER BY COALESCE(merged_at, closed_at, fetched_at) DESC
       LIMIT ?`
    )
    .all(repo, limit) as Array<{ number: number }>;

  const seen = new Set<number>();
  const merged = [...titleHits, ...recents]
    .map((r) => r.number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  return merged;
}

async function populateWithTimeout(repo: string, prNumber: number): Promise<void> {
  await Promise.race([
    populateFromPR(repo, prNumber, { provider: "auto" }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("hydration timeout")), PR_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Opportunistically hydrates a bounded number of recent PRs so file queries
 * can answer with useful context without requiring full enrichment.
 * Each PR fetch is capped at 4s; errors and timeouts are skipped, not thrown.
 */
export async function hydrateFileContextIfSparse(
  db: Database.Database,
  repo: string,
  filePath: string,
  opts: HydrationOptions = {}
): Promise<{ hydratedPRs: number; touchEdges: number }> {
  const maxPrHydrations = opts.maxPrHydrations ?? 12;
  const targetTouchEdges = opts.targetTouchEdges ?? 2;
  const fileId = `${repo}::${filePath}`;

  let touchEdges = getTouchEdgeCount(db, fileId);
  if (touchEdges >= targetTouchEdges) {
    return { hydratedPRs: 0, touchEdges };
  }

  const candidates = listCandidatePRNumbers(db, repo, filePath);
  let hydratedPRs = 0;

  for (const prNumber of candidates) {
    if (hydratedPRs >= maxPrHydrations) break;
    try {
      await populateWithTimeout(repo, prNumber);
      hydratedPRs++;
    } catch {
      // timeout or error — skip and continue
    }
    touchEdges = getTouchEdgeCount(db, fileId);
    if (touchEdges >= targetTouchEdges) break;
  }

  return { hydratedPRs, touchEdges };
}
