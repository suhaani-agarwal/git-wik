import Database from "better-sqlite3";
import { homedir } from "os";
import { mkdirSync } from "fs";
import path from "path";
import { runMigrations } from "./migrations.js";

// ── Node interfaces ────────────────────────────────────────────────────────────

export interface IssueNode {
  id: string;           // "{repo}#{number}"
  repo: string;
  number: number;
  title: string;
  state: string;
  body_summary: string | null;
  created_at: number | null;
  closed_at: number | null;
  fetched_at: number;
  raw_json: string | null;
}

export interface PRNode {
  id: string;           // "{repo}#pr#{number}"
  repo: string;
  number: number;
  title: string;
  state: string;
  outcome: string | null;
  body_summary: string | null;
  merged_at: number | null;
  closed_at: number | null;
  fetched_at: number;
  raw_json: string | null;
}

export interface FileNode {
  id: string;           // "{repo}::{path}"
  repo: string;
  path: string;
  last_seen_at: number | null;
}

export interface DecisionNode {
  id: string;
  repo: string;
  problem: string;
  choice: string;
  rationale: string | null;
  confidence: number;
  extracted_at: number;
}

export interface ConstraintNode {
  id: string;
  repo: string;
  text: string;
  status: string;
  status_checked_at: number | null;
}

export interface ContributorNode {
  id: string;           // "{repo}::{username}"
  repo: string;
  username: string;
  display_name: string | null;
}

export interface RejectedAltNode {
  id: string;
  repo: string;
  pr_id: string;
  option_text: string;
  rejection_reason: string | null;
  rejected_by: string | null;
}

export interface EdgeRow {
  id: number;
  from_type: string;
  from_id: string;
  edge_type: string;
  to_type: string;
  to_id: string;
  weight: number;
  metadata_json: string | null;
  created_at: number;
}

// ── New node interfaces (v2 schema) ───────────────────────────────────────────

export interface CommitNode {
  id: string;          // "{repo}::{sha}"
  repo: string;
  sha: string;
  message: string;
  author: string | null;
  authored_at: number | null;
  fetched_at: number;
}

export interface LabelNode {
  id: string;          // "{repo}::{name}"
  repo: string;
  name: string;
  color: string | null;
}

export interface MilestoneNode {
  id: string;          // "{repo}::milestone::{number}"
  repo: string;
  number: number;
  title: string;
  state: string;
}

export interface IndexStats {
  issues: number;
  prs: number;
  files: number;
  decisions: number;
  constraints: number;
  contributors: number;
  edges: number;
}

// ── Singleton ──────────────────────────────────────────────────────────────────

const instances = new Map<string, Database.Database>();
// Per-repo write lock: serialises concurrent webhook writes within Node's single thread
const writeLocks = new Map<string, Promise<void>>();

