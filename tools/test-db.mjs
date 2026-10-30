import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeCode } from "../src/db/codes.js";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { MIGRATIONS, SCHEMA } from "../src/db/schema.js";

function fresh() {
  const db = openDatabase(":memory:");
  return { db, q: createQueries(db) };
}

test("the database file is created in WAL mode with all tables", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "is-db-"));

  try {
    const db = openDatabase(path.join(dir, "sub", "is.sqlite"));
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
    assert.deepEqual(tables, ["attempts", "codes", "etsy_orders", "events"]);
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    db.close();

    // Opening again keeps the data and does not fail on the existing schema.
    const again = openDatabase(path.join(dir, "sub", "is.sqlite"));
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCode stores a new open code", () => {
  const { q } = fresh();
  const row = q.createCode({ ipHash: "abc", consentAt: "2026-10-18T10:00:00.000Z" });

  assert.equal(normalizeCode(row.code), row.code);
  assert.equal(row.status, "open");
  assert.equal(row.attempts_used, 0);
  assert.equal(row.downloads, 0);
  assert.equal(row.selected_attempt, null);
  assert.equal(row.ip_hash, "abc");
  assert.ok(q.codeExists(row.code));
  assert.deepEqual(q.getCode(row.code), row);
  assert.equal(q.getCode("PN-0000-0000"), null);
});

test("updateCode changes allowed columns only", () => {
  const { q } = fresh();
  const { code } = q.createCode();

  assert.ok(q.updateCode(code, { status: "paid", paid_at: "2026-10-18T11:00:00.000Z", receipt_id: 42 }));
  assert.equal(q.getCode(code).status, "paid");
  assert.equal(q.getCode(code).receipt_id, 42);

  assert.throws(() => q.updateCode(code, { code: "PN-0000-0000" }), /Unknown column/);
  assert.throws(() => q.updateCode(code, { "status = 'paid' --": 1 }), /Unknown column/);
  assert.throws(() => q.updateCode(code, { status: "bogus" }), /CHECK constraint/);
  assert.equal(q.updateCode("PN-0000-0000", { downloads: 1 }), false);
});

test("attempts are numbered per code and keep settings and results as JSON", () => {
  const { q } = fresh();
  const { code } = q.createCode();
  const other = q.createCode().code;

  const first = q.createAttempt(code, { sizeMm: 200, unit: "mm", mode: "colour" });
  const second = q.createAttempt(code, { sizeMm: 250, unit: "mm", mode: "bw" });
  const otherFirst = q.createAttempt(other, null);

  assert.equal(first.n, 1);
  assert.equal(second.n, 2);
  assert.equal(otherFirst.n, 1);
  assert.equal(first.status, "queued");
  assert.equal(first.counts, 0);
  assert.deepEqual(first.settings, { sizeMm: 200, unit: "mm", mode: "colour" });

  assert.ok(q.updateAttempt(code, 1, {
    status: "done",
    stage: "Preparing files",
    result: { stones: 2150, tier: 1.4 },
    counts: 1,
    finished_at: "2026-10-18T12:00:00.000Z"
  }));

  const done = q.getAttempt(code, 1);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { stones: 2150, tier: 1.4 });
  assert.equal(done.counts, 1);

  assert.deepEqual(q.listAttempts(code).map((a) => a.n), [1, 2]);
  assert.equal(q.getAttempt(code, 9), null);
  assert.throws(() => q.updateAttempt(code, 2, { status: "lost" }), /CHECK constraint/);
  assert.throws(() => q.updateAttempt(code, 2, { n: 5 }), /Unknown column/);
});

test("attempts need an existing code", () => {
  const { q } = fresh();
  assert.throws(() => q.createAttempt("PN-0000-0000", null), /FOREIGN KEY/);
});

test("etsy orders: unmatched orders are listed", () => {
  const { q } = fresh();
  const { code } = q.createCode();

  q.upsertEtsyOrder({ receipt_id: 1, transaction_id: 11, listing_id: 5, personalization: code, matched_code: code });
  q.upsertEtsyOrder({ receipt_id: 2, transaction_id: 21, listing_id: 5, personalization: "hello" });

  const unmatched = q.listUnmatchedOrders();
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].receipt_id, 2);
  assert.equal(unmatched[0].personalization, "hello");
  assert.ok(unmatched[0].seen_at);

  assert.throws(
    () => q.upsertEtsyOrder({ receipt_id: 3, transaction_id: 31, matched_code: "PN-0000-0000" }),
    /FOREIGN KEY/
  );
});

