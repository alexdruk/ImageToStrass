import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createPipeline } from "../src/pipeline/design.js";
import { createBackgroundRemover } from "../src/prep/background.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { CODES_PER_IP_PER_DAY, DAY_MS, parisDayStart } from "../src/server/limits.js";
import { createTurnstile } from "../src/server/turnstile.js";
import { MAX_UPLOAD_BYTES } from "../src/server/upload.js";
import { etsyTestConfig, noEtsy } from "./etsy-mock.mjs";

// Spec section 13 (PN-06): each limit is reached, the next request is refused with its IS error
// code, and the provider is never called for a refused request. The provider is a counting fake;
// requests come "through the tunnel" (CF-Connecting-IP), so each test picks the buyer's IP.

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const PHOTO = readFileSync(path.join(FIXTURES, "upload", "photo.png"));
const GOOD_LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/layout.json", import.meta.url), "utf8"));
// 193 stones: rejected by the acceptance check, so the design is re-run once (7.4).
const SMALL_LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/fake-layout.json", import.meta.url), "utf8"));
const AI_PNG = readFileSync(new URL("../src/pipeline/fake/ai.png", import.meta.url));
// A transparent 1 x 1 PNG: no hole fill, so the small layout stays below the acceptance minimum.
const EMPTY_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000970485973000003e8000003e801b57b526b0000000d494441540899636060606000000005000187a14ed40000000049454e44ae426082", "hex");
const SETTINGS = { upload: 1, mode: "colour", removeBackground: true };
const quiet = { error() {}, warn() {}, log() {} };

