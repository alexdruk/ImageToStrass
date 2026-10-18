import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { BW_DARK, BW_LIGHT, bwColour, lightness, mapBlackAndWhite } from "../src/pipeline/bw.js";
import sharp from "sharp";
import { MODEL_INPUT_SIDE, acceptLayout, modelInput, normalizeDesignSettings, subjectBox } from "../src/pipeline/design.js";
import { callLayoutService } from "../src/pipeline/layout.js";
import { IS_PROMPT_VERSION, buildPrompt } from "../src/pipeline/prompt.js";
import { IMAGE_EDITS_URL, createProvider } from "../src/pipeline/provider.js";
import { createQueue } from "../src/pipeline/queue.js";
import { TIERS, applyTier, chooseTier, naturalLayout, snapDown } from "../src/pipeline/tiers.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

// Unit tests of the pipeline parts (spec section 7). The prompt text is never printed.

const RS_V6_SHA256 = "8d07f1ac1abad6bfa624d46a336581dee810476aff52953491ca0e0ef888e6a5";
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const RS_SQUARE_LINE = "- Square image at the highest resolution available.";
const RS_MAIN_SIZE_LINE = "- Use one main stone size for the whole design. Make the stones large: about 60 stones across the full width of the image.";
const MAIN_SIZE_LINE = "- Use one main stone size for the whole design.";
const WHOLE_IMAGE_LINE = "- Use the whole image at the highest resolution available, in the same shape (width to height) as the uploaded image.";
const quiet = { warn() {}, error() {}, log() {} };

test("colour prompt is RS prompt v6 with the whole-image line and without the 60-stones sentence", () => {
  assert.equal(IS_PROMPT_VERSION, 3);
  const lines = buildPrompt({ mode: "colour" }).split("\n");
  const i = lines.indexOf(WHOLE_IMAGE_LINE);
  assert.equal(i, lines.indexOf("6. COMPOSITION") + 1, "first rule of section 6");
  assert.ok(!lines.some((l) => /longest side|\bmm\b|inches/.test(l)), "no size line");
  assert.ok(!lines.some((l) => /stones across|Make the stones large/.test(l)), "no 60-stones sentence");
  const m = lines.indexOf(MAIN_SIZE_LINE);
  assert.equal(m, lines.indexOf("1. STONES") + 3, "the other rules of section 1 are kept");
  lines[i] = RS_SQUARE_LINE;
  lines[m] = RS_MAIN_SIZE_LINE;
  assert.equal(sha(lines.join("\n")), RS_V6_SHA256);
});

test("black & white prompt replaces section 4 and the final check (Appendix A)", () => {
  const colour = buildPrompt({ mode: "colour" });
  const bw = buildPrompt({ mode: "bw" });
  assert.equal(bw.split("4. COLOURS")[0], colour.split("4. COLOURS")[0]);
  const section4 = bw.split("4. COLOURS")[1].split("5. DESIGN")[0];
  assert.ok(section4.includes(`Jet ${STONE_COLORS.jet.previewColor}, Crystal ${STONE_COLORS["crystal-clear"].previewColor}.`));
  assert.ok(!section4.includes("Siam"), "no palette line");
  const [bwDesign, bwCheck] = bw.split("5. DESIGN")[1].split("\n\nBefore finishing, ");
  const [colourDesign, colourCheck] = colour.split("5. DESIGN")[1].split("\n\nBefore finishing, ");
  assert.equal(bwDesign, colourDesign);
  assert.equal(bwCheck, colourCheck.replace("only the listed colours are used, skin and fur only from their ramps", "every stone is Jet or Crystal"));
  assert.ok(!/ramp|skin|fur/.test(bwCheck));
  assert.throws(() => buildPrompt({ mode: "grey" }));
});

// A provider with a scripted fetch. Each entry: a status + body, "reject", or "hang".
function scripted(entries) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, form: init.body, headers: init.headers });
    const next = entries.shift();
    if (next === "reject") throw new TypeError("fetch failed");
    if (next === "hang") {
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return { status: next.status, json: async () => next.body };
  };
  return { fetch, calls };
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const SETTINGS = { apiKey: "test-key", model: "test-model", quality: "high", timeoutMs: 50 };
const OPTIONS = { mode: "colour" };
const ok = { status: 200, body: { data: [{ b64_json: PNG_B64 }] } };
const refusal = { status: 400, body: { error: { message: "Your request was rejected by the safety system." } } };

