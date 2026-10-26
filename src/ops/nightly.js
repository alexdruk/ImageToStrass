// The nightly job (spec section 15), run by launchd (com.is.nightly) at 03:30, or by hand:
//   node src/ops/nightly.js
// 1. paid codes whose 30 days are over become expired;
// 2. delivery ZIPs (data/delivery/<code>/) of codes whose delivery_expires_at has passed are deleted,
//    and the folder with them when it is empty;
// 3. logs/*.log are rotated (copied to <name>.log.YYYY-MM-DD, then emptied; 14 days kept);
// 4. data/is.sqlite is copied with SQLite's online backup to data/backup/is-YYYY-MM-DD.sqlite (30 kept);
// 5. one summary line goes to logs/nightly.log.
// Nothing under data/archive/ is read, deleted or moved; the only write there is the code.json copy
// of a code that became expired, as at every change of a code (section 4.2).

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

export const LOG_DAYS = 14;
export const BACKUPS_KEPT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");
// The Mac's local date, YYYY-MM-DD.
export const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

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

  const expired = await step("expire", () => expireCodes({ q, delivery, now }), 0);
  const zips = await step("zips", () => deleteExpiredZips({ q, deliveryDir: config.deliveryDir, now }), 0);
  const logs = await step("logs", () => rotateLogs({ logsDir: config.logsDir, now }), { rotated: 0, deleted: 0 });
  const backup = await step("backup", () => backupDatabase({ db, backupDir: config.backupDir, now }), null);

  const line = `${now.toISOString()} nightly: codes expired ${expired}, zips deleted ${zips}, ` +
    `logs rotated ${logs.rotated} (old deleted ${logs.deleted}), ` +
    `backup ${backup ? `${backup.name} (old deleted ${backup.deleted})` : "failed"}, ` +
    `errors ${errors.length ? errors.join(" ") : 0}`;
  mkdirSync(config.logsDir, { recursive: true });
  appendFileSync(path.join(config.logsDir, "nightly.log"), `${line}\n`);

  return { ok: errors.length === 0, expired, zips, logs, backup, errors, line };
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
