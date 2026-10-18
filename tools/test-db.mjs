import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeCode } from "../src/db/codes.js";
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

  q.insertEtsyOrder({ receipt_id: 1, transaction_id: 11, listing_id: 5, personalization: code, matched_code: code });
  q.insertEtsyOrder({ receipt_id: 2, transaction_id: 21, listing_id: 5, personalization: "hello" });

  const unmatched = q.listUnmatchedOrders();
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].receipt_id, 2);
  assert.equal(unmatched[0].personalization, "hello");
  assert.ok(unmatched[0].seen_at);

  assert.throws(
    () => q.insertEtsyOrder({ receipt_id: 3, transaction_id: 31, matched_code: "IS-0000-0000" }),
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