test("provider sends the edit request and returns the PNG", async () => {
  const { fetch, calls } = scripted([ok]);
  const out = await createProvider({ settings: SETTINGS, fetch, logger: quiet }).redraw(Buffer.from("png"), OPTIONS);
  assert.ok(out.png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, IMAGE_EDITS_URL);
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
  const form = calls[0].form;
  assert.deepEqual(
    ["model", "quality", "size", "background", "output_format", "n"].map((k) => form.get(k)),
    ["test-model", "high", "auto", "transparent", "png", "1"]
  );
  assert.equal(form.get("prompt"), buildPrompt(OPTIONS));
});

test("provider reports the output's pixel size from the PNG header", async () => {
  const png = await sharp({ create: { width: 15, height: 10, channels: 4, background: "#00000000" } }).png().toBuffer();
  const { fetch } = scripted([{ status: 200, body: { data: [{ b64_json: png.toString("base64") }] } }]);
  const out = await createProvider({ settings: SETTINGS, fetch, logger: quiet }).redraw(Buffer.from("png"), OPTIONS);
  assert.deepEqual([out.width, out.height], [15, 10]);
});

test("provider: two attempts, safety refusal retried once, errors mapped to declined / failed", async () => {
  const run = async (entries) => {
    const s = scripted(entries);
    const out = await createProvider({ settings: SETTINGS, fetch: s.fetch, logger: quiet }).redraw(Buffer.from("png"), OPTIONS);
    return { out, calls: s.calls.length };
  };
  assert.ok((await run([{ status: 500, body: {} }, ok])).out.png);
  assert.ok((await run(["reject", ok])).out.png);
  assert.deepEqual(await run([refusal, refusal]), { out: { error: "declined", detail: "provider-declined" }, calls: 2 });
  assert.ok((await run([refusal, ok])).out.png);
  assert.deepEqual(await run(["reject", "reject"]), { out: { error: "failed", detail: "provider-unreachable" }, calls: 2 });
  assert.deepEqual(await run([{ status: 401, body: {} }]), { out: { error: "failed", detail: "provider-auth" }, calls: 1 });
  assert.deepEqual(await run([{ status: 200, body: { data: [] } }]), { out: { error: "failed", detail: "provider-no-image" }, calls: 1 });
  // A timeout is not retried.
  assert.deepEqual(await run(["hang", ok]), { out: { error: "failed", detail: "provider-timeout" }, calls: 1 });
});

test("provider: abort cancels the call and resolves null", async () => {
  const { fetch } = scripted(["hang"]);
  const controller = new AbortController();
  const pending = createProvider({ settings: { ...SETTINGS, timeoutMs: 10_000 }, fetch, logger: quiet })
    .redraw(Buffer.from("png"), OPTIONS, controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.equal(await pending, null);
});

test("layout client posts to /layout with all colour ids and pitch 2.1", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, options: JSON.parse(init.body.get("options")) };
    return { status: 200, json: async () => ({ stones: [] }) };
  };
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout };
  const signal = new AbortController().signal;
  const out = await callLayoutService({ fetch, timers, url: "http://127.0.0.1:8000/", timeoutMs: 1000, pngBuffer: Buffer.from("x"), colorIds: Object.keys(STONE_COLORS), signal });
  assert.deepEqual(out, { layout: { stones: [] } });
  assert.equal(seen.url, "http://127.0.0.1:8000/layout");
  assert.equal(seen.options.targetPitchMm, 2.1);
  assert.deepEqual(seen.options.colorIds, Object.keys(STONE_COLORS));
  const refused = async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; };
  const down = await callLayoutService({ fetch: refused, timers, url: "http://127.0.0.1:1", timeoutMs: 1000, pngBuffer: Buffer.from("x"), colorIds: [], signal });
  assert.equal(down.error.code, "layout-unavailable");
});

test("acceptance: violations 0, coverage >= 0.5, at least 300 stones", () => {
  const layout = (n, violations, coverage) => ({ stones: Array(n).fill([0, 0, "ss6", "jet"]), report: { violations, coverage } });
  assert.equal(acceptLayout(layout(300, 0, 0.5)).ok, true);
  assert.equal(acceptLayout(layout(299, 0, 0.9)).ok, false);
  assert.equal(acceptLayout(layout(500, 1, 0.9)).ok, false);
  assert.equal(acceptLayout(layout(500, 0, 0.49)).ok, false);
});

test("design settings: mode, background removal and adjustments only", () => {
  const s = normalizeDesignSettings({ upload: 1, mode: "bw" });
  assert.deepEqual([s.uploadId, s.mode, s.removeBackground], [1, "bw", true]);
  assert.deepEqual(Object.keys(normalizeDesignSettings({ upload: 2, size: 200, unit: "mm" })).sort(), ["adjustments", "mode", "removeBackground", "uploadId"]);
  for (const bad of [{ upload: 0 }, { upload: 1, mode: "sepia" }, { upload: 1, removeBackground: "yes" }]) {
    assert.throws(() => normalizeDesignSettings(bad), RangeError, JSON.stringify(bad));
  }
});

