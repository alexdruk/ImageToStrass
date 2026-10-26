import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createPipeline } from "../src/pipeline/design.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { createBackgroundRemover } from "../src/prep/background.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { etsyTestConfig, noEtsy } from "./etsy-mock.mjs";

// The design pipeline end to end (spec section 7, D5): IS_FAKE=1 through HTTP, and the re-run,
// declined and failed paths with a scripted provider and layout.

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const PHOTO = readFileSync(path.join(FIXTURES, "upload", "photo.png"));
const GOOD_LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/layout.json", import.meta.url), "utf8"));
// RS's fake layout: 193 stones, below the 300-stone acceptance minimum.
const SMALL_LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/fake-layout.json", import.meta.url), "utf8"));
// A transparent 1 x 1 PNG (the pipeline decodes the AI image for the hole fill and black & white).
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000970485973000003e8000003e801b57b526b0000000d494441540899636060606000000005000187a14ed40000000049454e44ae426082", "hex");
// The fake design: the fake layout after the cap, the cleanup and the hole fill from the fake AI image.
const FAKE_AI = await sharp(new URL("../src/pipeline/fake/ai.png", import.meta.url).pathname).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => ({ data, width: info.width, height: info.height }));
const NATURAL = cleanedLayout(GOOD_LAYOUT, { fillHolesIn: FAKE_AI }).stoneLayout;
const round1 = (v) => Math.round(v * 10) / 10;
const quiet = { error() {}, warn() {}, log() {} };
const LEAK = /openai|gpt|dall|prompt|sunburst/i;

