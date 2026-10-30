import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { COUNTED_DESIGN_SQL } from "../db/queries.js";
import { parisDayStart } from "../server/limits.js";

// What the control panel shows (PN-05, spec section 15.1): the agents, health, business figures,
// the machine, storage and logs. Everything here only reads: launchctl list, ps, pmset -g, sysctl,
// sw_vers, du, HTTP GETs, the SQLite database opened read-only and the files the server writes.
// Each probe catches its own errors, so one that fails never hides the others.

export const AGENTS = ["com.is.strass", "com.is.server", "com.is.tunnel", "com.is.nightly", "com.is.control"];

const HTTP_TIMEOUT_MS = 3000;
const PUBLIC_TIMEOUT_MS = 8000;

// run(cmd, args) -> { code, stdout, stderr }; never throws (a missing command is code 127).
export function runCommand(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: stdout || "", stderr: stderr || (error && !stdout ? error.message : "") });
    });
  });
}

// A value computed at most once per ms; the slow probes (public health, du) use it.
export function cached(ms, fn, now = () => Date.now()) {
  let at = 0;
  let value = null;
  return () => {
    if (!value || now() - at >= ms) {
      at = now();
      value = fn();
    }
    return value;
  };
}

// Plain-English meaning of launchctl's "last exit status" (negative = the signal that ended it).
export function exitMeaning(status) {
  if (status === null || status === undefined) return "";
  if (status === 0) return "ok";
  if (status === 78) return "macOS blocked it (see “An agent shows exit code 78” in the runbook)";
  if (status === -15) return "stopped (terminated)";
  if (status === -9) return "killed";
  if (status < 0) return `ended by signal ${-status}, see its log`;
  return "error, see its log";
}

// "PID\tStatus\tLabel" lines -> { label: { pid, status } } for the com.is.* jobs.
export function parseLaunchctlList(text) {
  const jobs = {};
  for (const line of text.split("\n")) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (!label?.startsWith("com.is.")) continue;
    jobs[label] = { pid: /^\d+$/.test(pid) ? Number(pid) : null, status: /^-?\d+$/.test(status) ? Number(status) : null };
  }
  return jobs;
}

// ps etime "[[dd-]hh:]mm:ss" -> seconds.
export function etimeSeconds(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

// "ps -A -o pid=,ppid=,etime=,%cpu=,rss=" -> Map pid -> { ppid, seconds, cpu, rssKb }.
export function parsePs(text) {
  const procs = new Map();
  for (const line of text.split("\n")) {
    const [pid, ppid, etime, cpu, rss] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(pid ?? "")) continue;
    procs.set(Number(pid), { ppid: Number(ppid), seconds: etimeSeconds(etime), cpu: Number(cpu) || 0, rssKb: Number(rss) || 0 });
  }
  return procs;
}

// An agent's process and its children together (the strass agent is caffeinate plus Python).
export function processTree(procs, pid) {
  const root = procs.get(pid);
  if (!root) return null;
  const tree = [pid];
  for (let i = 0; i < tree.length; i += 1) {
    for (const [child, p] of procs) if (p.ppid === tree[i] && !tree.includes(child)) tree.push(child);
  }
  const sum = tree.reduce((acc, id) => ({ cpu: acc.cpu + procs.get(id).cpu, rssKb: acc.rssKb + procs.get(id).rssKb }), { cpu: 0, rssKb: 0 });
  return { seconds: root.seconds, cpu: sum.cpu, rssKb: sum.rssKb, processes: tree.length };
}

export async function agents({ run }) {
  const [list, ps] = await Promise.all([run("launchctl", ["list"]), run("ps", ["-A", "-o", "pid=,ppid=,etime=,%cpu=,rss="])]);
  const jobs = parseLaunchctlList(list.stdout);
  const procs = parsePs(ps.stdout);
  return {
    error: list.code === 0 ? null : "launchctl list failed",
    agents: AGENTS.map((label) => {
      const job = jobs[label];
      const proc = job?.pid ? processTree(procs, job.pid) : null;
      return { label, loaded: Boolean(job), running: Boolean(job?.pid), pid: job?.pid ?? null, status: job?.status ?? null, proc };
    })
  };
}