test("events are logged per code", () => {
  const { q } = fresh();
  const { code } = q.createCode();

  q.logEvent("code-created", { code });
  q.logEvent("attempt-queued", { code, detail: { n: 1 } });
  q.logEvent("poller-run");

  const events = q.listEvents(code);
  assert.deepEqual(events.map((e) => e.kind), ["code-created", "attempt-queued"]);
  assert.equal(events[1].detail, '{"n":1}');
});

test("attempt numbers are never reused and only counted attempts use the limit", () => {
  const { q } = fresh();
  const { code } = q.createCode();

  for (const counts of [1, 0, 0, 1]) {
    const { n } = q.createAttempt(code, null);
    q.updateAttempt(code, n, { status: counts ? "done" : "failed", counts });
  }

  assert.deepEqual(q.listAttempts(code).map((a) => a.n), [1, 2, 3, 4]);
  assert.equal(q.countedAttempts(code), 2);
  assert.equal(q.createAttempt(code, null).n, 5);
  assert.equal(q.countedAttempts("PN-0000-0000"), 0);
});

test("etsy orders: one row per (transaction, code); re-polls upsert", () => {
  const { db, q } = fresh();
  const a = q.createCode().code;
  const b = q.createCode().code;
  const count = () => db.prepare("SELECT COUNT(*) FROM etsy_orders").pluck().get();

  // Two codes in one personalization, then a re-poll of the same transaction.
  for (const status of ["paid", "refunded"]) {
    q.upsertEtsyOrder({ receipt_id: 1, transaction_id: 11, personalization: `${a} ${b}`, matched_code: a, status });
    q.upsertEtsyOrder({ receipt_id: 1, transaction_id: 11, personalization: `${a} ${b}`, matched_code: b, status });
  }
  assert.equal(count(), 2);
  assert.deepEqual(
    db.prepare("SELECT matched_code, status FROM etsy_orders ORDER BY rowid").all(),
    [{ matched_code: a, status: "refunded" }, { matched_code: b, status: "refunded" }]
  );

  // No code: one NULL row, also upserted.
  const first = q.upsertEtsyOrder({ receipt_id: 2, transaction_id: 21, personalization: "hello" });
  const again = q.upsertEtsyOrder({ receipt_id: 2, transaction_id: 21, personalization: "hello again" });
  assert.equal(first.id, again.id);
  assert.equal(again.personalization, "hello again");
  assert.equal(again.matched_code, null);
  assert.equal(count(), 3);
});