async function start({ env = { IS_FAKE: "1" }, pipelineDeps = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "is-pipeline-"));
  const config = {
    ...loadConfig(env),
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    tmpDir: path.join(root, "tmp"),
    ipKeyFile: path.join(root, "ip-hash.key")
  };
  const db = openDatabase(":memory:");
  const q = createQueries(db);
  // The cut-out is always the fake one (a copy of work.png); only the pipeline runs in real mode.
  const background = createBackgroundRemover({ config: { ...config, fake: true }, log: quiet });
  const pipeline = createPipeline({ q, config, log: quiet, ...(pipelineDeps || {}) });
  const app = createApp({ db, config: { ...config, dataDir: root, etsy: etsyTestConfig(config.etsy, root) }, deps: { verifyTurnstile: async () => true, background, pipeline, request: noEtsy } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    config, q, pipeline, url,
    async upload() {
      const body = new FormData();
      body.append("consent", "1");
      body.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
      const r = await (await fetch(`${url}/api/upload`, { method: "POST", body })).json();
      await background.idle();
      return r;
    },
    async create(code, settings) {
      const response = await fetch(`${url}/api/attempts/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async poll(code, n) {
      const response = await fetch(`${url}/api/attempts/${code}/${n}`);
      return { status: response.status, body: await response.json(), text: JSON.stringify([...response.headers]) };
    },
    async stop() {
      await pipeline.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const SETTINGS = { upload: 1, mode: "colour", removeBackground: true, adjustments: { brightness: 10 } };

test("fake mode: Create design runs end to end and writes the archive", async () => {
  const srv = await start();
  try {
    const { code } = await srv.upload();
    const created = await srv.create(code, SETTINGS);
    assert.equal(created.status, 202);
    assert.equal(created.body.attempt, 1);
    assert.ok(["queued", "running"].includes(created.body.status));
    assert.equal(created.body.queue.length, 1);

    // A second design while the first is in flight is refused.
    assert.deepEqual((await srv.create(code, SETTINGS)).body, { error: "busy" });

    await srv.pipeline.idle();
    const done = await srv.poll(code, 1);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "done");
    assert.equal(done.body.designsLeft, 2);
    const result = done.body.result;
    assert.equal(result.stones, NATURAL.count);
    assert.ok(NATURAL.count > GOOD_LAYOUT.stones.length, "the fake design has filled holes");
    // Natural size only (7.5), in mm and in.
    assert.deepEqual([result.widthMm, result.heightMm], [round1(NATURAL.widthMm), round1(NATURAL.heightMm)]);
    assert.equal(result.widthIn, Math.round(NATURAL.widthMm / 25.4 * 100) / 100);
    assert.equal(result.heightIn, Math.round(NATURAL.heightMm / 25.4 * 100) / 100);
    assert.equal(result.mode, "colour");
    for (const gone of ["tier", "stretch", "requestedMm", "outputPx"]) assert.ok(!(gone in result), gone);
    assert.equal(Object.values(result.bySize).reduce((a, b) => a + b, 0), result.stones);
    assert.ok(!LEAK.test(JSON.stringify(done.body)) && !LEAK.test(done.text), "IS fields only");

    const dir = path.join(srv.config.archiveDir, code, "attempt-1");
    assert.deepEqual(readdirSync(dir).sort(), ["ai.png", "layout.json", "original.png", "prepared.png", "settings.json", "stones.json", "tinted.png"]);
    const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.equal(settings.uploadId, 1);
    for (const gone of ["size", "unit", "sizeMm"]) assert.ok(!(gone in settings), gone);
    const stones = JSON.parse(readFileSync(path.join(dir, "stones.json"), "utf8"));
    assert.equal(stones.count, result.stones);
    assert.ok(Math.abs(stones.widthMm - NATURAL.widthMm) < 1e-9 && Math.abs(stones.heightMm - NATURAL.heightMm) < 1e-9);

    const row = srv.q.getAttempt(code, 1);
    assert.deepEqual([row.status, row.counts, row.stage], ["done", 1, "files"]);
    assert.equal(srv.q.getCode(code).attempts_used, 1);
    assert.equal(JSON.parse(readFileSync(path.join(srv.config.archiveDir, code, "code.json"), "utf8")).attempts_used, 1);
  } finally {
    await srv.stop();
  }
});

test("fake mode: black & white uses Jet and Crystal only; 3 designs per code", async () => {
  const srv = await start();
  try {
    const { code } = await srv.upload();
    for (const n of [1, 2, 3]) {
      const created = await srv.create(code, { ...SETTINGS, mode: n === 2 ? "bw" : "colour" });
      assert.equal(created.status, 202, `design ${n}`);
      await srv.pipeline.idle();
    }
    const bw = (await srv.poll(code, 2)).body.result;
    assert.deepEqual(Object.keys(bw.byColour).sort(), ["crystal-clear", "jet"]);
    assert.deepEqual([bw.widthMm, bw.heightMm], [round1(NATURAL.widthMm), round1(NATURAL.heightMm)]);
    assert.deepEqual((await srv.create(code, SETTINGS)).body, { error: "limit" });
    assert.equal((await srv.poll(code, 3)).body.designsLeft, 0);
  } finally {
    await srv.stop();
  }
});

// A poll timed from just before it is sent: { ms, body }.
async function timedPoll(env, code, n) {
  const t0 = performance.now();
  const { body } = await env.poll(code, n);
  return { ms: performance.now() - t0, body };
}

// Polls every 20 ms while busy() is true; their times.
async function pollWhile(env, code, n, busy) {
  const times = [];
  while (busy()) {
    times.push((await timedPoll(env, code, n)).ms);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return times;
}

test("renders run off the main thread: a poll is answered within 200 ms while one runs", async () => {
  const env = await start();
  try {
    const { code } = await env.upload();
    const created = await env.create(code, SETTINGS);
    const n = created.body.attempt;

    // The design's full render ("Preparing files"): polls sent once that stage was seen, while it
    // is still running.
    let first;
    do first = await timedPoll(env, code, n);
    while (first.body.status !== "done" && first.body.stage !== "files");
    const during = [];
    for (;;) {
      const p = await timedPoll(env, code, n);
      if (p.body.status !== "running") break;
      during.push(p.ms);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await env.poll(code, n)).body.status, "done");
    assert.ok(during.length >= 5, `${during.length} polls during the render`);
    assert.ok(Math.max(...during) < 200, `render: slowest poll ${Math.max(...during).toFixed(0)} ms`);

    // The watermarked preview, rendered on first request.
    let previewDone = false;
    const preview = fetch(`${env.url}/api/attempts/${code}/${n}/tinted.png`).then(async (r) => {
      await r.arrayBuffer();
      previewDone = true;
      return r.status;
    });
    const previewTimes = await pollWhile(env, code, n, () => !previewDone);
    assert.equal(await preview, 200);
    assert.ok(previewTimes.length >= 3, `${previewTimes.length} polls during the preview`);
    assert.ok(Math.max(...previewTimes) < 200, `preview: slowest poll ${Math.max(...previewTimes).toFixed(0)} ms`);

    // The delivery ZIP, built when the code becomes paid.
    let paidDone = false;
    const paid = fetch(`${env.url}/api/test/payment/${code}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "paid" })
    }).then(async (r) => {
      paidDone = true;
      return (await r.json()).state;
    });
    const zipTimes = await pollWhile(env, code, n, () => !paidDone);
    assert.equal(await paid, "ready");
    assert.ok(existsSync(path.join(env.config.deliveryDir, code, `${code}.zip`)));
    assert.ok(zipTimes.length >= 3, `${zipTimes.length} polls during the ZIP build`);
    assert.ok(Math.max(...zipTimes) < 200, `ZIP: slowest poll ${Math.max(...zipTimes).toFixed(0)} ms`);
  } finally {
    await env.stop();
  }
});

