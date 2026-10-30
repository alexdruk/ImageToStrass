import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadControlConfig } from "../src/control/app.js";
import { openDatabase } from "../src/db/index.js";
import { exitMeaning, parseLaunchctlList, parsePmsetBatt, parsePmsetCustom, parsePs, processTree, splitUnmatched } from "../src/control/probes.js";

// The control panel (PN-05): the real src/control/index.js in a temporary folder with its own
// .env, database, log folder and HOME, and a stub launchctl first on PATH. No real agent is
// started, stopped or asked anything; the website, strass and public addresses are closed ports.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UID = process.getuid();

// Values that must never reach the page.
const SECRETS = {
  OPENAI_API_KEY: "sk-test-NEVER-SHOWN-7f3a9c",
  TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  ETSY_KEYSTRING: "keystring-NEVER-SHOWN-41b2",
  ETSY_SHARED_SECRET: "shared-NEVER-SHOWN-99d0",
  ADMIN_TOKEN: "admin-NEVER-SHOWN-55e1",
  TURNSTILE_SECRET_KEY: "0x4AAAA-NEVER-SHOWN-turnstile",
  IS_ETSY_LISTING_IDS: "918273645546372",
  ETSY_REDIRECT_URI: "https://never-shown.example/oauth/callback"
};

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

let root;
let home;
let logs;
let port;
let child;

const calls = () => (existsSync(path.join(root, "calls.log")) ? readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n") : []);
// The launchctl calls that change something (list and print only read).
const changes = () => calls().filter((c) => !/^launchctl (list|print)\b/.test(c));
const clearCalls = () => rmSync(path.join(root, "calls.log"), { force: true });

// launchctl stub: loaded jobs are files in loaded/ holding "<pid> <last exit status>".
function writeStub(bin) {
  const state = path.join(root, "loaded");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(bin, "launchctl"), `#!/bin/bash
echo "launchctl $*" >> "${root}/calls.log"
state="${state}"
case "$1" in
  list) echo "PID	Status	Label"; for f in "$state"/*; do [ -e "$f" ] || continue; read -r pid st < "$f"; echo "$pid	$st	$(basename "$f")"; done ;;
  print) [ -e "$state/$(basename "$2")" ] ;;
  bootstrap) echo "- 0" > "$state/$(basename "$3" .plist)" ;;
  bootout) [ -e "$state/$(basename "$2")" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }; rm -f "$state/$(basename "$2")" ;;
  kickstart) exit 0 ;;
  *) exit 3 ;;
esac
`);
  chmodSync(path.join(bin, "launchctl"), 0o755);
  // The test process stands in for the running agents' processes (ps must find a pid).
  const loaded = { "com.is.server": `${process.pid} 0`, "com.is.tunnel": `${process.pid} -15`, "com.is.strass": "- 78", "com.is.nightly": "- 0", "com.is.control": `${process.pid} 0` };
  for (const [label, line] of Object.entries(loaded)) writeFileSync(path.join(state, label), `${line}\n`);
}

function request(method, urlPath, { headers = {}, form = null } = {}) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path: urlPath,
      headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}), ...headers }
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

