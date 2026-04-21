import Database from "better-sqlite3";
import { runMigrations } from "../src/graph/migrations.js";

/** Create a fresh in-memory SQLite database with all migrations applied. */
export function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
