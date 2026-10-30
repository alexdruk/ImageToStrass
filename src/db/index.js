import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA } from "./schema.js";

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
  migrate(db);

  return db;
}

function migrate(db) {
  const applied = db.pragma("user_version", { simple: true });

  MIGRATIONS.slice(applied).forEach((sql, i) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${applied + i + 1}`);
    })();
  });
}