test("Create design refuses bad settings, unknown codes and a missing cut-out", async () => {
  const srv = await start();
  try {
    const { code } = await srv.upload();
    assert.deepEqual((await srv.create(code, { ...SETTINGS, mode: "sepia" })).body, { error: "bad-request" });
    assert.deepEqual((await srv.create(code, { ...SETTINGS, upload: 2 })).body, { error: "not-found" });
    assert.equal((await srv.create("IS-0000-0000", SETTINGS)).status, 404);
    rmSync(path.join(srv.config.archiveDir, code, "uploads", "1", "cutout.png"));
    assert.deepEqual((await srv.create(code, SETTINGS)).body, { error: "not-ready" });
    assert.equal((await srv.create(code, { ...SETTINGS, removeBackground: false })).status, 202);
    assert.equal((await srv.poll(code, 9)).status, 404);
  } finally {
    await srv.stop();
  }
});

// A pipeline in real mode whose provider and layout answers are scripted.
function scripted({ draws, layouts }) {
  const calls = { draw: 0, layout: 0 };
  return {
    calls,
    deps: {
      provider: { redraw: async () => { calls.draw++; return draws.shift(); } },
      layoutCall: async () => { calls.layout++; return layouts.shift(); }
    }
  };
}

test("black & white style: the attempt's settings choose the prompt; Bold is the default; re-runs keep it", async () => {
  const options = [];
  const deps = {
    provider: { redraw: async (_png, o) => { options.push(o); return { png: PNG, width: 1024, height: 1024 }; } },
    layoutCall: async () => ({ layout: options.length === 1 ? SMALL_LAYOUT : GOOD_LAYOUT })
  };
  const srv = await start({ env: {}, pipelineDeps: deps });
  try {
    const { code } = await srv.upload();
    // Shaded: the first layout is rejected, and the automatic re-run keeps the style.
    await srv.create(code, { ...SETTINGS, mode: "bw", bwStyle: "halftone" });
    await srv.pipeline.idle();
    await srv.create(code, { ...SETTINGS, mode: "bw" });
    await srv.pipeline.idle();
    await srv.create(code, { ...SETTINGS, bwStyle: "halftone" });
    await srv.pipeline.idle();
    assert.deepEqual(options, [
      { mode: "bw", bwStyle: "halftone" }, { mode: "bw", bwStyle: "halftone" },
      { mode: "bw", bwStyle: "stencil" }, { mode: "colour", bwStyle: "stencil" }
    ]);
    assert.deepEqual([1, 2, 3, 4].map((n) => srv.q.getAttempt(code, n).settings.bwStyle), ["halftone", "halftone", "stencil", undefined]);
    assert.deepEqual([2, 3, 4].map((n) => srv.q.getAttempt(code, n).result.bwStyle), ["halftone", "stencil", undefined]);
    const saved = JSON.parse(readFileSync(path.join(srv.config.archiveDir, code, "attempt-2", "settings.json"), "utf8"));
    assert.equal(saved.bwStyle, "halftone");
    assert.deepEqual((await srv.create(code, { ...SETTINGS, mode: "bw", bwStyle: "dots" })).body, { error: "bad-request" });
  } finally {
    await srv.stop();
  }
});

test("a rejected layout is re-run once automatically and does not count", async () => {
  const s = scripted({
    draws: [{ png: PNG, width: 1024, height: 1536 }, { png: PNG, width: 1536, height: 1024 }],
    layouts: [{ layout: SMALL_LAYOUT }, { layout: GOOD_LAYOUT }]
  });
  const srv = await start({ env: {}, pipelineDeps: s.deps });
  try {
    const { code } = await srv.upload();
    await srv.create(code, SETTINGS);
    await srv.pipeline.idle();
    assert.deepEqual(s.calls, { draw: 2, layout: 2 });
    const first = srv.q.getAttempt(code, 1);
    assert.deepEqual([first.status, first.counts, first.result.rerunAs], ["failed", 0, 2]);
    assert.equal(first.result.rejected.stones, 193);
    const second = srv.q.getAttempt(code, 2);
    assert.deepEqual([second.status, second.counts, second.settings.rerunOf], ["done", 1, 1]);
    // The provider output's pixel size is recorded on the server and never shown.
    assert.deepEqual(first.result.outputPx, { width: 1024, height: 1536 });
    assert.deepEqual(second.result.outputPx, { width: 1536, height: 1024 });
    // The browser polls attempt 1 and is shown the re-run.
    const view = (await srv.poll(code, 1)).body;
    assert.deepEqual([view.attempt, view.status, view.designsLeft], [2, "done", 2]);
    assert.ok(existsSync(path.join(srv.config.archiveDir, code, "attempt-2", "prepared.png")));
    assert.ok(!("rejected" in view) && !("rerunAs" in view) && !("outputPx" in view.result));
  } finally {
    await srv.stop();
  }
});

