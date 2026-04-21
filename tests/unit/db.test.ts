import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../helpers.js";
import {
  upsertIssue,
  upsertPR,
  upsertEdge,
  upsertNodeKeywords,
  getIssue,
  getPR,
  getEdgesFrom,
  getEdgesTo,
  rebuildFts,
  getIndexStats,
  isStale,
  markFetched,
} from "../../src/graph/db.js";

let db: Database.Database;
beforeEach(() => { db = makeTestDb(); });

// ── upsertIssue / getIssue ────────────────────────────────────────────────────

describe("upsertIssue + getIssue", () => {
  it("round-trips an issue", () => {
    upsertIssue(db, {
      id: "test/repo#1", repo: "test/repo", number: 1,
      title: "Test issue", state: "OPEN",
      body_summary: "A test", created_at: null, closed_at: null,
      fetched_at: 1000000, raw_json: null,
    });
    const result = getIssue(db, "test/repo#1");
    expect(result?.title).toBe("Test issue");
    expect(result?.state).toBe("OPEN");
  });

  it("upsert updates mutable fields", () => {
    const base = {
      id: "test/repo#2", repo: "test/repo", number: 2,
      title: "Old title", state: "OPEN",
      body_summary: null, created_at: null, closed_at: null,
      fetched_at: 1000, raw_json: null,
    };
    upsertIssue(db, base);
    upsertIssue(db, { ...base, title: "New title", state: "CLOSED" });
    const result = getIssue(db, "test/repo#2");
    expect(result?.title).toBe("New title");
    expect(result?.state).toBe("CLOSED");
  });
});

// ── upsertPR / getPR ──────────────────────────────────────────────────────────

describe("upsertPR + getPR", () => {
  it("round-trips a PR", () => {
    upsertPR(db, {
      id: "test/repo#pr#1", repo: "test/repo", number: 1,
      title: "Add feature", state: "MERGED", outcome: "merged",
      body_summary: null, merged_at: 2000000, closed_at: null,
      fetched_at: 3000000, raw_json: null,
    });
    const result = getPR(db, "test/repo#pr#1");
    expect(result?.outcome).toBe("merged");
    expect(result?.merged_at).toBe(2000000);
  });
});

// ── CO_CHANGES_WITH weight accumulation ───────────────────────────────────────

describe("CO_CHANGES_WITH edge weight accumulation", () => {
  it("increments weight on duplicate insert", () => {
    const edge = {
      from_type: "file", from_id: "repo::a.ts",
      edge_type: "CO_CHANGES_WITH",
      to_type: "file", to_id: "repo::b.ts",
      weight: 1, metadata_json: null,
    };
    upsertEdge(db, edge);
    upsertEdge(db, edge);
    const edges = getEdgesFrom(db, "file", "repo::a.ts", "CO_CHANGES_WITH");
    expect(edges[0]?.weight).toBe(2);
  });

  it("does not double-count other edge types", () => {
    const edge = {
      from_type: "pr", from_id: "repo#pr#1",
      edge_type: "TOUCHES",
      to_type: "file", to_id: "repo::a.ts",
      weight: 1, metadata_json: null,
    };
    upsertEdge(db, edge);
    upsertEdge(db, edge); // duplicate → ignored
    const edges = getEdgesFrom(db, "pr", "repo#pr#1", "TOUCHES");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.weight).toBe(1);
  });
});

// ── getEdgesFrom / getEdgesTo ─────────────────────────────────────────────────

describe("getEdgesFrom / getEdgesTo", () => {
  it("returns edges filtered by type", () => {
    upsertEdge(db, { from_type: "pr", from_id: "x", edge_type: "TOUCHES", to_type: "file", to_id: "a", weight: 1, metadata_json: null });
    upsertEdge(db, { from_type: "pr", from_id: "x", edge_type: "AUTHORED_BY", to_type: "contributor", to_id: "u1", weight: 1, metadata_json: null });
    const touches = getEdgesFrom(db, "pr", "x", "TOUCHES");
    expect(touches).toHaveLength(1);
    expect(touches[0]?.to_id).toBe("a");
  });

  it("returns all edges when type not specified", () => {
    upsertEdge(db, { from_type: "pr", from_id: "y", edge_type: "TOUCHES", to_type: "file", to_id: "b", weight: 1, metadata_json: null });
    upsertEdge(db, { from_type: "pr", from_id: "y", edge_type: "AUTHORED_BY", to_type: "contributor", to_id: "u2", weight: 1, metadata_json: null });
    expect(getEdgesFrom(db, "pr", "y")).toHaveLength(2);
  });

  it("getEdgesTo finds edges by target", () => {
    upsertEdge(db, { from_type: "pr", from_id: "pr1", edge_type: "FIXES", to_type: "issue", to_id: "iss1", weight: 1, metadata_json: null });
    const edges = getEdgesTo(db, "issue", "iss1", "FIXES");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from_id).toBe("pr1");
  });
});

// ── node_keywords + rebuildFts ────────────────────────────────────────────────

describe("upsertNodeKeywords + rebuildFts", () => {
  it("stores and retrieves keywords", () => {
    upsertNodeKeywords(db, "test/repo#1", "issue", "memory leak auth");
    const row = db
      .prepare("SELECT keywords FROM node_keywords WHERE node_id=?")
      .get("test/repo#1") as { keywords: string } | undefined;
    expect(row?.keywords).toBe("memory leak auth");
  });

  it("rebuildFts does not throw on empty tables", () => {
    expect(() => rebuildFts(db)).not.toThrow();
  });

  it("rebuildFts populates FTS from issues", () => {
    upsertIssue(db, {
      id: "r#1", repo: "r", number: 1,
      title: "Memory leak in auth", state: "OPEN",
      body_summary: null, created_at: null, closed_at: null,
      fetched_at: 1000, raw_json: null,
    });
    upsertNodeKeywords(db, "r#1", "issue", "memory leak auth");
    rebuildFts(db);

    const results = db
      .prepare("SELECT id FROM issues_fts WHERE issues_fts MATCH 'memory'")
      .all() as { id: string }[];
    expect(results.map((r) => r.id)).toContain("r#1");
  });
});

// ── getIndexStats ─────────────────────────────────────────────────────────────

describe("getIndexStats", () => {
  it("returns zeros on empty DB", () => {
    const stats = getIndexStats(db);
    expect(stats.issues).toBe(0);
    expect(stats.prs).toBe(0);
    expect(stats.edges).toBe(0);
  });

  it("counts inserted rows", () => {
    upsertIssue(db, {
      id: "r#1", repo: "r", number: 1, title: "T", state: "OPEN",
      body_summary: null, created_at: null, closed_at: null, fetched_at: 1, raw_json: null,
    });
    const stats = getIndexStats(db);
    expect(stats.issues).toBe(1);
  });
});

// ── TTL helpers ───────────────────────────────────────────────────────────────

describe("isStale / markFetched", () => {
  it("isStale returns true when never fetched", () => {
    expect(isStale(db, "test/repo", "issue:1", 7200)).toBe(true);
  });

  it("isStale returns false immediately after markFetched", () => {
    markFetched(db, "test/repo", "issue:1");
    expect(isStale(db, "test/repo", "issue:1", 7200)).toBe(false);
  });
});
