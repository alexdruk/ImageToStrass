import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

// Opens (and creates if needed) the IS database. ":memory:" is accepted for tests.
export function openDatabase(file) {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }

  const db = new Database(file);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  return db;
}