// GET url -> { ok (HTTP 2xx), status, ms, body (parsed JSON or null), error (short) }.
export async function timedGet(fetchFn, url, timeoutMs = HTTP_TIMEOUT_MS) {
  const started = performance.now();
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", cache: "no-store" });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), body, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { ok: false, status: null, ms: Math.round(performance.now() - started), body: null, error: timedOut ? "no answer (timeout)" : "no connection" };
  }
}

export function portListening(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// cloudflared's local metrics server: the address it logged last, else its default ports.
function metricsAddresses(logsDir) {
  const found = [];
  try {
    const text = readFileSync(path.join(logsDir, "tunnel.log"), "utf8");
    const all = [...text.matchAll(/Starting metrics server on ([\d.]+:\d+)\/metrics/g)];
    if (all.length) found.push(all[all.length - 1][1]);
  } catch { /* no log yet */ }
  for (let port = 20241; port <= 20245; port += 1) found.push(`127.0.0.1:${port}`);
  return [...new Set(found)];
}

// The tunnel's name from the installed agent's arguments (".. run <name>").
function tunnelName(home) {
  try {
    const plist = readFileSync(path.join(home, "Library", "LaunchAgents", "com.is.tunnel.plist"), "utf8");
    return /<string>run<\/string>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function tunnel({ fetchFn, config }) {
  const name = tunnelName(config.home);
  for (const address of metricsAddresses(config.logsDir)) {
    const ready = await timedGet(fetchFn, `http://${address}/ready`, 800);
    if (ready.body?.readyConnections === undefined) continue;
    const locations = [];
    try {
      const text = await (await fetchFn(`http://${address}/metrics`, { signal: AbortSignal.timeout(800) })).text();
      for (const m of text.matchAll(/^cloudflared_tunnel_server_locations\{[^}]*edge_location="([^"]+)"[^}]*\}\s+1/gm)) locations.push(m[1]);
    } catch { /* locations stay unknown */ }
    return { name, metrics: true, connections: Number(ready.body.readyConnections), locations };
  }
  return { name, metrics: false, connections: null, locations: [] };
}

export async function health({ fetchFn, config, publicHealth }) {
  const strassUrl = new URL(config.strassUrl);
  const [website, strass, listening, pub] = await Promise.all([
    timedGet(fetchFn, `${config.websiteUrl}/health`),
    timedGet(fetchFn, `${config.strassUrl}/health`),
    portListening(strassUrl.hostname, Number(strassUrl.port || 80)),
    publicHealth()
  ]);
  return { website, strass, strassPort: strassUrl.port || "80", strassListening: listening, public: pub };
}

// --- business (read-only database) ---------------------------------------------------------------

export function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Paid after the design was deleted (PN-07 follow-up): the "paid-after-delete" events Alex has not
// marked done yet, oldest first: { id, at, code, receiptId }. The Done clicks are kept in the panel's
// own file (config.alertsDoneFile, a list of event ids), so the database is still only read.
export function readDoneAlerts(file) {
  try {
    const ids = JSON.parse(readFileSync(file, "utf8"));
    return new Set(Array.isArray(ids) ? ids.filter(Number.isInteger) : []);
  } catch {
    return new Set();
  }
}

export function markAlertDone(file, id) {
  const ids = readDoneAlerts(file);
  ids.add(id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify([...ids])}\n`);
  renameSync(tmp, file);
}

export function paidAfterDeleteAlerts(config) {
  let db;
  try {
    db = new Database(config.dbFile, { readonly: true, fileMustExist: true });
    const done = readDoneAlerts(config.alertsDoneFile);
    return db.prepare("SELECT rowid AS id, at, code, detail FROM events WHERE kind = 'paid-after-delete' ORDER BY at, rowid").all()
      .filter((e) => !done.has(e.id))
      .map((e) => {
        let detail = {};
        try { detail = JSON.parse(e.detail || "{}"); } catch { /* none */ }
        return { id: e.id, at: e.at, code: e.code, receiptId: detail.receiptId ?? null };
      });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

// Orders without a code (etsy_orders rows with matched_code NULL), split in two (PN-08 follow-up):
// - unknownCode: the buyer wrote something in Personalization but no code IS knows (a typo or a wrong
//   code): a red alert, with the text, for every one;
// - empty Personalization: bought first and not redeemed on /order yet, which is normal. Grouped by
//   receipt (the buyer's order number), refunded ones left out (nothing to redeem). waiting: paid
//   less than 7 days ago, a neutral list; notRedeemed: 7 days or more, a yellow alert.
export const NOT_REDEEMED_DAYS = 7;

export function splitUnmatched(rows, now = new Date()) {
  const unknownCode = [];
  const receipts = new Map();
  for (const row of rows) {
    const text = String(row.personalization ?? "").trim();
    if (text) {
      unknownCode.push({ ...row, personalization: text });
      continue;
    }
    if (row.status === "refunded") continue;
    const seen = receipts.get(row.receiptId);
    if (!seen || (row.paidAt && (!seen.paidAt || row.paidAt < seen.paidAt))) receipts.set(row.receiptId, { receiptId: row.receiptId, paidAt: row.paidAt });
  }
  const limit = now.getTime() - NOT_REDEEMED_DAYS * 86400000;
  const waiting = [];
  const notRedeemed = [];
  for (const r of receipts.values()) (r.paidAt && Date.parse(r.paidAt) <= limit ? notRedeemed : waiting).push(r);
  return { unknownCode, waiting, notRedeemed };
}

export async function business({ config, loadTokens, now = new Date() }) {
  const out = { db: false };
  let db;
  try {
    db = new Database(config.dbFile, { readonly: true, fileMustExist: true });
    const since = (d) => d.toISOString();
    const today = since(startOfToday(now));
    const week = since(new Date(startOfToday(now).getTime() - 6 * 86400000));
    const one = (sql, ...args) => db.prepare(sql).pluck().get(...args);
    const period = (from) => ({
      done: one("SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND status = 'done'", from),
      failed: one("SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND status = 'failed'", from),
      declined: one("SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND status = 'declined'", from),
      reruns: one("SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND json_extract(settings_json, '$.rerunOf') IS NOT NULL", from),
      codes: one("SELECT COUNT(*) FROM codes WHERE created_at >= ?", from),
      paid: one("SELECT COUNT(DISTINCT code) FROM events WHERE at >= ? AND kind = 'paid'", from),
      downloads: one("SELECT COUNT(*) FROM events WHERE at >= ? AND kind = 'download'", from)
    });
    Object.assign(out, {
      db: true,
      queued: one("SELECT COUNT(*) FROM attempts WHERE status = 'queued'"),
      running: db.prepare("SELECT code, n, stage FROM attempts WHERE status = 'running' ORDER BY created_at").all(),
      today: period(today),
      week: period(week),
      // Orders without a code, split by what they mean (PN-08 follow-up): see splitUnmatched.
      ...splitUnmatched(db.prepare(`SELECT receipt_id AS receiptId, transaction_id AS transactionId,
        personalization, paid_at AS paidAt, status FROM etsy_orders WHERE matched_code IS NULL
        ORDER BY paid_at, receipt_id, transaction_id`).all(), now),
      // Buy first (PN-08): prepaid codes 30 days after payment with no design to deliver (D6).
      prepaidNoDesign: db.prepare(`SELECT code, receipt_id AS receiptId, paid_at AS paidAt FROM codes c
        WHERE status = 'prepaid' AND paid_at <= ?
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.code = c.code AND a.status = 'done')
        ORDER BY paid_at`).all(new Date(now.getTime() - 30 * 86400000).toISOString()),
      // The daily cap as the server counts it (spec 13, limits.js): the Paris calendar day.
      capUsed: one(`SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND ${COUNTED_DESIGN_SQL}`, parisDayStart(now).toISOString())
    });
  } catch {
    out.db = false;
  } finally {
    db?.close();
  }

  out.cap = config.dailyCap;
  const poller = readJson(config.pollerFile);
  out.poll = poller ? { at: poller.lastRun?.at ?? null, ok: poller.lastRun?.ok ?? null, lastOkAt: poller.lastOkAt ?? null, error: poller.lastError ?? null } : null;
  out.listings = config.listingIdsCount;
  out.shop = readJson(config.shopFile)?.shop_name ?? null;
  try {
    const tokens = await loadTokens();
    const issuedAt = Number(tokens?.expires_at) - Number(tokens?.expires_in);
    out.tokenAgeDays = tokens?.refresh_token && Number.isFinite(issuedAt) ? Math.max(0, (now.getTime() / 1000 - issuedAt) / 86400) : null;
    out.connected = Boolean(tokens?.refresh_token);
  } catch {
    out.tokenAgeDays = null;
    out.connected = false;
  }
  return out;
}

// --- machine and storage -------------------------------------------------------------------------

// "pmset -g custom" -> { "AC Power": { sleep: "0", ... }, "Battery Power": {...} }.
export function parsePmsetCustom(text) {
  const profiles = {};
  let current = null;
  for (const line of text.split("\n")) {
    const head = /^(\S.*):\s*$/.exec(line);
    if (head) {
      current = profiles[head[1]] = {};
    } else if (current) {
      const m = /^\s+(.+?)\s+(\S+)$/.exec(line);
      if (m) current[m[1]] = m[2];
    }
  }
  return profiles;
}

// "pmset -g batt" -> { source: "AC Power" | "Battery Power", battery: 80 | null, state }.
export function parsePmsetBatt(text) {
  const source = /drawing from '([^']+)'/.exec(text)?.[1] ?? null;
  const m = /(\d+)%;\s*([^;]+);/.exec(text);
  return { source, battery: m ? Number(m[1]) : null, state: m ? m[2].trim() : null };
}

export async function machine({ run, now = Date.now() }) {
  const [boot, batt, custom, version] = await Promise.all([
    run("sysctl", ["-n", "kern.boottime"]),
    run("pmset", ["-g", "batt"]),
    run("pmset", ["-g", "custom"]),
    run("sw_vers", ["-productVersion"])
  ]);
  const bootSec = Number(/sec = (\d+)/.exec(boot.stdout)?.[1]);
  return {
    uptimeSeconds: Number.isFinite(bootSec) ? Math.max(0, now / 1000 - bootSec) : null,
    power: batt.code === 0 ? parsePmsetBatt(batt.stdout) : null,
    sleep: custom.code === 0 ? parsePmsetCustom(custom.stdout) : null,
    macos: version.stdout.trim() || null,
    node: process.version
  };
}

async function duBytes(run, dir) {
  const out = await run("du", ["-sk", dir], { timeout: 20000 });
  const kb = Number(/^(\d+)/.exec(out.stdout)?.[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

export async function folderSizes({ run, config }) {
  const entries = [["data/archive", config.archiveDir], ["data/delivery", config.deliveryDir], ["data/backup", config.backupDir], ["log folder", config.logsDir]];
  return Promise.all(entries.map(async ([name, dir]) => ({ name, bytes: await duBytes(run, dir) })));
}

export async function storage({ config, sizes }) {
  let free = null;
  let total = null;
  try {
    const fs = await statfs(config.root);
    free = fs.bavail * fs.bsize;
    total = fs.blocks * fs.bsize;
  } catch { /* unknown */ }
  let backup = null;
  try {
    const files = readdirSync(config.backupDir).filter((f) => /^is-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
    if (files.length) {
      const name = files[files.length - 1];
      const st = statSync(path.join(config.backupDir, name));
      backup = { name, at: st.mtime, bytes: st.size, count: files.length };
    }
  } catch { /* no backups yet */ }
  return { free, total, sizes: await sizes(), backup };
}

// --- logs ----------------------------------------------------------------------------------------

export const LOG_NAME = /^[\w][\w.-]*$/;

export function listLogs(logsDir) {
  try {
    return readdirSync(logsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && LOG_NAME.test(e.name) && /\.log(\.\d{4}-\d{2}-\d{2})?$/.test(e.name))
      .map((e) => {
        const st = statSync(path.join(logsDir, e.name));
        return { name: e.name, bytes: st.size, at: st.mtime };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// The last n lines of a file, read from its end (at most the last 512 KB).
export async function tailLines(file, n = 100) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (length < size) lines.shift();
    return lines.slice(-n);
  } finally {
    await handle.close();
  }
}

// The nightly job's summary: the last line of nightly.log ("<ISO time> nightly: ...").
export async function nightlySummary(logsDir) {
  try {
    const [line] = await tailLines(path.join(logsDir, "nightly.log"), 1);
    const m = /^(\S+) nightly: (.*)$/.exec(line ?? "");
    return m ? { at: m[1], text: m[2], errors: !/errors 0$/.test(m[2]) } : null;
  } catch {
    return null;
  }
}