test("migration 1 de-duplicates an IS-01 etsy_orders table and adds the unique key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "is-db-"));
  const file = path.join(dir, "is.sqlite");

  try {
    // An IS-01 database: no unique key, user_version 0, duplicate rows from re-polls.
    const old = new Database(file);
    old.exec(`CREATE TABLE etsy_orders (
      receipt_id INTEGER NOT NULL, transaction_id INTEGER NOT NULL, listing_id INTEGER,
      personalization TEXT, matched_code TEXT, paid_at TEXT, status TEXT, seen_at TEXT NOT NULL)`);
    const insert = old.prepare(
      "INSERT INTO etsy_orders (receipt_id, transaction_id, matched_code, status, seen_at) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run(1, 11, null, "old", "t1");
    insert.run(1, 11, null, "new", "t2");
    insert.run(2, 21, "IS-AAAA-AAAA", "old", "t1");
    insert.run(2, 21, "IS-AAAA-AAAA", "new", "t2");
    insert.run(2, 21, "IS-BBBB-BBBB", "only", "t1");
    old.close();

    const db = openDatabase(file);
    assert.equal(db.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(
      db.prepare("SELECT transaction_id, matched_code, status FROM etsy_orders ORDER BY rowid").all(),
      [
        { transaction_id: 11, matched_code: null, status: "new" },
        { transaction_id: 21, matched_code: "IS-AAAA-AAAA", status: "new" },
        { transaction_id: 21, matched_code: "IS-BBBB-BBBB", status: "only" }
      ]
    );
    assert.throws(
      () => db.prepare("INSERT INTO etsy_orders (receipt_id, transaction_id, seen_at) VALUES (1, 11, 't3')").run(),
      /UNIQUE/
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PN-08 (buy first) was rolled back. Its migration 5, word for word (ea08d2a src/db/schema.js), as
// the live database ran it on 30 Oct 2026.
const PN08_MIGRATION_5 =
`CREATE TABLE codes_new (
     code                TEXT PRIMARY KEY,
     created_at          TEXT NOT NULL,
     ip_hash             TEXT,
     consent_at          TEXT,
     attempts_used       INTEGER NOT NULL DEFAULT 0,
     selected_attempt    INTEGER,
     status              TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'prepaid', 'paid', 'refunded', 'expired')),
     paid_at             TEXT,
     receipt_id          INTEGER,
     transaction_id      INTEGER,
     downloads           INTEGER NOT NULL DEFAULT 0,
     delivery_expires_at TEXT,
     last_seen_at        TEXT,
     files_deleted_at    TEXT,
     undeliverable_at    TEXT,
     redeemed_at         TEXT
   );
   INSERT INTO codes_new (code, created_at, ip_hash, consent_at, attempts_used, selected_attempt, status,
     paid_at, receipt_id, transaction_id, downloads, delivery_expires_at, last_seen_at, files_deleted_at,
     undeliverable_at)
   SELECT code, created_at, ip_hash, consent_at, attempts_used, selected_attempt, status,
     paid_at, receipt_id, transaction_id, downloads, delivery_expires_at, last_seen_at, files_deleted_at,
     undeliverable_at FROM codes;
   DROP TABLE codes;
   ALTER TABLE codes_new RENAME TO codes;
   CREATE INDEX codes_ip_created ON codes(ip_hash, created_at);
   CREATE INDEX codes_receipt ON codes(receipt_id);
   ALTER TABLE etsy_orders ADD COLUMN quantity INTEGER;`;

test("a database that ran PN-08's migration 5 opens, keeps every row, and stays in step for migration 6", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "is-db-"));
  const file = path.join(dir, "is.sqlite");
  try {
    // PN-07's schema and migrations 1-4, then PN-08's 5 (run with foreign keys off, as PN-08 did).
    const pn07 = new Database(file);
    pn07.exec(SCHEMA);
    for (const sql of MIGRATIONS.slice(0, 4)) pn07.exec(sql);
    pn07.pragma("foreign_keys = OFF");
    pn07.exec(PN08_MIGRATION_5);
    pn07.pragma("user_version = 5");
    pn07.prepare("INSERT INTO codes (code, created_at, status) VALUES ('PN-AAAA-AAAA', '2026-10-26T17:00:00.000Z', 'open')").run();
    pn07.prepare(`INSERT INTO codes (code, created_at, status, paid_at, receipt_id, transaction_id, redeemed_at)
      VALUES ('PN-BBBB-BBBB', '2026-10-30T16:31:12.262Z', 'prepaid', '2026-10-30T16:15:22.000Z', 4215498171, 5271944060, '2026-10-30T16:31:12.262Z')`).run();
    pn07.prepare(`INSERT INTO etsy_orders (receipt_id, transaction_id, listing_id, personalization, matched_code, paid_at, status, seen_at, quantity)
      VALUES (4215498171, 5271944060, 4605055466, '', 'PN-BBBB-BBBB', '2026-10-30T16:15:22.000Z', 'paid', '2026-10-30T16:31:12.263Z', 1)`).run();
    pn07.close();

    const db = openDatabase(file);
    const q = createQueries(db);
    // Nothing to run: both kinds of database are at the same version, so a migration 6 runs on both.
    assert.equal(MIGRATIONS.length, 5);
    assert.equal(db.pragma("user_version", { simple: true }), MIGRATIONS.length);
    assert.equal(openDatabase(":memory:").pragma("user_version", { simple: true }), MIGRATIONS.length);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    // Every row kept; the prepaid code is read as it is (no PN-07 code writes 'prepaid').
    assert.deepEqual(db.prepare("SELECT code, status FROM codes ORDER BY code").all(),
      [{ code: "PN-AAAA-AAAA", status: "open" }, { code: "PN-BBBB-BBBB", status: "prepaid" }]);
    assert.equal(q.getCode("PN-BBBB-BBBB").receipt_id, 4215498171);
    assert.equal(db.prepare("SELECT matched_code FROM etsy_orders").pluck().get(), "PN-BBBB-BBBB");
    // The extra columns are harmless: PN-07's writes leave them NULL.
    const made = q.createCode({ ipHash: "h", consentAt: "2026-10-30T18:00:00.000Z" });
    assert.equal(q.getCode(made.code).status, "open");
    q.updateCode("PN-AAAA-AAAA", { status: "paid", paid_at: "2026-10-30T18:00:00.000Z", receipt_id: 1, transaction_id: 2 });
    q.upsertEtsyOrder({ receipt_id: 1, transaction_id: 2, listing_id: 3, personalization: "PN-AAAA-AAAA", matched_code: "PN-AAAA-AAAA", paid_at: "2026-10-30T18:00:00.000Z", status: "paid", seen_at: "2026-10-30T18:00:00.000Z" });
    assert.equal(db.prepare("SELECT quantity FROM etsy_orders WHERE transaction_id = 2").pluck().get(), null);
    db.close();
    // Opened again: still 5, nothing changed.
    const again = openDatabase(file);
    assert.equal(again.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 3);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