const page = async () => {
  const r = await request("GET", "/");
  assert.equal(r.status, 200);
  return r.text;
};
const token = async () => /name="csrf" value="([^"]+)"/.exec(await page())[1];
const post = async (label, action, form = {}) => request("POST", `/agents/${label}/${action}`, { form: { csrf: await token(), ...form } });

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "is-control-"));
  home = path.join(root, "home");
  logs = path.join(root, "logs");
  const bin = path.join(root, "bin");
  for (const dir of [home, logs, bin, path.join(root, "data", "backup")]) mkdirSync(dir, { recursive: true });
  writeStub(bin);
  port = await freePort();
  const closed = await freePort();

  writeFileSync(path.join(root, ".env"), [
    ...Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`),
    `IS_CONTROL_PORT=${port}`, `PORT=${closed}`, `STRASS_SERVICE_URL=http://127.0.0.1:${closed}`,
    `PUBLIC_BASE_URL=http://127.0.0.1:${closed}`, `IS_LOG_DIR=${logs}`, "IS_DAILY_DESIGN_CAP=40", ""
  ].join("\n"));

  // A database with today's figures; the panel opens it read-only.
  const db = openDatabase(path.join(root, "data", "is.sqlite"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO codes (code, created_at) VALUES ('PN-AAAA-BBBB', ?), ('PN-CCCC-DDDD', ?)").run(now, now);
  const attempt = db.prepare("INSERT INTO attempts (code, n, status, stage, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  attempt.run("PN-AAAA-BBBB", 1, "failed", null, "{}", now);
  attempt.run("PN-AAAA-BBBB", 2, "done", null, JSON.stringify({ rerunOf: 1 }), now);
  attempt.run("PN-CCCC-DDDD", 1, "running", "layout", "{}", now);
  db.prepare("INSERT INTO etsy_orders (receipt_id, transaction_id, personalization, seen_at) VALUES (1, 2, 'no code', ?)").run(now);
  // Orders without a code (PN-08 follow-up): a typo with markup in it; bought first, Personalization
  // empty: 2 days ago (two transactions of one receipt), 8 days ago, and refunded (left out).
  const order = db.prepare("INSERT INTO etsy_orders (receipt_id, transaction_id, personalization, paid_at, status, seen_at) VALUES (?, ?, ?, ?, ?, ?)");
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  order.run(3800000100, 4900000100, "PN-7K3Q-9XPZ <b>thanks</b>", daysAgo(1), "paid", now);
  order.run(3800000200, 4900000201, "", daysAgo(2), "paid", now);
  order.run(3800000200, 4900000202, null, daysAgo(2), "paid", now);
  order.run(3800000300, 4900000300, "  ", daysAgo(8), "paid", now);
  order.run(3800000400, 4900000400, "", daysAgo(9), "refunded", now);
  db.prepare("INSERT INTO events (at, code, kind) VALUES (?, 'PN-AAAA-BBBB', 'paid'), (?, 'PN-AAAA-BBBB', 'download')").run(now, now);
  db.close();

  writeFileSync(path.join(logs, "server.log"), "started\n<script>alert(1)</script> ERROR boom & more\nTraceback (most recent call last)\nfine\n");
  writeFileSync(path.join(logs, "tunnel.log"), "2026-10-27T11:00:00Z WRN slow\n");
  writeFileSync(path.join(logs, "nightly.log"), "2026-10-27T03:30:00.000Z nightly: codes expired 0, zips deleted 1, errors 0\n");
  writeFileSync(path.join(logs, "notes.txt"), "not a log\n");

  child = spawn(process.execPath, [path.join(REPO, "src", "control", "index.js")], {
    cwd: root,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`control panel did not start: ${output}`)), 10000);
    const seen = (d) => {
      output += d;
      if (output.includes("control panel at")) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", seen);
    child.once("exit", (code) => reject(new Error(`control panel exited ${code}: ${output}`)));
  });
});

