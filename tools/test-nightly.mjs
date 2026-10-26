import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { localDate, runNightly } from "../src/ops/nightly.js";
import { loadConfig } from "../src/server/config.js";

// The nightly job (spec section 15) on a temporary folder; data/ and logs/ are never touched.

const DAY_MS = 24 * 60 * 60 * 1000;
const quiet = { error() {}, warn() {}, log() {} };

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "is-nightly-"));
  const config = {
    ...loadConfig({}),
    dataDir: root,
    dbFile: path.join(root, "is.sqlite"),
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    backupDir: path.join(root, "backup"),
    logsDir: path.join(root, "logs")
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

test("expired ZIP deleted, current ZIP kept, archive untouched, code expired", async () => {
  const { root, config, db, q } = setup();
  const now = new Date();
  try {
    const old = paidCode(q, config, new Date(now.getTime() - DAY_MS).toISOString());
    const current = paidCode(q, config, new Date(now.getTime() + 5 * DAY_MS).toISOString());
    // A refunded code keeps its ZIP until its 30 days are over, and stays refunded.
    const refunded = paidCode(q, config, new Date(now.getTime() - DAY_MS).toISOString());
    q.updateCode(refunded.code, { status: "refunded" });
    const kept = [
      archiveFile(config, old.code, "attempt-1", "stones.json"),
      archiveFile(config, old.code, "uploads", "1", "original.png"),
      archiveFile(config, "PN-0000-0000", "code.json")
    ];

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
    assert.equal(JSON.parse(readFileSync(path.join(config.archiveDir, old.code, "code.json"), "utf8")).status, "expired");
    assert.deepEqual(q.listEvents(old.code).map((e) => e.kind), ["expired"]);

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

test("logs: rotated and emptied, 14 days kept, one summary line", async () => {
  const { root, config, db } = setup();
  const now = new Date();
  const dated = (days) => localDate(new Date(now.getTime() - days * DAY_MS));
  try {
    mkdirSync(config.logsDir, { recursive: true });
    const log = (name) => path.join(config.logsDir, name);
    writeFileSync(log("server.log"), "line 1\n");
    writeFileSync(log("tunnel.err.log"), "");
    writeFileSync(log(`server.log.${dated(13)}`), "recent\n");
    writeFileSync(log(`server.log.${dated(14)}`), "old\n");
    writeFileSync(log(`server.log.${dated(40)}`), "older\n");

    const result = await runNightly({ db, config, now, log: quiet });

    assert.equal(result.logs.rotated, 1, "empty logs are not rotated");
    assert.equal(result.logs.deleted, 2);
    assert.equal(readFileSync(log("server.log"), "utf8"), "");
    assert.equal(readFileSync(log(`server.log.${localDate(now)}`), "utf8"), "line 1\n");
    assert.equal(existsSync(log(`server.log.${dated(13)}`)), true);
    assert.equal(existsSync(log(`server.log.${dated(14)}`)), false);

    const summary = readFileSync(log("nightly.log"), "utf8").trim().split("\n");
    assert.equal(summary.length, 1);
    assert.match(summary[0], /nightly: codes expired 0, zips deleted 0, logs rotated 1 .* errors 0$/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
