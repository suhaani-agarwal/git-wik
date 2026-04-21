import type Database from "better-sqlite3";
import { buildFtsQuery } from "../shared/keywords.js";

// ── Result types ───────────────────────────────────────────────────────────────

export interface FtsIssueResult {
  id: string;
  number: number;
  title: string;
  state: string;
  score: number;         // BM25 score (negative: closer to 0 = more relevant)
}

export interface FtsPRResult {
  id: string;
  number: number;
  title: string;
  outcome: string | null;
  score: number;
}

export type FtsResult = (FtsIssueResult & { type: "issue" }) | (FtsPRResult & { type: "pr" });

// ── Search functions ───────────────────────────────────────────────────────────

/**
 * BM25 full-text search against indexed issues.
 * Returns results sorted by relevance (best first).
 *
 * @param db       The repo database
 * @param query    Natural-language query (will be converted to FTS5 MATCH syntax)
 * @param limit    Max results (default: 5)
 * @param exclude  Issue IDs to exclude from results
 */
export function searchIssues(
  db: Database.Database,
  query: string,
  limit = 5,
  exclude: string[] = []
): FtsIssueResult[] {
  if (!query.trim()) return [];

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    // bm25() returns negative values — ORDER BY score ASC = best first
    const placeholders = exclude.map(() => "?").join(",");
    const excludeClause = exclude.length > 0
      ? `AND i.id NOT IN (${placeholders})`
      : "";

    const rows = db.prepare(`
      SELECT
        i.id,
        i.number,
        i.title,
        i.state,
        bm25(issues_fts) AS score
      FROM issues_fts
      JOIN issues i ON issues_fts.id = i.id
      WHERE issues_fts MATCH ?
        ${excludeClause}
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, ...exclude, limit) as FtsIssueResult[];

    return rows;
  } catch {
    // FTS5 MATCH syntax errors are possible if query has special chars
    return [];
  }
}

/**
 * BM25 full-text search against indexed PRs.
 */
export function searchPRs(
  db: Database.Database,
  query: string,
  limit = 5,
  exclude: string[] = []
): FtsPRResult[] {
  if (!query.trim()) return [];

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const placeholders = exclude.map(() => "?").join(",");
    const excludeClause = exclude.length > 0
      ? `AND p.id NOT IN (${placeholders})`
      : "";

    const rows = db.prepare(`
      SELECT
        p.id,
        p.number,
        p.title,
        p.outcome,
        bm25(prs_fts) AS score
      FROM prs_fts
      JOIN pull_requests p ON prs_fts.id = p.id
      WHERE prs_fts MATCH ?
        ${excludeClause}
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, ...exclude, limit) as FtsPRResult[];

    return rows;
  } catch {
    return [];
  }
}

/**
 * Search both issues and PRs, interleave by relevance score.
 */
export function searchAll(
  db: Database.Database,
  query: string,
  limit = 5
): FtsResult[] {
  const issues = searchIssues(db, query, limit).map(
    (r) => ({ ...r, type: "issue" as const })
  );
  const prs = searchPRs(db, query, limit).map(
    (r) => ({ ...r, type: "pr" as const })
  );

  // Merge and sort by score ascending (best = closest to 0)
  return [...issues, ...prs]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

/**
 * Find files whose path contains any of the given keywords.
 * Used for path-based context matching in find_implementation_context.
 */
export function searchFilesByPath(
  db: Database.Database,
  keywords: string[],
  limit = 5
): Array<{ id: string; path: string }> {
  if (keywords.length === 0) return [];

  // Build: path LIKE '%kw1%' OR path LIKE '%kw2%'
  const clauses = keywords.map(() => "path LIKE ?").join(" OR ");
  const params = keywords.map((k) => `%${k}%`);

  try {
    return db.prepare(
      `SELECT id, path FROM files WHERE (${clauses}) LIMIT ?`
    ).all(...params, limit) as Array<{ id: string; path: string }>;
  } catch {
    return [];
  }
}

/**
 * Find issues/PRs that share HAS_LABEL edges with the given label names.
 * Returns items grouped by shared label, sorted by recency.
 */
export function findCoClusteredItems(
  db: Database.Database,
  repo: string,
  labelNames: string[],
  limit = 5
): FtsResult[] {
  if (labelNames.length === 0) return [];

  const labelIds = labelNames.map((n) => `${repo}::${n}`);
  const placeholders = labelIds.map(() => "?").join(",");

  try {
    // Issues sharing any of the labels
    const issues = db.prepare(`
      SELECT DISTINCT i.id, i.number, i.title, i.state,
        -1.0 AS score
      FROM edges e
      JOIN issues i ON e.from_id = i.id
      WHERE e.edge_type = 'HAS_LABEL'
        AND e.to_id IN (${placeholders})
        AND e.from_type = 'issue'
      ORDER BY i.created_at DESC
      LIMIT ?
    `).all(...labelIds, limit) as FtsIssueResult[];

    // PRs sharing any of the labels
    const prs = db.prepare(`
      SELECT DISTINCT p.id, p.number, p.title, p.outcome,
        -0.9 AS score
      FROM edges e
      JOIN pull_requests p ON e.from_id = p.id
      WHERE e.edge_type = 'HAS_LABEL'
        AND e.to_id IN (${placeholders})
        AND e.from_type = 'pr'
      ORDER BY p.merged_at DESC NULLS LAST
      LIMIT ?
    `).all(...labelIds, limit) as FtsPRResult[];

    return [
      ...issues.map((r) => ({ ...r, type: "issue" as const })),
      ...prs.map((r) => ({ ...r, type: "pr" as const })),
    ].slice(0, limit);
  } catch {
    return [];
  }
}