test("tiers: snapping reproduces the table of spec 7.5", () => {
  const table = { 1.0: ["ss6", "ss4", "ss16"], 1.4: ["ss10", "ss6", "ss20"], 2.0: ["ss16", "ss10", "ss30"], 2.35: ["ss20", "ss10", "ss30"], 3.2: ["ss30", "ss20", "ss30"] };
  assert.deepEqual(TIERS, [1.0, 1.4, 2.0, 2.35, 3.2]);
  for (const k of TIERS) {
    const got = ["ss6", "ss4", "ss16"].map((id) => snapDown(getStoneSize(id).diameterMm * k).id);
    assert.deepEqual(got, table[k], `tier ${k}`);
  }
  assert.equal(chooseTier(120, 140), 1.0);
  assert.equal(chooseTier(120, 168), 1.4);
  assert.equal(chooseTier(120, 239.9), 1.4);
  assert.equal(chooseTier(120, 240), 2.0);
  assert.equal(chooseTier(120, 600), 3.2);
});

test("tiers: longest side is exactly T, r >= 1, no gap violations", () => {
  // A 30 x 20 grid of SS6 stones at 2.3 mm pitch with two SS16 pupils and SS4 details.
  const stones = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 20; j++) stones.push([1 + i * 2.3, 1 + j * 2.3, "ss6", "jet"]);
  stones.push([80, 10, "ss16", "jet"], [80, 20, "ss4", "crystal-clear"]);
  const layout = { stones };
  for (const T of [140, 180, 250, 260, 300, 420, 600]) {
    const { stoneLayout, tier, gaps } = applyTier(layout, T);
    assert.ok(Math.abs(Math.max(stoneLayout.widthMm, stoneLayout.heightMm) - T) < 1e-6, `T ${T}`);
    const box = stoneLayout.getBoundingBox();
    assert.ok(Math.abs(box.minXmm) < 1e-9 && Math.abs(box.minYmm) < 1e-9, "origin top-left");
    assert.ok(tier.r >= 1 && tier.r >= tier.r0 - 1e-12);
    assert.ok(gaps.ok, JSON.stringify(gaps));
  }
});

test("tiers: a T below the natural size is refused (tiers never shrink)", () => {
  const stones = [];
  for (let i = 0; i < 80; i++) for (let j = 0; j < 10; j++) stones.push([1 + i * 2.3, 1 + j * 2.3, "ss6", "jet"]);
  assert.throws(() => applyTier({ stones }, 140), RangeError);
});

test("natural layout: as measured, footprint box at the origin, gap check", () => {
  const stones = [[10, 20, "ss6", "jet"], [12.2, 20, "ss6", "jet"], [15, 25, "ss16", "jet"]];
  const { stoneLayout, gaps } = naturalLayout({ stones });
  const r9 = (v) => Math.round(v * 1e9) / 1e9;
  assert.deepEqual(stoneLayout.stones.map((s) => [s.xMm, s.yMm, s.sizeMm].map(r9)), [[1, 1, 2], [3.2, 1, 2], [6, 6, 4]]);
  assert.ok(Math.abs(stoneLayout.widthMm - 8) < 1e-9 && Math.abs(stoneLayout.heightMm - 8) < 1e-9);
  assert.ok(gaps.ok);
  assert.equal(naturalLayout({ stones: [[0, 0, "ss6", "jet"], [1.9, 0, "ss6", "jet"]] }).gaps.ok, false);
});

test("natural layout: stones above SS16 become SS16 at the same centre, the box follows", () => {
  const stones = [[10, 10, "ss30", "jet"], [16, 10, "ss20", "jet"], [21, 10, "ss16", "jet"], [25, 10, "ss6", "jet"]];
  const { stoneLayout, gaps, capped } = naturalLayout({ stones });
  assert.equal(capped, 2);
  assert.deepEqual(stoneLayout.stones.map((s) => s.sizeMm), [4, 4, 4, 2]);
  const r9 = (v) => Math.round(v * 1e9) / 1e9;
  assert.deepEqual(stoneLayout.stones.map((s) => r9(s.xMm)), [2, 8, 13, 17], "centres kept, box from the capped stones");
  assert.equal(r9(stoneLayout.heightMm), 4);
  assert.ok(gaps.ok);
  // Two SS30 stones 0.4 mm into each other are 2 mm apart as SS16: the cap only widens gaps.
  assert.equal(naturalLayout({ stones: [[0, 0, "ss30", "jet"], [6, 0, "ss30", "jet"]] }).gaps.ok, true);
});

