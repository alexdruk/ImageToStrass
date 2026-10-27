import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/index.js";
import { runNightly } from "../src/ops/nightly.js";
import { loadConfig } from "../src/server/config.js";
import { startFakeServer } from "./fake-server.mjs";

// PN-03: every log goes to IS_LOG_DIR (default ~/Library/Logs/PatternNifty), never into the
// repository's logs/, which launchd may not open inside ~/Documents.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REPO_LOGS = path.join(REPO, "logs");
const PHOTO = readFileSync(path.join(REPO, "tools/fixtures/upload/photo.png"));
const quiet = { error() {}, warn() {}, log() {} };

// Agents installed on this Mac before PN-03 still write their stdout into the repository's logs/;
// those files belong to launchd, not to the code under test, so they are left out.
function installedAgentLogs() {
  const agents = path.join(homedir(), "Library", "LaunchAgents");
  const names = new Set();
  if (!existsSync(agents)) return names;
  for (const file of readdirSync(agents).filter((f) => /^com\.is\..*\.plist$/.test(f))) {
    const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(agents, file)], { encoding: "utf8" }));
    for (const out of [plist.StandardOutPath, plist.StandardErrorPath]) {
      if (out && path.dirname(out) === REPO_LOGS) names.add(path.basename(out));
    }
  }
  return names;
}

// name -> size and modification time of every file in the repository's logs/ (none if it is missing).
function snapshot(skip) {
  if (!existsSync(REPO_LOGS)) return {};
  return Object.fromEntries(readdirSync(REPO_LOGS).filter((f) => !skip.has(f)).map((f) => {
    const st = statSync(path.join(REPO_LOGS, f));
    return [f, `${st.size} ${st.mtimeMs}`];
  }));
}

test("the log folder: IS_LOG_DIR, else ~/Library/Logs/PatternNifty, never inside the repository", () => {
  const fallback = path.join(homedir(), "Library", "Logs", "PatternNifty");
  assert.equal(loadConfig({}).logsDir, fallback);
  assert.equal(loadConfig({ IS_LOG_DIR: "" }).logsDir, fallback);
  assert.equal(loadConfig({ IS_LOG_DIR: "/var/tmp/pn-logs" }).logsDir, "/var/tmp/pn-logs");
  assert.ok(!path.resolve(REPO, loadConfig({}).logsDir).startsWith(REPO));

  // No launchd template names the repository's logs/.
  for (const file of readdirSync(path.join(REPO, "ops", "launchd"))) {
    const text = readFileSync(path.join(REPO, "ops", "launchd", file), "utf8");
    assert.doesNotMatch(text, /__REPO__\/logs/, file);
    assert.match(text, /<key>StandardOutPath<\/key>\s*<string>__LOGS__\//, file);
    assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>__LOGS__\//, file);
  }
});

test("a fake design and the nightly job write nothing into the repository's logs/", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "is-logs-"));
  const logDir = path.join(root, "logs");
  const skip = installedAgentLogs();
  const before = snapshot(skip);
  const srv = await startFakeServer({ env: { IS_LOG_DIR: logDir } });
  try {
    assert.equal(srv.config.logsDir, logDir);
    const form = new FormData();
    form.append("consent", "1");
    form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
    const { code } = await (await fetch(`${srv.url}/api/upload`, { method: "POST", body: form })).json();
    for (let i = 0; i < 100 && (await (await fetch(`${srv.url}/api/uploads/${code}/1`)).json()).background !== "ready"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const created = await (await fetch(`${srv.url}/api/attempts/${code}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload: 1, mode: "colour", removeBackground: true, adjustments: {} })
    })).json();
    await srv.pipeline.idle();
    assert.equal((await (await fetch(`${srv.url}/api/attempts/${code}/${created.attempt}`)).json()).status, "done");

    const config = {
      ...loadConfig({ IS_LOG_DIR: logDir }),
      dbFile: path.join(root, "is.sqlite"),
      archiveDir: path.join(root, "archive"),
      deliveryDir: path.join(root, "delivery"),
      backupDir: path.join(root, "backup")
    };
    const db = openDatabase(config.dbFile);
    try {
      assert.equal((await runNightly({ db, config, log: quiet })).ok, true);
    } finally {
      db.close();
    }
    assert.ok(existsSync(path.join(logDir, "nightly.log")), "the summary line went to IS_LOG_DIR");
  } finally {
    await srv.stop();
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(snapshot(skip), before);
});
