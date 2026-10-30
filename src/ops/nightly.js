// The nightly job (spec section 15), run by launchd (com.is.nightly) at 03:30, or by hand:
//   node src/ops/nightly.js
// 0. prepaid codes (PN-08) with no pick 30 days after their Etsy payment get their latest design
//    (D6): paid, the 30-day download starts now, ZIP built; with no design they wait (control panel);
// 1. paid codes whose 30 days are over become expired;
// 2. delivery ZIPs (data/delivery/<code>/) of codes whose delivery_expires_at has passed are deleted,
//    and the folder with them when it is empty;
// 3. keeping data (D7): a code's archive folder (data/archive/<code>/: its uploads, attempt files and
//    code.json) is deleted IS_KEEP_UNPAID_DAYS (30) after its last activity when it was never paid,
//    and IS_KEEP_PAID_DAYS (30) after payment when it was paid or refunded, the same day as its
//    delivery ZIP (never while prepaid: a prepaid code's files go when the download that starts at its
//    pick ends); the code row and its Etsy orders stay, files_deleted_at set. Hashed IPs older than
//    24 h are cleared (spec 13);
// 4. *.log in the log folder (IS_LOG_DIR, ~/Library/Logs/PatternNifty) are rotated (copied to <name>.log.YYYY-MM-DD, then emptied; 30 days kept);
// 5. data/is.sqlite is copied with SQLite's online backup to data/backup/is-YYYY-MM-DD.sqlite (30 kept);
// 6. one summary line (counts only, no codes) goes to nightly.log in the log folder.
// In data/archive/ only folders named after a code of the database are deleted, never anything
// else; data/listing/ and data/private-portraits/ are never touched.

import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync,
  rmSync, statSync, truncateSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { openDatabase } from "../db/index.js";
import { createQueries } from "../db/queries.js";
import { loadConfig } from "../server/config.js";
import { createDelivery } from "../server/delivery.js";
import { createLimits } from "../server/limits.js";

export const LOG_DAYS = 30;
const CODE_FOLDER = /^(PN|IS)-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
export const BACKUPS_KEPT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");
// The Mac's local date, YYYY-MM-DD.
export const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// D6 for prepaid codes (PN-08): the latest done design of each prepaid code paid PREPAID_PICK_DAYS
// ago or more, unless a design is still queued or running. Returns { delivered, waiting }.
export const PREPAID_PICK_DAYS = 30;
async function deliverPrepaid({ q, delivery, now }) {
  const out = { delivered: 0, waiting: 0 };
  const builds = [];
  for (const code of q.listPrepaidCodesPaidBefore(new Date(now.getTime() - PREPAID_PICK_DAYS * DAY_MS).toISOString())) {
    const attempts = q.listAttempts(code);
    const done = attempts.filter((a) => a.status === "done");
    if (!done.length || attempts.some((a) => a.status === "queued" || a.status === "running")) {
      out.waiting += 1;
      continue;
    }
    const picked = delivery.pickPrepaid(code, done[done.length - 1].n, { how: "auto", now });
    if (picked) {
      out.delivered += 1;
      builds.push(picked.build);
    }
  }
  await Promise.all(builds);
  return out;
}

function expireCodes({ q, delivery, now }) {
  let expired = 0;
  for (const code of q.listExpiredPaidCodes(now.toISOString())) {
    if (delivery.markExpired(code, { now })) expired += 1;
  }
  return expired;
}

function deleteExpiredZips({ q, deliveryDir, now }) {
  let deleted = 0;
  if (!existsSync(deliveryDir)) return deleted;

  for (const entry of readdirSync(deliveryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const expiresAt = q.getCode(entry.name)?.delivery_expires_at;
    if (!expiresAt || Date.parse(expiresAt) > now.getTime()) continue;

    const dir = path.join(deliveryDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".zip")) continue;
      rmSync(path.join(dir, file));
      deleted += 1;
    }
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  }
  return deleted;
}

// When a code's files are due (D7): IS_KEEP_PAID_DAYS after payment (and never before its download
// ends, which an admin unlock can move), else IS_KEEP_UNPAID_DAYS after its last activity.
export function filesDueAt(row, { keepUnpaidDays, keepPaidDays }) {
  // Prepaid (PN-08): paid, but its download has not started; kept until 30 days after the pick.
  if (row.status === "prepaid") return Infinity;
  if (row.paid_at) {
    const afterPayment = Date.parse(row.paid_at) + keepPaidDays * DAY_MS;
    return Math.max(afterPayment, row.delivery_expires_at ? Date.parse(row.delivery_expires_at) : 0);
  }
  return Date.parse(row.last_active_at) + keepUnpaidDays * DAY_MS;
}

