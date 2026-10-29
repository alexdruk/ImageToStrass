import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { localDate, runNightly } from "../src/ops/nightly.js";
import { writeCodeJson } from "../src/prep/archive.js";
import { loadConfig } from "../src/server/config.js";

// The nightly job (spec section 15) on a temporary folder and a temporary IS_LOG_DIR; data/ and the
// real log folder are never touched.

const DAY_MS = 24 * 60 * 60 * 1000;
const quiet = { error() {}, warn() {}, log() {} };

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "is-nightly-"));
  const config = {
    ...loadConfig({ IS_LOG_DIR: path.join(root, "logs") }),
    dataDir: root,
    dbFile: path.join(root, "is.sqlite"),
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    backupDir: path.join(root, "backup")
  };
  const db = openDatabase(config.dbFile);
  return { root, config, db, q: createQueries(db) };
}

function paidCode(q, config, expiresAt) {
  const { code } = q.createCode();
  q.updateCode(code, { status: "paid", paid_at: new Date(Date.parse(expiresAt) - 30 * DAY_MS).toISOString(), delivery_expires_at: expiresAt });
  const zip = path.join(config.deliveryDir, code, `${code}.zip`);
  mkdirSync(path.dirname(zip), { recursive: true });
  writeFileSync(zip, "zip");
  return { code, zip };
}

