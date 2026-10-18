import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeCode } from "../src/db/codes.js";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";

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
    assert.equal(db.pragma("user_version", { simple: true }), 1);
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
  assert.equal(q.getCode("IS-0000-0000"), null);
});

test("updateCode changes allowed columns only", () => {
  const { q } = fresh();
  const { code } = q.createCode();

  assert.ok(q.updateCode(code, { status: "paid", paid_at: "2026-10-18T11:00:00.000Z", receipt_id: 42 }));
  assert.equal(q.getCode(code).status, "paid");
  assert.equal(q.getCode(code).receipt_id, 42);

  assert.throws(() => q.updateCode(code, { code: "IS-0000-0000" }), /Unknown column/);
  assert.throws(() => q.updateCode(code, { "status = 'paid' --": 1 }), /Unknown column/);
  assert.throws(() => q.updateCode(code, { status: "bogus" }), /CHECK constraint/);
  assert.equal(q.updateCode("IS-0000-0000", { downloads: 1 }), false);
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
  assert.throws(() => q.createAttempt("IS-0000-0000", null), /FOREIGN KEY/);
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
    () => q.upsertEtsyOrder({ receipt_id: 3, transaction_id: 31, matched_code: "IS-0000-0000" }),
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
  assert.equal(q.countedAttempts("IS-0000-0000"), 0);
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
    assert.equal(db.pragma("user_version", { simple: true }), 1);
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