function deleteOldFiles({ q, config, now }) {
  const deleted = { unpaid: 0, paid: 0 };
  for (const row of q.listKeptCodes()) {
    if (row.active || !(filesDueAt(row, config) <= now.getTime())) continue;
    // Only a folder directly under data/archive/ named after the code (PN- or IS- code).
    if (!CODE_FOLDER.test(row.code)) continue;
    rmSync(path.join(config.archiveDir, row.code), { recursive: true, force: true });
    q.updateCode(row.code, { files_deleted_at: now.toISOString() });
    deleted[row.paid_at ? "paid" : "unpaid"] += 1;
  }
  return deleted;
}

// Copy-then-empty, so launchd keeps writing to the same open file.
function rotateLogs({ logsDir, now }) {
  let rotated = 0;
  let deleted = 0;
  if (!existsSync(logsDir)) return { rotated, deleted };

  const today = localDate(now);
  for (const file of readdirSync(logsDir)) {
    const from = path.join(logsDir, file);
    if (!file.endsWith(".log") || !statSync(from).isFile() || statSync(from).size === 0) continue;
    const to = `${from}.${today}`;
    // Run twice on one day: the second part is added to the first.
    if (existsSync(to)) appendFileSync(to, readFileSync(from));
    else copyFileSync(from, to);
    truncateSync(from, 0);
    rotated += 1;
  }

  const oldest = localDate(new Date(now.getTime() - LOG_DAYS * DAY_MS));
  for (const file of readdirSync(logsDir)) {
    const date = file.match(/\.log\.(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (date && date <= oldest) {
      rmSync(path.join(logsDir, file));
      deleted += 1;
    }
  }
  return { rotated, deleted };
}

async function backupDatabase({ db, backupDir, now }) {
  mkdirSync(backupDir, { recursive: true });
  const name = `is-${localDate(now)}.sqlite`;
  const tmp = path.join(backupDir, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  await db.backup(tmp);
  // The copy is a single file: out of WAL mode, so opening it leaves no -wal or -shm beside it.
  const copy = new Database(tmp);
  copy.pragma("journal_mode = DELETE");
  copy.close();
  renameSync(tmp, path.join(backupDir, name));

  const all = readdirSync(backupDir).filter((f) => /^is-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  const old = all.slice(0, Math.max(0, all.length - BACKUPS_KEPT));
  for (const file of old) rmSync(path.join(backupDir, file));
  return { name, deleted: old.length };
}

// Each step runs even when an earlier one failed; the summary counts the failures.
export async function runNightly({ db, config, now = new Date(), log = console }) {
  mkdirSync(config.logsDir, { recursive: true });
  const q = createQueries(db);
  const delivery = createDelivery({ q, config, log });
  const errors = [];
  const step = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      errors.push(name);
      log.error(`nightly ${name} failed: ${error.message}`);
      return fallback;
    }
  };

  const prepaid = await step("prepaid", () => deliverPrepaid({ q, delivery, now }), { delivered: 0, waiting: 0 });
  const expired = await step("expire", () => expireCodes({ q, delivery, now }), 0);
  const zips = await step("zips", () => deleteExpiredZips({ q, deliveryDir: config.deliveryDir, now }), 0);
  const files = await step("files", () => deleteOldFiles({ q, config, now }), { unpaid: 0, paid: 0 });
  const ips = await step("ips", () => createLimits({ q, config, now: () => now }).forgetOldIps(), 0);
  const logs = await step("logs", () => rotateLogs({ logsDir: config.logsDir, now }), { rotated: 0, deleted: 0 });
  const backup = await step("backup", () => backupDatabase({ db, backupDir: config.backupDir, now }), null);

  const line = `${now.toISOString()} nightly: prepaid delivered ${prepaid.delivered} (waiting ${prepaid.waiting}), codes expired ${expired}, zips deleted ${zips}, ` +
    `files deleted ${files.unpaid + files.paid} (unpaid ${files.unpaid}, paid ${files.paid}), ip hashes cleared ${ips}, ` +
    `logs rotated ${logs.rotated} (old deleted ${logs.deleted}), ` +
    `backup ${backup ? `${backup.name} (old deleted ${backup.deleted})` : "failed"}, ` +
    `errors ${errors.length ? errors.join(" ") : 0}`;
  appendFileSync(path.join(config.logsDir, "nightly.log"), `${line}\n`);

  return { ok: errors.length === 0, prepaid, expired, zips, files, ips, logs, backup, errors, line };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // The paths in the config are relative to the repository folder.
  process.chdir(fileURLToPath(new URL("../..", import.meta.url)));
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const db = openDatabase(config.dbFile);
  try {
    const result = await runNightly({ db, config });
    console.log(result.line);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}