test("a second rejection fails without counting; refusals of the drawn image re-run too", async () => {
  const refusal = { error: { code: "layout-failed", message: "no-stones: fewer than 50 stones were detected" } };
  const s = scripted({ draws: [{ png: PNG }, { png: PNG }], layouts: [refusal, { layout: SMALL_LAYOUT }] });
  const srv = await start({ env: {}, pipelineDeps: s.deps });
  try {
    const { code } = await srv.upload();
    await srv.create(code, SETTINGS);
    await srv.pipeline.idle();
    const view = (await srv.poll(code, 1)).body;
    assert.deepEqual([view.attempt, view.status, view.error, view.designsLeft], [2, "failed", "failed", 3]);
    assert.equal(srv.q.countedAttempts(code), 0);
    assert.equal(srv.q.getAttempt(code, 2).result.rerunAs, undefined);
  } finally {
    await srv.stop();
  }
});

test("declined and failed designs do not count and show IS error codes only", async () => {
  const s = scripted({
    draws: [{ error: "declined", detail: "provider-declined" }, { error: "failed", detail: "provider-timeout" }, { png: PNG }],
    layouts: [{ error: { code: "layout-unavailable", message: "The layout service at x is not running." } }]
  });
  const srv = await start({ env: {}, pipelineDeps: s.deps });
  try {
    const { code } = await srv.upload();
    for (const [n, status, error] of [[1, "declined", "declined"], [2, "failed", "failed"], [3, "failed", "failed"]]) {
      await srv.create(code, SETTINGS);
      await srv.pipeline.idle();
      const { body } = await srv.poll(code, n);
      assert.deepEqual([body.status, body.error, body.designsLeft], [status, error, 3], `attempt ${n}`);
      assert.ok(!LEAK.test(JSON.stringify(body)) && !/layout-|provider-/.test(JSON.stringify(body)));
    }
    assert.deepEqual(s.calls, { draw: 3, layout: 1 });
    assert.equal(srv.q.countedAttempts(code), 0);
    assert.ok(!existsSync(path.join(srv.config.archiveDir, code, "attempt-1", "ai.png")));
    assert.ok(existsSync(path.join(srv.config.archiveDir, code, "attempt-3", "ai.png")));
  } finally {
    await srv.stop();
  }
});

test("queue: position and length are shown; the queue limit answers busy", async () => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const drawing = new Promise((resolve) => { entered = resolve; });
  const deps = {
    provider: { redraw: async () => { entered(); await gate; return { png: PNG }; } },
    layoutCall: async () => ({ layout: GOOD_LAYOUT }),
    queueLimit: 2
  };
  const srv = await start({ env: {}, pipelineDeps: deps });
  try {
    const a = (await srv.upload()).code;
    const b = (await srv.upload()).code;
    const c = (await srv.upload()).code;
    assert.equal((await srv.create(a, SETTINGS)).status, 202);
    const second = await srv.create(b, SETTINGS);
    assert.deepEqual(second.body.queue, { position: 1, length: 2 });
    const full = await srv.create(c, SETTINGS);
    assert.deepEqual([full.status, full.body], [503, { error: "busy" }]);
    await drawing;
    assert.equal((await srv.poll(a, 1)).body.stage, "designing");
    release();
    await srv.pipeline.idle();
    assert.equal((await srv.poll(b, 1)).body.status, "done");
  } finally {
    release();
    await srv.stop();
  }
});

test("restart: a running design fails without counting, a queued one runs again", async () => {
  const srv = await start();
  try {
    const { code } = await srv.upload();
    const other = (await srv.upload()).code;
    await srv.create(code, SETTINGS);
    await srv.create(other, SETTINGS);
    await srv.pipeline.idle();
    // Simulate a stop: attempt 1 of `code` was running, a new attempt of `other` was queued.
    srv.q.updateAttempt(code, 1, { status: "running", counts: 0 });
    const queued = srv.q.createAttempt(other, srv.q.getAttempt(other, 1).settings);
    const { writeAttemptInputs, attemptDir } = await import("../src/prep/archive.js");
    const from = attemptDir(srv.config.archiveDir, other, 1);
    writeAttemptInputs(srv.config.archiveDir, other, queued.n, {
      originalFile: path.join(from, "original.png"),
      preparedPng: readFileSync(path.join(from, "prepared.png")),
      settings: queued.settings
    });
    const fresh = createPipeline({ q: srv.q, config: srv.config, log: quiet });
    fresh.recover();
    await fresh.idle();
    assert.deepEqual([srv.q.getAttempt(code, 1).status, srv.q.getAttempt(code, 1).counts], ["failed", 0]);
    assert.equal(srv.q.getAttempt(other, queued.n).status, "done");
  } finally {
    await srv.stop();
  }
});
