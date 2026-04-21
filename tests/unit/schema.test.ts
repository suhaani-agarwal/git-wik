import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/graph/migrations.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

describe("runMigrations", () => {
  it("creates all expected tables", () => {
    const db = freshDb();
    runMigrations(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    const expected = [
      "schema_version",
      "issues",
      "pull_requests",
      "files",
      "decisions",
      "constraints",
      "contributors",
      "rejected_alternatives",
      "edges",
      "sync_state",
      "node_keywords",
      "commits",
      "labels",
      "milestones",
    ];
    for (const t of expected) {
      expect(tables, `expected table "${t}" to exist`).toContain(t);
    }
  });

  it("creates FTS5 virtual tables", () => {
    const db = freshDb();
    runMigrations(db);

    const vtables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'"
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(vtables).toContain("issues_fts");
    expect(vtables).toContain("prs_fts");
  });

  it("is idempotent — running twice does not throw", () => {
    const db = freshDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("tracks schema version correctly", () => {
    const db = freshDb();
    runMigrations(db);

    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number };
    expect(row.v).toBe(2); // v1 + v2
  });

  it("does not re-run already-applied migrations", () => {
    const db = freshDb();
    runMigrations(db);

    // Insert a row so we can detect if issues table was recreated
    db.prepare(
      "INSERT INTO issues VALUES ('repo#1','repo',1,'Test','OPEN',null,null,null,1000000,null)"
    ).run();

    // Run again — should NOT clear the table
    runMigrations(db);

    const count = (
      db.prepare("SELECT COUNT(*) as n FROM issues").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});