after(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

test("control: tunnel-style requests (CF-Connecting-IP, public Host) get the plain 404", async () => {
  for (const headers of [
    { "cf-connecting-ip": "203.0.113.7" },
    { host: "patternnifty.com" },
    { host: "patternnifty.com", "cf-connecting-ip": "203.0.113.7" },
    { host: `192.168.1.14:${port}` }
  ]) {
    for (const urlPath of ["/", "/logs/server.log", "/control.js"]) {
      const r = await request("GET", urlPath, { headers });
      assert.equal(r.status, 404, `${urlPath} ${JSON.stringify(headers)}`);
      assert.equal(r.text, "Not found");
    }
  }
  clearCalls();
  const csrf = await token();
  const r = await request("POST", "/agents/com.is.server/stop", { headers: { "cf-connecting-ip": "203.0.113.7" }, form: { csrf, confirm: "1" } });
  assert.equal(r.status, 404);
  assert.deepEqual(changes(), []);
});

test("control: a POST without the start-up token is refused", async () => {
  clearCalls();
  for (const form of [{ confirm: "1" }, { csrf: "wrong", confirm: "1" }, { csrf: "", confirm: "1" }]) {
    const r = await request("POST", "/agents/com.is.server/stop", { form });
    assert.equal(r.status, 403);
  }
  assert.equal((await request("POST", "/agents/com.is.nightly/run", { form: {} })).status, 403);
  assert.deepEqual(changes(), []);
});

test("control: Start, Stop, Restart and Run now call launchctl on gui/<uid> with the right arguments", async () => {
  clearCalls();
  // Stop asks first and says what happens; nothing is called until it is confirmed.
  const ask = await post("com.is.server", "stop");
  assert.equal(ask.status, 200);
  assert.match(ask.text, /patternnifty\.com down/);
  assert.match(ask.text, /name="confirm" value="1"/);
  assert.deepEqual(changes(), []);
  assert.match((await post("com.is.tunnel", "restart")).text, /unreachable/);
  assert.deepEqual(changes(), []);

  const stop = await post("com.is.server", "stop", { confirm: "1" });
  assert.equal(stop.status, 303);
  assert.equal(stop.headers.location, "/");
  assert.deepEqual(changes(), [`launchctl bootout gui/${UID}/com.is.server`]);
  assert.match(await page(), /Stopped com\.is\.server\./);

  // Not loaded: Start is a bootstrap of the installed plist.
  clearCalls();
  assert.equal((await post("com.is.server", "start")).status, 303);
  assert.deepEqual(changes(), [`launchctl bootstrap gui/${UID} ${path.join(home, "Library", "LaunchAgents", "com.is.server.plist")}`]);

  // Loaded but not running (strass, last exit 78): Start is a kickstart.
  clearCalls();
  await post("com.is.strass", "start");
  assert.deepEqual(changes(), [`launchctl kickstart gui/${UID}/com.is.strass`]);

  clearCalls();
  await post("com.is.tunnel", "restart", { confirm: "1" });
  assert.deepEqual(changes(), [`launchctl kickstart -k gui/${UID}/com.is.tunnel`]);

  clearCalls();
  await post("com.is.nightly", "run");
  assert.deepEqual(changes(), [`launchctl kickstart gui/${UID}/com.is.nightly`]);

  // A failed launchctl call is reported on the page.
  clearCalls();
  await post("com.is.server", "stop", { confirm: "1" });
  await post("com.is.server", "stop", { confirm: "1" });
  assert.match(await page(), /launchctl bootout com\.is\.server failed \(exit 3\): Boot-out failed/);
  await post("com.is.server", "start");

  // The panel cannot stop itself; it can restart itself (after answering).
  clearCalls();
  const self = await post("com.is.control", "stop", { confirm: "1" });
  assert.equal(self.status, 404);
  assert.doesNotMatch(await page(), /action="\/agents\/com\.is\.control\/stop"/);
  assert.equal((await post("com.is.control", "restart", { confirm: "1" })).status, 303);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(changes(), [`launchctl kickstart -k gui/${UID}/com.is.control`]);

  clearCalls();
  assert.equal((await post("com.is.other", "stop", { confirm: "1" })).status, 404);
  assert.equal((await post("com.is.server", "delete", { confirm: "1" })).status, 404);
  assert.deepEqual(changes(), []);
});

test("control: the page never contains a value from .env; keys show only set or missing", async () => {
  const pages = [
    await page(),
    (await post("com.is.server", "stop")).text,
    (await request("GET", "/logs/server.log")).text,
    (await request("GET", "/logs/nope.log")).text,
    (await request("GET", "/control.js")).text,
    (await request("POST", "/agents/com.is.server/stop", { form: { csrf: "x" } })).text
  ];
  for (const text of pages) {
    for (const [key, value] of Object.entries(SECRETS)) assert.ok(!text.includes(value), `${key}'s value is on a page`);
  }
  const main = pages[0];
  assert.match(main, /Image provider key<\/td><td><span class="ok">● set/);
  assert.match(main, /TURNSTILE_SITE_KEY<\/td><td><span class="bad">● missing/);
  assert.match(main, /Listing ids: <span class="ok">● configured \(1\)/);
});

test("control: a warning when the legal details are missing in .env (PN-07)", async () => {
  // The test .env sets none of them.
  const main = await page();
  assert.match(main, /<p class="note bad"><span class="warn">● Legal details missing in .env<\/span><\/p>/);
  assert.match(main, /IS_LEGAL_NAME, IS_LEGAL_ADDRESS, IS_LEGAL_COUNTRY, IS_LEGAL_LAW, IS_CONTACT_EMAIL: the privacy/);
  const all = { IS_LEGAL_NAME: "n", IS_LEGAL_ADDRESS: "a", IS_LEGAL_COUNTRY: "c", IS_LEGAL_LAW: "l", IS_CONTACT_EMAIL: "e" };
  // The registration number may stay empty; a blank value counts as missing.
  assert.deepEqual(loadControlConfig(all, root).legalMissing, []);
  assert.deepEqual(loadControlConfig({ ...all, IS_LEGAL_LAW: "  " }, root).legalMissing, ["IS_LEGAL_LAW"]);
});

test("control: agents, health, business and logs as the page shows them", async () => {
  const main = await page();
  assert.match(main, /78 · macOS blocked it/);
  assert.match(main, /-15 · stopped/);
  assert.match(main, /Last run \d+ Oct 2026, \d\d:\d0:00: codes expired 0, zips deleted 1, errors 0/);
  assert.match(main, /<th>Website<\/th><td><span class="bad">● down: no connection/);
  assert.match(main, /not listening/);
  assert.match(main, /<th>Public<\/th><td><span class="bad">●/);
  assert.match(main, /<code>PN-CCCC-DDDD<\/code> #1 at stage <b>layout<\/b>/);
  assert.match(main, /Designs done<\/td><td class="num">1<\/td><td class="num">1</);
  assert.match(main, /Automatic re-runs<\/td><td class="num">1</);
  assert.match(main, /Codes paid<\/td><td class="num">1</);
  assert.match(main, /Downloads<\/td><td class="num">1</);
  // Orders without a code (PN-08 follow-up): unknown codes red with the buyer's text (escaped);
  // bought first and not redeemed: a neutral list, a yellow note at the top from 7 days.
  assert.match(main, /Orders with an unknown code: <span class="bad">● 2/);
  assert.ok(main.includes('the buyer wrote: <q class="buyer-text">PN-7K3Q-9XPZ &lt;b&gt;thanks&lt;/b&gt;</q>'));
  assert.ok(main.includes('<q class="buyer-text">no code</q>'));
  assert.doesNotMatch(main, /<b>thanks<\/b>/);
  assert.match(main, /Waiting for the buyer to redeem: <b>1<\/b>/);
  const waiting = /<ul class="orders" id="waiting-redeem">([\s\S]*?)<\/ul>/.exec(main)[1];
  assert.match(waiting, /Receipt <b>3800000200<\/b>/);
  assert.doesNotMatch(waiting, /3800000300|3800000400/);
  assert.match(main, /<div class="note waiting alert"><span class="warn">● Paid 7\+ days ago, not redeemed yet: message the buyer on Etsy<\/span>\s*Receipt <b>3800000300<\/b>/);
  assert.ok(main.indexOf("Paid 7+ days ago") < main.indexOf("com.is.server"));
  assert.doesNotMatch(main, /3800000400/);
  assert.doesNotMatch(main, /Orders without a code/);
  assert.match(main, /href="http:\/\/127\.0\.0\.1:\d+\/admin"/);
  // The cap as the server counts it (spec 13): the running design; not the failed one, which never
  // reached the provider, nor the automatic re-run.
  assert.match(main, /<b>1<\/b> of 40/);
  assert.match(main, /<script src="\/control\.js"><\/script>/);
  assert.doesNotMatch(main, /notes\.txt/);

  // Logs: last lines as escaped text, error, warn and traceback highlighted; only files of the folder.
  const log = (await request("GET", "/logs/server.log")).text;
  assert.ok(log.includes('<span class="hl">&lt;script&gt;alert(1)&lt;/script&gt; ERROR boom &amp; more</span>'));
  assert.ok(log.includes('<span class="hl">Traceback (most recent call last)</span>'));
  assert.ok(!log.includes("<script>alert"));
  assert.match((await request("GET", "/logs/tunnel.log")).text, /<span class="hl">[^<]*WRN slow<\/span>/);
  for (const bad of ["/logs/notes.txt", "/logs/..%2F.env", "/logs/%2E%2E%2F%2Eenv", "/logs/.env"]) {
    assert.equal((await request("GET", bad)).status, 404, bad);
  }
});

test("control: the database and the server's files are only read", async () => {
  const file = path.join(root, "data", "is.sqlite");
  const before = crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
  await page();
  await page();
  assert.equal(crypto.createHash("sha256").update(readFileSync(file)).digest("hex"), before);
});

test("control probes: launchctl list, ps trees, pmset and exit meanings", () => {
  assert.deepEqual(parseLaunchctlList("PID\tStatus\tLabel\n3200\t0\tcom.is.strass\n-\t78\tcom.is.server\n12\t0\tcom.apple.x\n"), {
    "com.is.strass": { pid: 3200, status: 0 }, "com.is.server": { pid: null, status: 78 }
  });
  const procs = parsePs(" 10 1 1-02:03:04 1.5 1000\n 11 10 05:00 2.0 500\n 12 11 01:00 0.5 100\n 13 1 00:01 9.0 9\n");
  assert.deepEqual(processTree(procs, 10), { seconds: 93784, cpu: 4, rssKb: 1600, processes: 3 });
  assert.equal(processTree(procs, 99), null);
  assert.deepEqual(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true\n"),
    { source: "AC Power", battery: 80, state: "AC attached" });
  assert.deepEqual(parsePmsetBatt("Now drawing from 'AC Power'\n"), { source: "AC Power", battery: null, state: null });
  const custom = parsePmsetCustom("Battery Power:\n sleep                1\nAC Power:\n Sleep On Power Button 1\n sleep                0\n");
  assert.equal(custom["AC Power"].sleep, "0");
  assert.equal(custom["Battery Power"].sleep, "1");
  assert.equal(exitMeaning(0), "ok");
  assert.match(exitMeaning(78), /macOS blocked it/);
  assert.match(exitMeaning(-15), /stopped/);
  assert.match(exitMeaning(1), /see its log/);
});

test("control: paid after the design was deleted: a red alert until Done (PN-07 follow-up)", async () => {
  const db = openDatabase(path.join(root, "data", "is.sqlite"));
  db.prepare("INSERT INTO events (at, code, kind, detail) VALUES (?, 'PN-CCCC-DDDD', 'paid-after-delete', ?)")
    .run(new Date().toISOString(), JSON.stringify({ how: "etsy", receiptId: 3800000777, transactionId: 4900000777 }));
  const id = db.prepare("SELECT MAX(rowid) FROM events").pluck().get();
  db.close();

  const alert = /<div class="note bad alert"><span class="bad">● Paid, but the design was deleted: refund on Etsy<\/span>\s*Receipt <b>3800000777<\/b> · code <code>PN-CCCC-DDDD<\/code>/;
  let main = await page();
  assert.match(main, alert);
  // At the top: before the agents.
  assert.ok(main.indexOf("Paid, but the design was deleted") < main.indexOf("com.is.server"));
  assert.match(main, new RegExp(`action="/alerts/${id}/done"`));

  // Done needs the page's token, and a known alert.
  assert.equal((await request("POST", `/alerts/${id}/done`, { form: { csrf: "wrong" } })).status, 403);
  assert.equal((await request("POST", "/alerts/999999/done", { form: { csrf: await token() } })).status, 404);
  assert.match(await page(), alert);

  const before = crypto.createHash("sha256").update(readFileSync(path.join(root, "data", "is.sqlite"))).digest("hex");
  const done = await request("POST", `/alerts/${id}/done`, { form: { csrf: await token() } });
  assert.equal(done.status, 303);
  main = await page();
  assert.doesNotMatch(main, /Paid, but the design was deleted/);
  // Kept in the panel's own file; the database is still only read.
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "data", "control-alerts-done.json"), "utf8")), [id]);
  assert.equal(crypto.createHash("sha256").update(readFileSync(path.join(root, "data", "is.sqlite"))).digest("hex"), before);
});

