import type Database from "better-sqlite3";

// ── V1: existing schema ────────────────────────────────────────────────────────

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS issues (
  id           TEXT    PRIMARY KEY,
  repo         TEXT    NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  state        TEXT    NOT NULL,
  body_summary TEXT,
  created_at   INTEGER,
  closed_at    INTEGER,
  fetched_at   INTEGER NOT NULL,
  raw_json     TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id           TEXT    PRIMARY KEY,
  repo         TEXT    NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  state        TEXT    NOT NULL,
  outcome      TEXT,
  body_summary TEXT,
  merged_at    INTEGER,
  closed_at    INTEGER,
  fetched_at   INTEGER NOT NULL,
  raw_json     TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id           TEXT    PRIMARY KEY,
  repo         TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT    PRIMARY KEY,
  repo         TEXT    NOT NULL,
  problem      TEXT    NOT NULL,
  choice       TEXT    NOT NULL,
  rationale    TEXT,
  confidence   REAL    NOT NULL,
  extracted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS constraints (
  id                TEXT    PRIMARY KEY,
  repo              TEXT    NOT NULL,
  text              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active',
  status_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS contributors (
  id           TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  username     TEXT NOT NULL,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS rejected_alternatives (
  id               TEXT PRIMARY KEY,
  repo             TEXT NOT NULL,
  pr_id            TEXT NOT NULL,
  option_text      TEXT NOT NULL,
  rejection_reason TEXT,
  rejected_by      TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type     TEXT    NOT NULL,
  from_id       TEXT    NOT NULL,
  edge_type     TEXT    NOT NULL,
  to_type       TEXT    NOT NULL,
  to_id         TEXT    NOT NULL,
  weight        REAL    NOT NULL DEFAULT 1.0,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sync_state (
  repo            TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  last_fetched_at INTEGER,
  PRIMARY KEY (repo, resource_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(from_type, from_id, edge_type, to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_from
  ON edges(from_type, from_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_to
  ON edges(to_type, to_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_issues_repo_num
  ON issues(repo, number);
CREATE INDEX IF NOT EXISTS idx_prs_repo_num
  ON pull_requests(repo, number);
`;

// ── V2: FTS5 search + keyword index + new node tables ─────────────────────────

const SCHEMA_V2 = `
-- FTS5 virtual tables for similarity search (BM25 ranking, no embeddings needed).
-- Standalone (no content= directive) because the base tables lack a 'keywords'
-- column — keywords are stored separately in node_keywords. We populate and
-- maintain these tables entirely manually via triggers and rebuildFts().
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  id       UNINDEXED,
  title,
  keywords,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS prs_fts USING fts5(
  id       UNINDEXED,
  title,
  keywords,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Keep FTS in sync with base tables (single-row upsert path).
-- Standalone FTS5: use INSERT ... VALUES ('delete', ...) with the table name
-- as a special command to remove rows before re-inserting on update/delete.
-- Bulk indexing calls rebuildFts() instead for 30% better throughput.
CREATE TRIGGER IF NOT EXISTS issues_fts_ai
  AFTER INSERT ON issues BEGIN
    INSERT INTO issues_fts(rowid, id, title, keywords)
    VALUES (new.rowid, new.id, new.title, '');
  END;

CREATE TRIGGER IF NOT EXISTS issues_fts_au
  AFTER UPDATE ON issues BEGIN
    DELETE FROM issues_fts WHERE rowid = old.rowid;
    INSERT INTO issues_fts(rowid, id, title, keywords)
    VALUES (new.rowid, new.id, new.title, '');
  END;

CREATE TRIGGER IF NOT EXISTS issues_fts_ad
  AFTER DELETE ON issues BEGIN
    DELETE FROM issues_fts WHERE rowid = old.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS prs_fts_ai
  AFTER INSERT ON pull_requests BEGIN
    INSERT INTO prs_fts(rowid, id, title, keywords)
    VALUES (new.rowid, new.id, new.title, '');
  END;

CREATE TRIGGER IF NOT EXISTS prs_fts_au
  AFTER UPDATE ON pull_requests BEGIN
    DELETE FROM prs_fts WHERE rowid = old.rowid;
    INSERT INTO prs_fts(rowid, id, title, keywords)
    VALUES (new.rowid, new.id, new.title, '');
  END;

CREATE TRIGGER IF NOT EXISTS prs_fts_ad
  AFTER DELETE ON pull_requests BEGIN
    DELETE FROM prs_fts WHERE rowid = old.rowid;
  END;

-- Separate keywords table (migration-safe: cannot ALTER TABLE with non-constant
-- defaults in SQLite, so keywords live in their own table).
CREATE TABLE IF NOT EXISTS node_keywords (
  node_id    TEXT    NOT NULL,
  node_type  TEXT    NOT NULL,  -- 'issue' | 'pr'
  keywords   TEXT    NOT NULL,  -- space-separated lowercase tokens
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, node_type)
);

-- Commit nodes for commit→issue / commit→file links
CREATE TABLE IF NOT EXISTS commits (
  id          TEXT    PRIMARY KEY,  -- "{repo}::{sha}"
  repo        TEXT    NOT NULL,
  sha         TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  author      TEXT,
  authored_at INTEGER,
  fetched_at  INTEGER NOT NULL
);

-- Label nodes for grouping/clustering (HAS_LABEL edges)
CREATE TABLE IF NOT EXISTS labels (
  id    TEXT PRIMARY KEY,  -- "{repo}::{name}"
  repo  TEXT NOT NULL,
  name  TEXT NOT NULL,
  color TEXT
);

-- Milestone nodes for grouping (IN_MILESTONE edges)
CREATE TABLE IF NOT EXISTS milestones (
  id     TEXT    PRIMARY KEY,  -- "{repo}::milestone::{number}"
  repo   TEXT    NOT NULL,
  number INTEGER NOT NULL,
  title  TEXT    NOT NULL,
  state  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commits_repo
  ON commits(repo, authored_at);
CREATE INDEX IF NOT EXISTS idx_labels_repo
  ON labels(repo);
CREATE INDEX IF NOT EXISTS idx_milestones_repo
  ON milestones(repo, number);
CREATE INDEX IF NOT EXISTS idx_node_keywords_type
  ON node_keywords(node_type, node_id);
`;

// ── Migration runner ───────────────────────────────────────────────────────────

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => db.exec(SCHEMA_V1),
  },
  {
    version: 2,
    up: (db) => db.exec(SCHEMA_V2),
  },
];

export function runMigrations(db: Database.Database): void {
  // Bootstrap the version tracker
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`
  );

  const row = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };
  const current = row?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      migration.up(db);
      db.prepare("INSERT OR REPLACE INTO schema_version VALUES (?)").run(
        migration.version
      );
    }
  }
}
