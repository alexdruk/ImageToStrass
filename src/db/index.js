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

// Foreign keys are off while migrations run (a table rebuild drops and renames a parent table, as
// SQLite's ALTER TABLE documentation says), and checked before they are on again.
function migrate(db) {
  const applied = db.pragma("user_version", { simple: true });
  if (applied >= MIGRATIONS.length) return;

  db.pragma("foreign_keys = OFF");
  try {
    MIGRATIONS.slice(applied).forEach((sql, i) => {
      db.transaction(() => {
        db.exec(sql);
        if (db.pragma("foreign_key_check").length) throw new Error(`Migration ${applied + i + 1} broke a foreign key.`);
        db.pragma(`user_version = ${applied + i + 1}`);
      })();
    });
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