test("control probes: orders without a code, split, and the 7-day switch (PN-08 follow-up)", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const at = (ms) => new Date(now.getTime() - ms).toISOString();
  const WEEK = 7 * 86400000;
  const row = (receiptId, personalization, paidAt, status = "paid") => ({ receiptId, transactionId: receiptId + 1, personalization, paidAt, status });
  const split = splitUnmatched([
    row(1, "PN-ABCD-EFGH", at(WEEK * 3)),
    row(2, " typo PN-1234 ", at(1000), "refunded"),
    row(3, "", at(WEEK - 1)),
    row(4, null, at(WEEK)),
    row(5, "\n", at(WEEK + 1)),
    row(6, "", at(WEEK * 2), "refunded"),
    row(7, "", null)
  ], now);
  // Text but no known code: red, whatever its age or status, with the text trimmed.
  assert.deepEqual(split.unknownCode.map((o) => [o.receiptId, o.personalization]), [[1, "PN-ABCD-EFGH"], [2, "typo PN-1234"]]);
  // Empty: under 7 days waiting; from exactly 7 days a yellow note; refunded ones in neither.
  assert.deepEqual(split.waiting.map((o) => o.receiptId), [3, 7]);
  assert.deepEqual(split.notRedeemed.map((o) => o.receiptId), [4, 5]);
  // One receipt, two empty transactions: listed once, with its earliest payment.
  const one = splitUnmatched([row(8, "", at(WEEK + 5)), { ...row(8, "", at(1000)), transactionId: 99 }], now);
  assert.deepEqual(one.notRedeemed, [{ receiptId: 8, paidAt: at(WEEK + 5) }]);
  assert.deepEqual(one.waiting, []);
  // Day 6 waiting, day 7 yellow: the same order seen a day later.
  const order = [row(9, "", "2026-10-23T12:00:00.000Z")];
  assert.equal(splitUnmatched(order, new Date("2026-10-30T11:59:59.999Z")).waiting.length, 1);
  assert.equal(splitUnmatched(order, new Date("2026-10-30T12:00:00.000Z")).notRedeemed.length, 1);
});