function archiveFile(config, ...parts) {
  const file = path.join(config.archiveDir, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `kept ${parts.join("/")}\n`);
  return { file, text: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
}

test("expired ZIP deleted, current ZIP kept, code expired; with it its archive folder (D7)", async () => {
  const { root, config, db, q } = setup();
  const now = new Date();
  try {
    const old = paidCode(q, config, new Date(now.getTime() - DAY_MS).toISOString());
    const current = paidCode(q, config, new Date(now.getTime() + 5 * DAY_MS).toISOString());
    // A refunded code keeps its ZIP until its 30 days are over, and stays refunded.
    const refunded = paidCode(q, config, new Date(now.getTime() - DAY_MS).toISOString());
    q.updateCode(refunded.code, { status: "refunded" });
    const gone = [
      archiveFile(config, old.code, "attempt-1", "stones.json"),
      archiveFile(config, old.code, "uploads", "1", "original.png")
    ];
    const kept = [archiveFile(config, current.code, "attempt-1", "stones.json"), archiveFile(config, "PN-0000-0000", "code.json")];

    const result = await runNightly({ db, config, now, log: quiet });

    assert.equal(result.ok, true, result.line);
    assert.equal(existsSync(old.zip), false);
    assert.equal(existsSync(path.dirname(old.zip)), false, "the empty delivery folder is removed");
    assert.equal(existsSync(refunded.zip), false);
    assert.equal(readFileSync(current.zip, "utf8"), "zip");
    assert.equal(result.zips, 2);

    assert.equal(q.getCode(old.code).status, "expired");
    assert.equal(q.getCode(current.code).status, "paid");
    assert.equal(q.getCode(refunded.code).status, "refunded");
    assert.equal(result.expired, 1);
    assert.deepEqual(q.listEvents(old.code).map((e) => e.kind), ["expired"]);
    // Paid 31 days ago: its files go the same day as its ZIP; the row stays.
    for (const file of gone) assert.equal(existsSync(file.file), false);
    assert.equal(existsSync(path.join(config.archiveDir, old.code)), false);
    assert.ok(q.getCode(old.code).files_deleted_at);

    for (const file of kept) {
      assert.equal(readFileSync(file.file, "utf8"), file.text);
      assert.equal(statSync(file.file).mtimeMs, file.mtimeMs);
    }

    // A second run changes nothing.
    const again = await runNightly({ db, config, now, log: quiet });
    assert.equal(again.zips, 0);
    assert.equal(again.expired, 0);
    assert.equal(readFileSync(current.zip, "utf8"), "zip");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup: opens, same row counts; the last 30 are kept", async () => {
  const { root, config, db, q } = setup();
  const now = new Date();
  try {
    for (let i = 0; i < 3; i += 1) q.createCode();
    q.logEvent("test", { detail: "x" });
    mkdirSync(config.backupDir, { recursive: true });
    const older = [];
    for (let i = 31; i >= 1; i -= 1) {
      const name = `is-${localDate(new Date(now.getTime() - i * DAY_MS))}.sqlite`;
      writeFileSync(path.join(config.backupDir, name), "");
      older.push(name);
    }

    const result = await runNightly({ db, config, now, log: quiet });

    const name = `is-${localDate(now)}.sqlite`;
    assert.equal(result.backup.name, name);
    const copy = new Database(path.join(config.backupDir, name), { readonly: true });
    try {
      for (const table of ["codes", "attempts", "etsy_orders", "events"]) {
        const count = (d) => d.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
        assert.equal(count(copy), count(db), table);
      }
      assert.equal(copy.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 3);
    } finally {
      copy.close();
    }

    const left = readdirSync(config.backupDir).sort();
    assert.equal(left.length, 30);
    assert.deepEqual(left, [...older.slice(2), name]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("logs: rotated and emptied, 30 days kept, one summary line", async () => {
  const { root, config, db } = setup();
  const now = new Date();
  const dated = (days) => localDate(new Date(now.getTime() - days * DAY_MS));
  try {
    assert.equal(config.logsDir, path.join(root, "logs"));
    mkdirSync(config.logsDir, { recursive: true });
    const log = (name) => path.join(config.logsDir, name);
    writeFileSync(log("server.log"), "line 1\n");
    writeFileSync(log("tunnel.err.log"), "");
    writeFileSync(log(`server.log.${dated(29)}`), "recent\n");
    writeFileSync(log(`server.log.${dated(30)}`), "old\n");
    writeFileSync(log(`server.log.${dated(40)}`), "older\n");

    const result = await runNightly({ db, config, now, log: quiet });

    assert.equal(result.logs.rotated, 1, "empty logs are not rotated");
    assert.equal(result.logs.deleted, 2);
    assert.equal(readFileSync(log("server.log"), "utf8"), "");
    assert.equal(readFileSync(log(`server.log.${localDate(now)}`), "utf8"), "line 1\n");
    assert.equal(existsSync(log(`server.log.${dated(29)}`)), true);
    assert.equal(existsSync(log(`server.log.${dated(30)}`)), false);

    const summary = readFileSync(log("nightly.log"), "utf8").trim().split("\n");
    assert.equal(summary.length, 1);
    assert.match(summary[0], /nightly: codes expired 0, zips deleted 0, files deleted 0 \(unpaid 0, paid 0\), ip hashes cleared 0, logs rotated 1 .* errors 0$/);

    // A missing log folder is made at start.
    rmSync(config.logsDir, { recursive: true });
    assert.equal((await runNightly({ db, config, now, log: quiet })).ok, true);
    assert.equal(readFileSync(log("nightly.log"), "utf8").trim().split("\n").length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Keeping data (D7, PN-07): dated fake codes. ago(days) is an ISO time that many days before now.
test("keeping data: archive folders deleted on time, never early; rows kept; listing and private portraits untouched", async () => {
  const { root, config, db, q } = setup();
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const MINUTE = 60_000;
  const setCreated = (code, at) => db.prepare("UPDATE codes SET created_at = ? WHERE code = ?").run(at, code);
  const codeWithFiles = (createdAt) => {
    const { code } = q.createCode();
    setCreated(code, createdAt);
    archiveFile(config, code, "uploads", "1", "original.png");
    archiveFile(config, code, "attempt-1", "prepared.png");
    writeCodeJson(config.archiveDir, q.getCode(code));
    return code;
  };
  const paid = (code, paidAt, extra = {}) => q.updateCode(code, {
    status: "paid", paid_at: paidAt, delivery_expires_at: new Date(Date.parse(paidAt) + 30 * DAY_MS).toISOString(), ...extra
  });
  try {
    const c = {
      // Never paid: 30 days after the last activity.
      fresh: codeWithFiles(ago(29)),
      oldButSeen: codeWithFiles(ago(40)),
      oldEvent: codeWithFiles(ago(40)),
      recentDesign: codeWithFiles(ago(40)),
      quiet: codeWithFiles(ago(31)),
      almost: codeWithFiles(new Date(now.getTime() - 30 * DAY_MS + MINUTE).toISOString()),
      running: codeWithFiles(ago(60)),
      // Paid or refunded: 30 days after payment.
      paidRecent: codeWithFiles(ago(40)),
      paidOld: codeWithFiles(ago(40)),
      refunded: codeWithFiles(ago(50)),
      unlocked: codeWithFiles(ago(50))
    };
    q.updateCode(c.oldButSeen, { last_seen_at: ago(29) });
    q.logEvent("upload", { code: c.oldEvent });
    db.prepare("UPDATE events SET at = ? WHERE code = ?").run(ago(31), c.oldEvent);
    q.createAttempt(c.recentDesign, { mode: "colour" });
    db.prepare("UPDATE attempts SET created_at = ?, finished_at = ?, status = 'done' WHERE code = ?").run(ago(12), ago(10), c.recentDesign);
    q.createAttempt(c.running, { mode: "colour" });
    db.prepare("UPDATE attempts SET created_at = ? WHERE code = ?").run(ago(59), c.running);
    q.updateCode(c.quiet, { status: "expired" });
    paid(c.paidRecent, new Date(now.getTime() - 30 * DAY_MS + MINUTE).toISOString());
    paid(c.paidOld, ago(30.5));
    paid(c.refunded, ago(31), { status: "refunded" });
    paid(c.unlocked, ago(45), { delivery_expires_at: new Date(now.getTime() + 5 * DAY_MS).toISOString() });
    q.upsertEtsyOrder({ receipt_id: 1, transaction_id: 11, listing_id: 5, personalization: c.paidOld, matched_code: c.paidOld, status: "paid" });
    const zip = path.join(config.deliveryDir, c.paidOld, `${c.paidOld}.zip`);
    mkdirSync(path.dirname(zip), { recursive: true });
    writeFileSync(zip, "zip");

    // Never touched: data/listing/, data/private-portraits/ and anything in the archive that is
    // not a code of the database.
    const untouched = ["listing/mastiff/ai.png", "private-portraits/one/photo.jpg", "archive/notes.txt", "archive/PN-0000-0000/code.json"]
      .map((rel) => {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, rel);
        return { file, rel, mtimeMs: statSync(file).mtimeMs };
      });
    // Old IP hashes: one made 25 h ago, one 1 h ago.
    const ipOld = q.createCode({ ipHash: "a".repeat(32) }).code;
    setCreated(ipOld, new Date(now.getTime() - 25 * 3600_000).toISOString());
    const ipNew = q.createCode({ ipHash: "b".repeat(32) }).code;
    setCreated(ipNew, new Date(now.getTime() - 3600_000).toISOString());

    const rowsBefore = Object.fromEntries(Object.values(c).map((code) => [code, q.getCode(code)]));
    const result = await runNightly({ db, config, now, log: quiet });
    assert.equal(result.ok, true, result.line);

    const deleted = ["oldEvent", "quiet", "paidOld", "refunded"];
    for (const [name, code] of Object.entries(c)) {
      const gone = deleted.includes(name);
      assert.equal(existsSync(path.join(config.archiveDir, code)), !gone, name);
      assert.equal(Boolean(q.getCode(code).files_deleted_at), gone, name);
      // The row stays, with its status, dates and counts.
      const { files_deleted_at: _f, status: _s, ...rest } = q.getCode(code);
      const { files_deleted_at: _f0, status: _s0, ...restBefore } = rowsBefore[code];
      assert.deepEqual(rest, restBefore, name);
    }
    assert.deepEqual(result.files, { unpaid: 2, paid: 2 });
    assert.equal(existsSync(zip), false, "the paid code's ZIP goes the same day");
    assert.equal(q.getEtsyOrder(11, c.paidOld).matched_code, c.paidOld, "the Etsy order row stays");
    for (const u of untouched) {
      assert.equal(readFileSync(u.file, "utf8"), u.rel);
      assert.equal(statSync(u.file).mtimeMs, u.mtimeMs);
    }
    assert.equal(q.getCode(ipOld).ip_hash, null);
    assert.equal(q.getCode(ipNew).ip_hash, "b".repeat(32));
    assert.equal(result.ips, 1);

    // The summary line has counts only, no code.
    const line = readFileSync(path.join(config.logsDir, "nightly.log"), "utf8").trim();
    assert.match(line, /files deleted 4 \(unpaid 2, paid 2\), ip hashes cleared 1,/);
    assert.doesNotMatch(line, /PN-/);

    // A later change of a deleted code writes no code.json, so its folder is not made again.
    writeCodeJson(config.archiveDir, q.getCode(c.paidOld));
    assert.equal(existsSync(path.join(config.archiveDir, c.paidOld)), false);

    // Two minutes later the two codes that were a minute short of their 30 days go; nothing else.
    const later = await runNightly({ db, config, now: new Date(now.getTime() + 2 * MINUTE), log: quiet });
    assert.deepEqual(later.files, { unpaid: 1, paid: 1 });
    assert.equal(existsSync(path.join(config.archiveDir, c.almost)), false);
    assert.equal(existsSync(path.join(config.archiveDir, c.paidRecent)), false);
    for (const name of ["fresh", "oldButSeen", "recentDesign", "running", "unlocked"]) {
      assert.equal(existsSync(path.join(config.archiveDir, c[name])), true, name);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