// A w x h RGBA PNG, transparent except an opaque rectangle.
function cutout(w, h, rect) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) data.set([200, 50, 50, 255], (y * w + x) * 4);
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

test("model input: background removal on crops to the subject plus 3 %, off keeps the frame; no padding", async () => {
  const png = await cutout(2000, 1000, { left: 1500, top: 100, width: 200, height: 400 });
  assert.deepEqual(await subjectBox(png), { left: 1500, top: 100, width: 200, height: 400 });

  // Margin 3 % of 400 = 12 px on every side: 224 x 424, scaled to 1024 on the long side.
  const cropped = await modelInput(png, { cropToSubject: true });
  const meta = await sharp(cropped).metadata();
  assert.deepEqual([meta.width, meta.height], [Math.round(224 * MODEL_INPUT_SIDE / 424), MODEL_INPUT_SIDE]);
  const box = await subjectBox(cropped);
  const margin = 12 * MODEL_INPUT_SIDE / 424;
  assert.ok(Math.abs(box.top - margin) <= 1 && Math.abs(box.left - margin) <= 1, JSON.stringify(box));

  // A subject at the image edge: the margin beyond the image is transparent.
  const edge = await modelInput(await cutout(500, 500, { left: 0, top: 0, width: 100, height: 100 }), { cropToSubject: true });
  const edgeBox = await subjectBox(edge);
  assert.equal((await sharp(edge).metadata()).width, MODEL_INPUT_SIDE);
  assert.ok(Math.abs(edgeBox.left - 3 * MODEL_INPUT_SIDE / 106) <= 1, JSON.stringify(edgeBox));

  // Off: the whole frame, aspect kept, no square padding.
  const whole = await sharp(await modelInput(png)).metadata();
  assert.deepEqual([whole.width, whole.height], [MODEL_INPUT_SIDE, MODEL_INPUT_SIDE / 2]);
  // Nothing opaque: nothing to crop to.
  const empty = await sharp(await modelInput(await cutout(300, 200, { left: 0, top: 0, width: 0, height: 0 }), { cropToSubject: true })).metadata();
  assert.deepEqual([empty.width, empty.height], [MODEL_INPUT_SIDE, Math.round(MODEL_INPUT_SIDE * 2 / 3)]);
});

test("black & white: L* of the catalogue fill against the threshold", () => {
  assert.ok(Math.abs(lightness("#000000")) < 1e-9);
  assert.ok(Math.abs(lightness("#ffffff") - 100) < 1e-6);
  assert.ok(Math.abs(lightness("#777777") - 50.03) < 0.05);
  assert.equal(bwColour("jet"), BW_DARK);
  assert.equal(bwColour("crystal-clear"), BW_LIGHT);
  assert.equal(bwColour("crystal"), BW_LIGHT);
  assert.equal(bwColour("hematite", 0), BW_LIGHT);
  assert.equal(bwColour("crystal-clear", 101), BW_DARK);
  const { stoneLayout } = naturalLayout({ stones: [[1, 1, "ss6", "siam"], [4, 1, "ss6", "silk"], [7, 1, "ss16", "jet"]] });
  const bw = mapBlackAndWhite(stoneLayout);
  assert.deepEqual(new Set(bw.stones.map((s) => s.color)), new Set([BW_DARK, BW_LIGHT]));
  assert.deepEqual(bw.stones.map((s) => [s.xMm, s.yMm, s.sizeMm]), stoneLayout.stones.map((s) => [s.xMm, s.yMm, s.sizeMm]));
});

test("queue: one at a time, in order, re-runs first, limit", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createQueue({ limit: 3, log: quiet, run: async (id) => { order.push(id); if (id === "a") await gate; } });
  assert.equal(queue.add("a"), true);
  assert.equal(queue.add("b"), true);
  assert.equal(queue.add("c"), true);
  assert.equal(queue.add("d"), false, "full");
  assert.equal(queue.add("r", { front: true }), true, "a re-run skips the limit");
  assert.deepEqual([queue.position("a"), queue.position("r"), queue.position("b"), queue.position("c"), queue.position("d")], [0, 1, 2, 3, null]);
  assert.equal(queue.length(), 4);
  release();
  await queue.idle();
  assert.deepEqual(order, ["a", "r", "b", "c"]);
  assert.equal(queue.length(), 0);
});
