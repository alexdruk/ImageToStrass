import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/server/config.js";
import { waitForStrass } from "../src/server/health.js";
import { startFakeServer } from "./fake-server.mjs";

// Hosting on the Mac (spec section 15): www redirect, the tunnel's view of the admin routes, the
// server's wait for strass, and tools/install-agents.sh with a fake HOME (never the real ~/Library
// or ~/.cloudflared, and no real launchctl or cloudflared call).

const REPO = fileURLToPath(new URL("..", import.meta.url));
const LABELS = ["com.is.strass", "com.is.server", "com.is.tunnel", "com.is.nightly"];
const TUNNEL_ID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

// GET with full control of the Host and CF-Connecting-IP headers (the tunnel adds the latter).
function call(base, urlPath, headers = {}) {
  const url = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { host: url.host, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const PUBLIC = { host: "patternnifty.com", "cf-connecting-ip": "203.0.113.7" };

test("www.patternnifty.com: 301 to https://patternnifty.com, same path and query", async () => {
  const srv = await startFakeServer({ env: { PUBLIC_BASE_URL: "https://patternnifty.com/" } });
  try {
    for (const urlPath of ["/", "/download?code=PN-7K3Q-9XPA&x=1", "/c/PN-7K3Q-9XPA", "/admin"]) {
      const answer = await call(srv.url, urlPath, { ...PUBLIC, host: "WWW.patternnifty.com" });
      assert.equal(answer.status, 301, urlPath);
      assert.equal(answer.headers.location, `https://patternnifty.com${urlPath}`);
    }
    assert.equal((await call(srv.url, "/", PUBLIC)).status, 200);
    assert.equal((await call(srv.url, "/")).status, 200);
  } finally {
    await srv.stop();
  }

  const plain = await startFakeServer();
  try {
    assert.equal((await call(plain.url, "/", { ...PUBLIC, host: "www.patternnifty.com" })).status, 200);
  } finally {
    await plain.stop();
  }
});

test("through the tunnel the admin and Etsy routes are the plain 404; on the Mac they work", async () => {
  const srv = await startFakeServer({
    env: {
      PUBLIC_BASE_URL: "https://patternnifty.com",
      ADMIN_TOKEN: "t0ken-for-tests",
      ETSY_KEYSTRING: "kkk",
      ETSY_REDIRECT_URI: "https://patternnifty.com/oauth/callback"
    },
    deps: { loadTokens: async () => null }
  });
  const routes = [
    "/admin", "/auth/etsy", "/oauth/callback", "/oauth/callback?code=c0de",
    "/oauth/callback?code=c0de&state=forged", "/etsy/status", "/etsy/listings",
    "/etsy/listings/123/personalization"
  ];
  try {
    for (const urlPath of routes) {
      assert.equal((await call(srv.url, urlPath, PUBLIC)).status, 404, `${urlPath} through the tunnel`);
      // A tunnel request that names a loopback Host is still the tunnel's.
      assert.equal((await call(srv.url, urlPath, { "cf-connecting-ip": "203.0.113.7" })).status, 404, `${urlPath} with a loopback Host`);
      assert.equal((await call(srv.url, urlPath, { ...PUBLIC, "x-admin-token": "wrong" })).status, 404, `${urlPath} with a wrong token`);
    }

    // On the Mac itself.
    assert.equal((await call(srv.url, "/admin")).status, 200);
    assert.equal((await call(srv.url, "/auth/etsy")).status, 302);
    assert.equal((await call(srv.url, "/oauth/callback")).status, 400, "reaches the handler (no code or state)");
    assert.equal((await call(srv.url, "/etsy/status")).status, 502, "reaches Etsy (none in tests)");
    // Or with ADMIN_TOKEN through the tunnel.
    assert.equal((await call(srv.url, "/admin", { ...PUBLIC, "x-admin-token": "t0ken-for-tests" })).status, 200);
    // The public pages answer through the tunnel.
    assert.notEqual((await call(srv.url, "/health", PUBLIC)).status, 404);
  } finally {
    await srv.stop();
  }
});

test("server start: waits for the strass health check, gives up after the timeout", async () => {
  const config = loadConfig({});
  let calls = 0;
  const healthyThird = async () => {
    calls += 1;
    if (calls < 3) throw new Error("connection refused");
    return new Response(JSON.stringify({ ok: true, modelsLoaded: true, busy: false }));
  };
  const noSleep = async () => {};
  assert.equal(await waitForStrass({ config, fetch: healthyThird, intervalMs: 1, sleep: noSleep }), true);
  assert.equal(calls, 3);

  const loading = async () => new Response(JSON.stringify({ ok: true, modelsLoaded: false }));
  assert.equal(await waitForStrass({ config, fetch: loading, timeoutMs: 30, intervalMs: 5 }), false);

  const never = async () => assert.fail("fake mode makes no strass call");
  assert.equal(await waitForStrass({ config: loadConfig({ IS_FAKE: "1" }), fetch: never }), true);
});

// --- install-agents.sh with a fake HOME ----------------------------------------------------------

function stubs(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const write = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  // cloudflared: only "tunnel list --name is --output json" is expected.
  write("cloudflared", `echo "cloudflared $*" >> "${root}/calls.log"
[ "$1 $2" = "tunnel list" ] || exit 3
echo '[{"id":"${TUNNEL_ID}","name":"is","created_at":"2026-10-25T10:00:00Z","connections":[]}]'`);
  // launchctl: remembers what is loaded in a folder.
  write("launchctl", `echo "launchctl $*" >> "${root}/calls.log"
state="${root}/loaded"; mkdir -p "$state"
case "$1" in
  print) [ -e "$state/$(basename "$2")" ] ;;
  bootstrap) touch "$state/$(basename "$3" .plist)" ;;
  bootout) rm -f "$state/$(basename "$2")" ;;
  *) exit 3 ;;
esac`);
  return bin;
}

// Runs a script; returns its stdout and stderr together. IS_LOG_DIR is empty unless env names it, so
// an IS_LOG_DIR in the repository's .env does not change what is checked.
function run(script, root, bin, { env = {}, status = 0 } = {}) {
  const result = spawnSync("/bin/bash", [path.join(REPO, "tools", script)], {
    cwd: root,
    encoding: "utf8",
    env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, IS_LOG_DIR: "", ...env }
  });
  assert.equal(result.status, status, `${script}: ${result.stdout}${result.stderr}`);
  return result.stdout + result.stderr;
}

const realAgents = () => LABELS.map((l) => existsSync(path.join(homedir(), "Library", "LaunchAgents", `${l}.plist`)));

test("install-agents.sh: plists and config.yml in a fake HOME; safe to run twice; uninstall", () => {
  const root = mkdtempSync(path.join(tmpdir(), "is-agents-"));
  const home = path.join(root, "home");
  mkdirSync(home);
  mkdirSync(path.join(root, "tmp"));
  const realBefore = realAgents();
  const realConfig = path.join(homedir(), ".cloudflared", "config.yml");
  const realConfigBefore = existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null;
  try {
    const bin = stubs(root);
    const output = run("install-agents.sh", root, bin);
    assert.match(output, /Wrote .*config\.yml \(tunnel 0b1c2d3e/);
    assert.match(output, /credentials .* are missing/);
    // PN-03: the logs are in ~/Library/Logs/PatternNifty, made by the script, never in the repository.
    const logDir = path.join(home, "Library", "Logs", "PatternNifty");
    assert.ok(output.includes(`Logs: ${logDir}/`), output);
    assert.ok(existsSync(logDir));

    const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
    const agents = path.join(home, "Library", "LaunchAgents");
    for (const label of LABELS) {
      const file = path.join(agents, `${label}.plist`);
      execFileSync("plutil", ["-lint", "-s", file]);
      const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /__[A-Z_]+__/, label);
      assert.equal(plist.Label, label);
      assert.equal(plist.WorkingDirectory, REPO.replace(/\/$/, ""));
      assert.equal(plist.RunAtLoad, true);
      assert.equal(plist.EnvironmentVariables.HOME, home);
      assert.ok(plist.EnvironmentVariables.PATH.split(":").includes(path.dirname(process.execPath)));
      assert.ok(plist.EnvironmentVariables.PATH.split(":").includes(bin), "cloudflared's folder");
      for (const out of [plist.StandardOutPath, plist.StandardErrorPath]) {
        assert.equal(path.dirname(out), logDir, `${label}: ${out}`);
        assert.ok(!out.startsWith(REPO), `${label}: ${out} is in the repository`);
      }
      assert.equal(plist.StandardErrorPath, plist.StandardOutPath);
      for (const arg of plist.ProgramArguments) {
        if (arg.includes("/")) assert.ok(path.isAbsolute(arg), `${label}: ${arg}`);
      }
      assert.equal(plist.KeepAlive, label === "com.is.nightly" ? undefined : true, label);
    }
    const args = (label) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(agents, `${label}.plist`)], { encoding: "utf8" })).ProgramArguments;
    assert.deepEqual(args("com.is.strass"), ["/usr/bin/caffeinate", "-i", path.join(REPO, "services/strass/scripts/start.sh")]);
    assert.deepEqual(args("com.is.server"), [process.execPath, path.join(REPO, "src/server/index.js"), "--wait-for-strass"]);
    assert.deepEqual(args("com.is.tunnel"), [path.join(bin, "cloudflared"), "tunnel", "--config", path.join(home, ".cloudflared/config.yml"), "run", "is"]);
    assert.deepEqual(args("com.is.nightly"), [process.execPath, path.join(REPO, "src/ops/nightly.js")]);
    const nightly = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(agents, "com.is.nightly.plist")], { encoding: "utf8" }));
    assert.deepEqual(nightly.StartCalendarInterval, { Hour: 3, Minute: 30 });

    const configYml = readFileSync(path.join(home, ".cloudflared", "config.yml"), "utf8");
    assert.match(configYml, new RegExp(`^tunnel: ${TUNNEL_ID}$`, "m"));
    assert.match(configYml, new RegExp(`^credentials-file: ${home}/.cloudflared/${TUNNEL_ID}.json$`, "m"));
    assert.match(configYml, /- hostname: patternnifty\.com\n {4}service: http:\/\/127\.0\.0\.1:3003\n/);
    assert.match(configYml, /- hostname: www\.patternnifty\.com\n {4}service: http:\/\/127\.0\.0\.1:3003\n/);
    assert.match(configYml, /- service: http_status:404\n$/);
    assert.doesNotMatch(configYml.replace(/^#.*$/gm, ""), /localhost/);

    const calls = () => readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
    assert.deepEqual(calls().filter((c) => c.includes("bootstrap")),
      LABELS.map((l) => `launchctl bootstrap gui/${uid} ${path.join(agents, `${l}.plist`)}`));

    // Second run: config.yml is kept as it is, each agent is unloaded and loaded again.
    writeFileSync(path.join(home, ".cloudflared", "config.yml"), "# edited by hand\n");
    rmSync(path.join(root, "calls.log"));
    const again = run("install-agents.sh", root, bin);
    assert.match(again, /Kept the existing/);
    assert.equal(readFileSync(path.join(home, ".cloudflared", "config.yml"), "utf8"), "# edited by hand\n");
    assert.equal(calls().filter((c) => c.startsWith("cloudflared")).length, 0);
    assert.equal(calls().filter((c) => c.includes("bootout")).length, 4);
    assert.equal(calls().filter((c) => c.includes("bootstrap")).length, 4);

    // IS_LOG_DIR moves every agent's log; a folder inside the repository or a relative one is refused.
    const custom = path.join(root, "custom logs");
    assert.match(run("install-agents.sh", root, bin, { env: { IS_LOG_DIR: custom } }), /Logs: .*custom logs\//);
    for (const label of LABELS) {
      const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(agents, `${label}.plist`)], { encoding: "utf8" }));
      assert.equal(path.dirname(plist.StandardOutPath), custom, label);
      assert.equal(path.dirname(plist.StandardErrorPath), custom, label);
    }
    assert.match(run("install-agents.sh", root, bin, { env: { IS_LOG_DIR: path.join(REPO, "logs") }, status: 1 }), /outside the repository/);
    assert.match(run("install-agents.sh", root, bin, { env: { IS_LOG_DIR: "logs" }, status: 1 }), /absolute path/);

    run("uninstall-agents.sh", root, bin);
    run("uninstall-agents.sh", root, bin);
    assert.deepEqual(readdirSync(agents), []);
    assert.deepEqual(readdirSync(path.join(root, "loaded")), []);
    assert.ok(existsSync(path.join(home, ".cloudflared", "config.yml")), "uninstall leaves config.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(realAgents(), realBefore, "the real ~/Library/LaunchAgents is untouched");
  assert.equal(existsSync(realConfig) ? readFileSync(realConfig, "utf8") : null, realConfigBefore);
});