// draw(): what the fake provider answers (default: declined, which reaches the provider and so
// counts for the per-IP limit and the cap, but not for the code's 3 designs).
async function start({ env = {}, draw = async () => ({ error: "declined", detail: "x" }), layouts = null, verifyTurnstile = async () => true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "is-limits-"));
  const config = {
    ...loadConfig(env),
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    tmpDir: path.join(root, "tmp"),
    ipKeyFile: path.join(root, "ip-hash.key")
  };
  const db = openDatabase(":memory:");
  const q = createQueries(db);
  const calls = { provider: 0 };
  const clock = { offsetMs: 0 };
  const background = createBackgroundRemover({ config: { ...config, fake: true }, log: quiet });
  const pipeline = createPipeline({
    q, config, log: quiet,
    provider: { redraw: async (...args) => { calls.provider += 1; return draw(...args); } },
    layoutCall: async () => ({ layout: layouts ? layouts.shift() ?? GOOD_LAYOUT : GOOD_LAYOUT })
  });
  const app = createApp({
    db,
    config: { ...config, dataDir: root, etsy: etsyTestConfig(config.etsy, root) },
    deps: { verifyTurnstile, background, pipeline, request: noEtsy, now: () => new Date(Date.now() + clock.offsetMs) }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const from = (ip) => ({ host: "patternnifty.com", "cf-connecting-ip": ip });

  return {
    q, pipeline, calls, clock, url,
    async upload(ip, { code, token = "t", file = PHOTO } = {}) {
      const body = new FormData();
      body.append("consent", "1");
      body.append("cf-turnstile-response", token);
      if (code) body.append("code", code);
      body.append("image", new Blob([file]), "photo.png");
      const response = await fetch(`${url}/api/upload`, { method: "POST", body, headers: from(ip) });
      await background.idle();
      return { status: response.status, body: await response.json() };
    },
    async create(ip, code, { settings = SETTINGS, token = "t" } = {}) {
      const response = await fetch(`${url}/api/attempts/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...from(ip) },
        body: JSON.stringify({ ...settings, "cf-turnstile-response": token })
      });
      return { status: response.status, body: await response.json() };
    },
    // Create design and wait until it has finished.
    async design(ip, code) {
      const r = await this.create(ip, code);
      await pipeline.idle();
      return r;
    },
    async stop() {
      await pipeline.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const busy = (r, status) => assert.deepEqual([r.status, r.body], [status, { error: "busy" }]);

test("limits: the defaults are those of spec 13", () => {
  const config = loadConfig({});
  assert.equal(config.designsPerIpPerDay, 6);
  assert.equal(config.dailyDesignCap, 100);
  assert.equal(CODES_PER_IP_PER_DAY, 5);
  assert.equal(loadConfig({ IS_DESIGNS_PER_IP_PER_DAY: "2", IS_DAILY_DESIGN_CAP: "7" }).dailyDesignCap, 7);
});

test("limits: Turnstile is checked on Upload and Create design, and a token is used once", async () => {
  const sent = [];
  const verifyTurnstile = createTurnstile({
    secret: "real-secret",
    fetch: async (_url, options) => {
      const token = Object.fromEntries(options.body).response;
      sent.push(token);
      return { json: async () => ({ success: token.startsWith("good") }) };
    }
  });
  const srv = await start({ verifyTurnstile });
  try {
    assert.deepEqual(await srv.upload("203.0.113.1", { token: "bad" }), { status: 403, body: { error: "verification" } });
    const { code } = (await srv.upload("203.0.113.1", { token: "good-1" })).body;
    // The upload's token cannot be used again, for another upload or for Create design.
    assert.deepEqual(await srv.upload("203.0.113.1", { token: "good-1" }), { status: 403, body: { error: "verification" } });
    assert.deepEqual(await srv.create("203.0.113.1", code, { token: "good-1" }), { status: 403, body: { error: "verification" } });
    assert.deepEqual(await srv.create("203.0.113.1", code, { token: "bad" }), { status: 403, body: { error: "verification" } });
    assert.deepEqual(await srv.create("203.0.113.1", code, { token: "" }), { status: 403, body: { error: "verification" } });
    assert.equal(srv.calls.provider, 0);
    assert.equal(srv.q.listAttempts(code).length, 0);

    assert.equal((await srv.create("203.0.113.1", code, { token: "good-2" })).status, 202);
    await srv.pipeline.idle();
    assert.deepEqual(await srv.create("203.0.113.1", code, { token: "good-2" }), { status: 403, body: { error: "verification" } });
    assert.equal(srv.calls.provider, 1);
    // A reused token is refused here, without asking siteverify again.
    assert.deepEqual(sent, ["bad", "good-1", "bad", "good-2"]);
  } finally {
    await srv.stop();
  }
});

test("limits: 6 designs per IP in any 24 h, then busy; other IPs and the next day go on", async () => {
  const srv = await start();
  try {
    const { code } = (await srv.upload("203.0.113.2")).body;
    for (let i = 0; i < 6; i += 1) assert.equal((await srv.design("203.0.113.2", code)).status, 202, `design ${i + 1}`);
    assert.equal(srv.calls.provider, 6);

    busy(await srv.create("203.0.113.2", code), 429);
    assert.equal(srv.calls.provider, 6);
    assert.equal(srv.q.listAttempts(code).length, 6, "the refused design made no attempt");

    // The same code from another IP, and the first IP 24 h later (rolling window).
    assert.equal((await srv.design("203.0.113.3", code)).status, 202);
    srv.clock.offsetMs = DAY_MS + 1000;
    assert.equal((await srv.design("203.0.113.2", code)).status, 202);
    assert.equal(srv.calls.provider, 8);
  } finally {
    await srv.stop();
  }
});

test("limits: the daily cap (Paris day) answers busy; refused and invalid requests use none of it", async () => {
  const srv = await start({ env: { IS_DAILY_DESIGN_CAP: "3" } });
  try {
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await srv.upload(`198.51.100.${i + 1}`)).body.code);
    // Requests refused before the provider leave the cap alone: bad settings, a failed check.
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await srv.create("198.51.100.1", codes[0], { settings: { ...SETTINGS, mode: "sepia" } }), { status: 400, body: { error: "bad-request" } });
    }
    for (let i = 0; i < 3; i += 1) assert.equal((await srv.design(`198.51.100.${i + 1}`, codes[i])).status, 202);
    assert.equal(srv.calls.provider, 3);

    busy(await srv.create("198.51.100.4", codes[3]), 503);
    busy(await srv.create("198.51.100.1", codes[0]), 503);
    assert.equal(srv.calls.provider, 3);

    // The next calendar day in Paris starts a new count.
    srv.clock.offsetMs = parisDayStart(new Date(Date.now() + DAY_MS)).getTime() + 60_000 - Date.now();
    assert.equal((await srv.design("198.51.100.4", codes[3])).status, 202);
    assert.equal(srv.calls.provider, 4);
  } finally {
    await srv.stop();
  }
});

test("limits: an automatic re-run is one design for the cap and the per-IP limit", async () => {
  const srv = await start({
    env: { IS_DAILY_DESIGN_CAP: "1", IS_DESIGNS_PER_IP_PER_DAY: "1" },
    draw: async () => ({ png: EMPTY_PNG, width: 1024, height: 1024 }),
    layouts: [SMALL_LAYOUT, GOOD_LAYOUT]
  });
  try {
    const { code } = (await srv.upload("192.0.2.1")).body;
    assert.equal((await srv.design("192.0.2.1", code)).status, 202);
    // Rejected, then re-run: two provider calls, one design.
    assert.equal(srv.calls.provider, 2);
    const [first, second] = srv.q.listAttempts(code);
    assert.deepEqual([first.status, second.status, second.settings.rerunOf], ["failed", "done", 1]);
    assert.equal(srv.q.countDesignsSince(new Date(0).toISOString()), 1);

    busy(await srv.create("192.0.2.1", code), 503);
    assert.equal(srv.calls.provider, 2);
  } finally {
    await srv.stop();
  }
});

test("limits: 3 counted designs per code, then limit (also for uploads to that code)", async () => {
  const srv = await start({ draw: async () => ({ png: AI_PNG, width: 1024, height: 1024 }) });
  try {
    const { code } = (await srv.upload("192.0.2.9")).body;
    for (let i = 0; i < 3; i += 1) assert.equal((await srv.design("192.0.2.9", code)).status, 202);
    assert.equal(srv.calls.provider, 3);

    assert.deepEqual(await srv.create("192.0.2.9", code), { status: 409, body: { error: "limit" } });
    assert.deepEqual(await srv.create("192.0.2.10", code), { status: 409, body: { error: "limit" } });
    assert.deepEqual(await srv.upload("192.0.2.9", { code }), { status: 409, body: { error: "limit" } });
    assert.equal(srv.calls.provider, 3);
  } finally {
    await srv.stop();
  }
});

test("limits: 5 new codes per IP in any 24 h, then busy; uploads to an existing code go on", async () => {
  const srv = await start();
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await srv.upload("203.0.113.50");
      assert.equal(r.status, 201, `code ${i + 1}`);
      codes.push(r.body.code);
    }
    busy(await srv.upload("203.0.113.50"), 429);
    assert.equal(srv.q.countIpCodesSince(new Date(0).toISOString(), srv.q.getCode(codes[0]).ip_hash), 5);

    // A new image for a code it has, another IP, and the same IP a day later.
    assert.equal((await srv.upload("203.0.113.50", { code: codes[0] })).body.upload, 2);
    assert.equal((await srv.upload("203.0.113.51")).status, 201);
    srv.clock.offsetMs = DAY_MS + 1000;
    assert.equal((await srv.upload("203.0.113.50")).status, 201);
    assert.equal(srv.calls.provider, 0);
  } finally {
    await srv.stop();
  }
});

test("limits: at most 10 designs queued or running, then busy", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const srv = await start({ draw: async () => { await gate; return { error: "declined", detail: "x" }; } });
  try {
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await srv.upload(`198.18.0.${i + 1}`)).body.code);
    for (let i = 0; i < 10; i += 1) assert.equal((await srv.create(`198.18.0.${i + 1}`, codes[i])).status, 202, `design ${i + 1}`);
    assert.equal(srv.pipeline.queueLength(), 10);

    busy(await srv.create("198.18.0.11", codes[10]), 503);
    assert.equal(srv.calls.provider, 1, "only the running design reached the provider");
    release();
    await srv.pipeline.idle();
    assert.equal(srv.calls.provider, 10);
  } finally {
    release();
    await srv.stop();
  }
});

// A PNG whose header claims width x height (no pixels).
function pngWithHeader(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR");
  const chunk = Buffer.alloc(12 + 13);
  chunk.writeUInt32BE(13, 0);
  type.copy(chunk, 4);
  ihdr.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, ihdr])), 21);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk, Buffer.alloc(64)]);
}

test("limits: uploads over 50 MB, over 100 megapixels or with unsafe SVG are refused and make no code", async () => {
  const srv = await start();
  try {
    const over = Buffer.concat([PHOTO, Buffer.alloc(MAX_UPLOAD_BYTES + 1 - PHOTO.length)]);
    assert.deepEqual(await srv.upload("203.0.113.70", { file: over }), { status: 413, body: { error: "too-large" } });
    assert.deepEqual(await srv.upload("203.0.113.70", { file: pngWithHeader(10_001, 10_000) }), { status: 400, body: { error: "bad-file" } });
    for (const name of ["malicious-script.svg", "malicious-foreign-object.svg", "malicious-onload.svg", "malicious-external-href.svg"]) {
      const file = readFileSync(path.join(FIXTURES, "upload", name));
      assert.deepEqual(await srv.upload("203.0.113.70", { file }), { status: 400, body: { error: "bad-file" } }, name);
    }
    // None of them made a code, so this IP still has all 5.
    for (let i = 0; i < 5; i += 1) assert.equal((await srv.upload("203.0.113.70")).status, 201);
    assert.equal(srv.calls.provider, 0);
  } finally {
    await srv.stop();
  }
});

test("limits: parisDayStart follows Paris summer and winter time", () => {
  const at = (iso) => parisDayStart(new Date(iso)).toISOString();
  assert.equal(at("2026-10-27T10:00:00Z"), "2026-10-26T23:00:00.000Z");
  assert.equal(at("2026-07-01T12:00:00Z"), "2026-06-30T22:00:00.000Z");
  assert.equal(at("2026-07-01T21:59:00Z"), "2026-06-30T22:00:00.000Z");
  assert.equal(at("2026-07-01T22:00:00Z"), "2026-07-01T22:00:00.000Z");
  // The days the clocks change: 29 March 2026 (to summer time), 25 October 2026 (to winter time).
  assert.equal(at("2026-03-29T12:00:00Z"), "2026-03-28T23:00:00.000Z");
  assert.equal(at("2026-10-25T12:00:00Z"), "2026-10-24T22:00:00.000Z");
  assert.equal(at("2026-10-25T23:30:00Z"), "2026-10-25T23:00:00.000Z");
});
