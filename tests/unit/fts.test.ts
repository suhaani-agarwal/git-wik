import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../helpers.js";
import { searchIssues, searchPRs, searchAll, searchFilesByPath } from "../../src/graph/fts.js";
import type Database from "better-sqlite3";

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPO = "owner/testrepo";

function insertIssue(db: Database.Database, opts: {
  id: string; number: number; title: string; state?: string; keywords?: string;
}) {
  db.prepare(`
    INSERT OR REPLACE INTO issues (id, repo, number, title, state, body_summary, fetched_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).run(opts.id, REPO, opts.number, opts.title, opts.state ?? "open", Date.now());

  if (opts.keywords) {
    db.prepare(`
      INSERT OR REPLACE INTO node_keywords (node_id, node_type, keywords, updated_at)
      VALUES (?, 'issue', ?, ?)
    `).run(opts.id, opts.keywords, Date.now());
  }
}

function insertPR(db: Database.Database, opts: {
  id: string; number: number; title: string; outcome?: string; keywords?: string;
}) {
  db.prepare(`
    INSERT OR REPLACE INTO pull_requests (id, repo, number, title, state, outcome, fetched_at)
    VALUES (?, ?, ?, ?, 'closed', ?, ?)
  `).run(opts.id, REPO, opts.number, opts.title, opts.outcome ?? "merged", Date.now());

  if (opts.keywords) {
    db.prepare(`
      INSERT OR REPLACE INTO node_keywords (node_id, node_type, keywords, updated_at)
      VALUES (?, 'pr', ?, ?)
    `).run(opts.id, opts.keywords, Date.now());
  }
}

function rebuildFts(db: Database.Database) {
  // Insert into FTS tables from base tables + keywords
  db.exec(`DELETE FROM issues_fts`);
  db.exec(`DELETE FROM prs_fts`);

  const issues = db.prepare("SELECT i.id, i.title, COALESCE(nk.keywords, '') as kw FROM issues i LEFT JOIN node_keywords nk ON nk.node_id = i.id").all() as Array<{ id: string; title: string; kw: string }>;
  for (const row of issues) {
    db.prepare("INSERT INTO issues_fts(id, title, keywords) VALUES (?, ?, ?)").run(row.id, row.title, row.kw);
  }

  const prs = db.prepare("SELECT p.id, p.title, COALESCE(nk.keywords, '') as kw FROM pull_requests p LEFT JOIN node_keywords nk ON nk.node_id = p.id").all() as Array<{ id: string; title: string; kw: string }>;
  for (const row of prs) {
    db.prepare("INSERT INTO prs_fts(id, title, keywords) VALUES (?, ?, ?)").run(row.id, row.title, row.kw);
  }
}

function insertFile(db: Database.Database, path: string) {
  const id = `${REPO}::${path}`;
  db.prepare("INSERT OR REPLACE INTO files (id, repo, path) VALUES (?, ?, ?)").run(id, REPO, path);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("searchIssues", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    insertIssue(db, { id: `${REPO}#1`, number: 1, title: "Add rate limiting middleware", keywords: "rate limiting middleware throttle" });
    insertIssue(db, { id: `${REPO}#2`, number: 2, title: "Fix authentication token refresh", keywords: "auth token refresh jwt" });
    insertIssue(db, { id: `${REPO}#3`, number: 3, title: "Improve database connection pooling", keywords: "database pool connection pg" });
    rebuildFts(db);
  });

  it("finds issues matching the query", () => {
    const results = searchIssues(db, "rate limiting", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.number).toBe(1);
  });

  it("finds issues by keyword match", () => {
    const results = searchIssues(db, "authentication token", 5);
    expect(results.some((r) => r.number === 2)).toBe(true);
  });

  it("returns results sorted best first (score ascending, closer to 0 = better)", () => {
    const results = searchIssues(db, "rate limiting", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i - 1]!.score);
    }
  });

  it("respects limit parameter", () => {
    const results = searchIssues(db, "middleware auth database", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array for empty query", () => {
    const results = searchIssues(db, "", 5);
    expect(results).toEqual([]);
  });

  it("excludes specified IDs", () => {
    const excludeId = `${REPO}#1`;
    const results = searchIssues(db, "rate limiting", 5, [excludeId]);
    expect(results.every((r) => r.id !== excludeId)).toBe(true);
  });

  it("returns empty array gracefully for empty FTS table", () => {
    const emptyDb = makeTestDb();
    const results = searchIssues(emptyDb, "anything", 5);
    expect(results).toEqual([]);
  });
});

describe("searchPRs", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    insertPR(db, { id: `${REPO}#pr#10`, number: 10, title: "Add JWT authentication", outcome: "merged", keywords: "jwt auth token middleware" });
    insertPR(db, { id: `${REPO}#pr#11`, number: 11, title: "Implement rate limiter", outcome: "merged", keywords: "rate limit throttle redis" });
    insertPR(db, { id: `${REPO}#pr#12`, number: 12, title: "Upgrade database driver", outcome: "closed", keywords: "database driver postgres upgrade" });
    rebuildFts(db);
  });

  it("finds PRs matching the query", () => {
    const results = searchPRs(db, "rate limiting", 5);
    expect(results.some((r) => r.number === 11)).toBe(true);
  });

  it("includes outcome in results", () => {
    const results = searchPRs(db, "authentication", 5);
    const pr = results.find((r) => r.number === 10);
    expect(pr?.outcome).toBe("merged");
  });

  it("returns results sorted by BM25 score", () => {
    const results = searchPRs(db, "rate limit throttle", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i - 1]!.score);
    }
  });
});

describe("searchAll", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    insertIssue(db, { id: `${REPO}#1`, number: 1, title: "Auth token refresh failing", keywords: "auth token refresh" });
    insertPR(db, { id: `${REPO}#pr#10`, number: 10, title: "Fix auth token refresh", outcome: "merged", keywords: "auth token refresh fix" });
    rebuildFts(db);
  });

  it("returns both issues and PRs interleaved", () => {
    const results = searchAll(db, "auth token", 5);
    const types = new Set(results.map((r) => r.type));
    expect(types.has("issue")).toBe(true);
    expect(types.has("pr")).toBe(true);
  });

  it("respects limit across combined results", () => {
    const results = searchAll(db, "auth", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("results are sorted by score ascending", () => {
    const results = searchAll(db, "auth token", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i - 1]!.score);
    }
  });
});

describe("searchFilesByPath", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    insertFile(db, "src/auth/index.ts");
    insertFile(db, "src/middleware/rate-limit.ts");
    insertFile(db, "src/routes/users.ts");
  });

  it("finds files by keyword in path", () => {
    const results = searchFilesByPath(db, ["auth"], 5);
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe("src/auth/index.ts");
  });

  it("matches multiple keywords with OR logic", () => {
    const results = searchFilesByPath(db, ["auth", "rate"], 5);
    expect(results.length).toBe(2);
  });

  it("respects limit parameter", () => {
    const results = searchFilesByPath(db, ["src"], 1);
    expect(results.length).toBe(1);
  });

  it("returns empty array for no keywords", () => {
    const results = searchFilesByPath(db, [], 5);
    expect(results).toEqual([]);
  });

  it("returns empty array when no files match", () => {
    const results = searchFilesByPath(db, ["nonexistent"], 5);
    expect(results).toEqual([]);
  });
});