export function getDb(repo: string): Database.Database {
  if (instances.has(repo)) return instances.get(repo)!;

  const [owner, reponame] = repo.split("/");
  const dir = path.join(homedir(), ".git-wik", `${owner}-${reponame}`);
  mkdirSync(dir, { recursive: true });

  const db = new Database(path.join(dir, "graph.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  instances.set(repo, db);
  return db;
}

/** Serialise async write operations per-repo (prevents WAL conflicts in App server). */
export async function withWriteLock<T>(
  repo: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = writeLocks.get(repo) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  writeLocks.set(repo, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
    if (writeLocks.get(repo) === next) writeLocks.delete(repo);
  }
}

// ── TTL helpers ────────────────────────────────────────────────────────────────

export function isStale(
  db: Database.Database,
  repo: string,
  resourceType: string,
  ttlSeconds: number
): boolean {
  const row = db
    .prepare(
      "SELECT last_fetched_at FROM sync_state WHERE repo=? AND resource_type=?"
    )
    .get(repo, resourceType) as { last_fetched_at: number } | undefined;
  if (!row?.last_fetched_at) return true;
  return Math.floor(Date.now() / 1000) - row.last_fetched_at > ttlSeconds;
}

export function markFetched(
  db: Database.Database,
  repo: string,
  resourceType: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO sync_state(repo, resource_type, last_fetched_at) VALUES(?,?,?)"
  ).run(repo, resourceType, Math.floor(Date.now() / 1000));
}

// ── Upsert helpers ─────────────────────────────────────────────────────────────

export function upsertIssue(db: Database.Database, issue: IssueNode): void {
  db.prepare(`
    INSERT INTO issues (id,repo,number,title,state,body_summary,created_at,closed_at,fetched_at,raw_json)
    VALUES (@id,@repo,@number,@title,@state,@body_summary,@created_at,@closed_at,@fetched_at,@raw_json)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, state=excluded.state, body_summary=excluded.body_summary,
      created_at=excluded.created_at, closed_at=excluded.closed_at,
      fetched_at=excluded.fetched_at, raw_json=excluded.raw_json
  `).run(issue);
}

export function upsertPR(db: Database.Database, pr: PRNode): void {
  db.prepare(`
    INSERT INTO pull_requests (id,repo,number,title,state,outcome,body_summary,merged_at,closed_at,fetched_at,raw_json)
    VALUES (@id,@repo,@number,@title,@state,@outcome,@body_summary,@merged_at,@closed_at,@fetched_at,@raw_json)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, state=excluded.state, outcome=excluded.outcome,
      body_summary=excluded.body_summary, merged_at=excluded.merged_at,
      closed_at=excluded.closed_at, fetched_at=excluded.fetched_at, raw_json=excluded.raw_json
  `).run(pr);
}

export function upsertFile(db: Database.Database, file: FileNode): void {
  db.prepare(`
    INSERT INTO files (id,repo,path,last_seen_at)
    VALUES (@id,@repo,@path,@last_seen_at)
    ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at
  `).run(file);
}

export function upsertDecision(db: Database.Database, d: DecisionNode): void {
  db.prepare(`
    INSERT INTO decisions (id,repo,problem,choice,rationale,confidence,extracted_at)
    VALUES (@id,@repo,@problem,@choice,@rationale,@confidence,@extracted_at)
    ON CONFLICT(id) DO UPDATE SET
      problem=excluded.problem, choice=excluded.choice, rationale=excluded.rationale,
      confidence=excluded.confidence, extracted_at=excluded.extracted_at
  `).run(d);
}

export function upsertConstraint(
  db: Database.Database,
  c: ConstraintNode
): void {
  db.prepare(`
    INSERT INTO constraints (id,repo,text,status,status_checked_at)
    VALUES (@id,@repo,@text,@status,@status_checked_at)
    ON CONFLICT(id) DO UPDATE SET
      text=excluded.text, status=excluded.status,
      status_checked_at=excluded.status_checked_at
  `).run(c);
}

export function upsertContributor(
  db: Database.Database,
  c: ContributorNode
): void {
  db.prepare(`
    INSERT INTO contributors (id,repo,username,display_name)
    VALUES (@id,@repo,@username,@display_name)
    ON CONFLICT(id) DO UPDATE SET
      display_name=COALESCE(excluded.display_name, contributors.display_name)
  `).run(c);
}

export function upsertRejectedAlt(
  db: Database.Database,
  ra: RejectedAltNode
): void {
  db.prepare(`
    INSERT INTO rejected_alternatives (id,repo,pr_id,option_text,rejection_reason,rejected_by)
    VALUES (@id,@repo,@pr_id,@option_text,@rejection_reason,@rejected_by)
    ON CONFLICT(id) DO UPDATE SET
      option_text=excluded.option_text, rejection_reason=excluded.rejection_reason,
      rejected_by=excluded.rejected_by
  `).run(ra);
}

export function upsertEdge(
  db: Database.Database,
  edge: Omit<EdgeRow, "id" | "created_at">
): void {
  const now = Math.floor(Date.now() / 1000);
  if (edge.edge_type === "CO_CHANGES_WITH") {
    // Insert with weight=0 so that the UPDATE below always adds exactly 1
    // per call, regardless of whether this is the first or nth occurrence.
    db.prepare(`
      INSERT OR IGNORE INTO edges(from_type,from_id,edge_type,to_type,to_id,weight,metadata_json,created_at)
      VALUES(@from_type,@from_id,@edge_type,@to_type,@to_id,0,@metadata_json,@created_at)
    `).run({ ...edge, created_at: now });
    db.prepare(`
      UPDATE edges SET weight = weight + 1
      WHERE from_type=@from_type AND from_id=@from_id AND edge_type=@edge_type
        AND to_type=@to_type AND to_id=@to_id
    `).run(edge);
  } else {
    db.prepare(`
      INSERT INTO edges(from_type,from_id,edge_type,to_type,to_id,weight,metadata_json,created_at)
      VALUES(@from_type,@from_id,@edge_type,@to_type,@to_id,@weight,@metadata_json,@created_at)
      ON CONFLICT(from_type,from_id,edge_type,to_type,to_id) DO UPDATE SET
        weight=excluded.weight,
        metadata_json=COALESCE(excluded.metadata_json, edges.metadata_json)
    `).run({ ...edge, created_at: now });
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export function getIssue(
  db: Database.Database,
  id: string
): IssueNode | undefined {
  return db
    .prepare("SELECT * FROM issues WHERE id=?")
    .get(id) as IssueNode | undefined;
}

export function getPR(
  db: Database.Database,
  id: string
): PRNode | undefined {
  return db
    .prepare("SELECT * FROM pull_requests WHERE id=?")
    .get(id) as PRNode | undefined;
}

export function getDecision(
  db: Database.Database,
  id: string
): DecisionNode | undefined {
  return db
    .prepare("SELECT * FROM decisions WHERE id=?")
    .get(id) as DecisionNode | undefined;
}

export function getConstraint(
  db: Database.Database,
  id: string
): ConstraintNode | undefined {
  return db
    .prepare("SELECT * FROM constraints WHERE id=?")
    .get(id) as ConstraintNode | undefined;
}

export function getContributor(
  db: Database.Database,
  id: string
): ContributorNode | undefined {
  return db
    .prepare("SELECT * FROM contributors WHERE id=?")
    .get(id) as ContributorNode | undefined;
}

export function getRejectedAlt(
  db: Database.Database,
  id: string
): RejectedAltNode | undefined {
  return db
    .prepare("SELECT * FROM rejected_alternatives WHERE id=?")
    .get(id) as RejectedAltNode | undefined;
}

export function getEdgesFrom(
  db: Database.Database,
  fromType: string,
  fromId: string,
  edgeType?: string
): EdgeRow[] {
  if (edgeType) {
    return db
      .prepare(
        "SELECT * FROM edges WHERE from_type=? AND from_id=? AND edge_type=?"
      )
      .all(fromType, fromId, edgeType) as EdgeRow[];
  }
  return db
    .prepare("SELECT * FROM edges WHERE from_type=? AND from_id=?")
    .all(fromType, fromId) as EdgeRow[];
}

export function getEdgesTo(
  db: Database.Database,
  toType: string,
  toId: string,
  edgeType?: string
): EdgeRow[] {
  if (edgeType) {
    return db
      .prepare(
        "SELECT * FROM edges WHERE to_type=? AND to_id=? AND edge_type=?"
      )
      .all(toType, toId, edgeType) as EdgeRow[];
  }
  return db
    .prepare("SELECT * FROM edges WHERE to_type=? AND to_id=?")
    .all(toType, toId) as EdgeRow[];
}

// ── V2 upsert helpers ──────────────────────────────────────────────────────────

export function upsertCommit(db: Database.Database, c: CommitNode): void {
  db.prepare(`
    INSERT INTO commits (id,repo,sha,message,author,authored_at,fetched_at)
    VALUES (@id,@repo,@sha,@message,@author,@authored_at,@fetched_at)
    ON CONFLICT(id) DO UPDATE SET
      message=excluded.message, author=excluded.author,
      authored_at=excluded.authored_at, fetched_at=excluded.fetched_at
  `).run(c);
}

export function upsertLabel(db: Database.Database, l: LabelNode): void {
  db.prepare(`
    INSERT INTO labels (id,repo,name,color)
    VALUES (@id,@repo,@name,@color)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color
  `).run(l);
}

export function upsertMilestone(db: Database.Database, m: MilestoneNode): void {
  const safeTitle = typeof m.title === "string" && m.title.trim()
    ? m.title
    : `Milestone ${m.number}`;
  const safeState = typeof m.state === "string" && m.state.trim()
    ? m.state
    : "open";
  const normalized: MilestoneNode = {
    ...m,
    title: safeTitle,
    state: safeState,
  };
  db.prepare(`
    INSERT INTO milestones (id,repo,number,title,state)
    VALUES (@id,@repo,@number,@title,@state)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, state=excluded.state
  `).run(normalized);
}

export function upsertNodeKeywords(
  db: Database.Database,
  nodeId: string,
  nodeType: "issue" | "pr",
  keywords: string
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO node_keywords (node_id,node_type,keywords,updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(node_id,node_type) DO UPDATE SET
      keywords=excluded.keywords, updated_at=excluded.updated_at
  `).run(nodeId, nodeType, keywords, now);
}

// ── FTS helpers ────────────────────────────────────────────────────────────────

/**
 * Rebuild FTS5 indexes from scratch.
 * Call after bulk inserts instead of relying on per-row triggers — ~30% faster.
 * keywords is pulled from node_keywords table and merged in.
 */
export function rebuildFts(db: Database.Database): void {
  // Standalone FTS5 tables — clear all rows then re-insert from base tables +
  // node_keywords. Use the special single-argument DELETE to clear FTS without
  // content-table sync (which would error because issues lacks a 'keywords' col).
  db.exec(`DELETE FROM issues_fts`);
  db.prepare(`
    INSERT INTO issues_fts(rowid, id, title, keywords)
    SELECT i.rowid, i.id, i.title, COALESCE(nk.keywords, '')
    FROM issues i
    LEFT JOIN node_keywords nk ON nk.node_id = i.id AND nk.node_type = 'issue'
  `).run();

  db.exec(`DELETE FROM prs_fts`);
  db.prepare(`
    INSERT INTO prs_fts(rowid, id, title, keywords)
    SELECT p.rowid, p.id, p.title, COALESCE(nk.keywords, '')
    FROM pull_requests p
    LEFT JOIN node_keywords nk ON nk.node_id = p.id AND nk.node_type = 'pr'
  `).run();
}

// ── Stats ──────────────────────────────────────────────────────────────────────

export function getIndexStats(db: Database.Database): IndexStats {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
  return {
    issues:       count("issues"),
    prs:          count("pull_requests"),
    files:        count("files"),
    decisions:    count("decisions"),
    constraints:  count("constraints"),
    contributors: count("contributors"),
    edges:        count("edges"),
  };
}
