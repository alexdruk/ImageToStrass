import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { attemptDir, storeNew, uploadDir, writeAttemptInputs, writeCodeJson } from "../prep/archive.js";
import { normalizeSettings } from "../prep/adjust.js";
import { aiImageForArchive } from "../prep/pngmeta.js";
import { preparePng } from "../prep/prepare.js";
import { renderFullOffThread } from "../render/offthread.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { findStoneSizeByDiameterMm } from "../stones/StoneSizes.js";
import { mapBlackAndWhiteFromImage } from "./bw.js";
import { cleanedLayout } from "./cleanup.js";
import { callLayoutService } from "./layout.js";
import { DEFAULT_TIMERS, createProvider } from "./provider.js";
import { QUEUE_LIMIT, createQueue } from "./queue.js";

// The design pipeline (spec section 7): Create design -> attempt row and archive inputs -> queue ->
// model input -> provider -> layout -> natural size (SS16 cap, overlap cleanup) -> acceptance (one
// automatic re-run) -> B&W -> stones.json and the full tinted render (section 8, in the render
// worker, so the server keeps answering meanwhile) -> result.
//
// Attempts accounting (D5, section 4.1): an attempt counts (counts = 1) only when it is done. A
// failed, declined or re-run attempt has counts = 0. A code makes a new design only while it is
// open, has fewer than 3 counted designs and has no design queued or running, so it can never
// pass 3. Every attempt, re-runs included, gets its own n and attempt-<n>/ folder.

export const DESIGNS_PER_CODE = 3;
export const STAGES = Object.freeze(["preparing", "designing", "placing", "files"]);
export const MODEL_INPUT_SIDE = 1024;
export const MM_PER_INCH = 25.4;

// Model input crop with background removal on (spec 7.1): the cut-out's box (alpha at or above
// SUBJECT_ALPHA) plus SUBJECT_MARGIN of the box's longest side on every side.
export const SUBJECT_ALPHA = 128;
export const SUBJECT_MARGIN = 0.03;

// Acceptance (spec section 7.4).
export const MIN_STONES = 300;
export const MIN_COVERAGE = 0.5;
export const MAX_REMOVED_SHARE = 0.03;

// Layout service refusals caused by the drawn image itself; like a failed acceptance check they
// lead to the automatic re-run.
const IMAGE_REFUSALS = ["no-stones", "no-alpha"];

const ACTIVE = new Set(["queued", "running"]);
// IS_FAKE=1: the fake layout's own stones as its AI image (tools/make-fake-ai.mjs), so the hole fill
// and black & white read the image the layout came from.
const FAKE_PNG = readFileSync(new URL("./fake/ai.png", import.meta.url));
const FAKE_LAYOUT = JSON.parse(readFileSync(new URL("./fake/layout.json", import.meta.url), "utf8"));

export class DesignRefused extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// The buyer's choices (spec sections 6.3, 6.4) -> the settings stored with the attempt. There is no
// size: every design has its natural size (7.5).
export function normalizeDesignSettings(input) {
  if (!input || typeof input !== "object") throw new RangeError("settings must be an object.");
  const upload = input.upload;
  if (!Number.isInteger(upload) || upload < 1) throw new RangeError("upload must be a positive integer.");
  const mode = input.mode ?? "colour";
  if (mode !== "colour" && mode !== "bw") throw new RangeError("mode must be colour or bw.");
  const removeBackground = input.removeBackground ?? true;
  if (typeof removeBackground !== "boolean") throw new RangeError("removeBackground must be true or false.");

  return {
    uploadId: upload,
    removeBackground,
    adjustments: normalizeSettings(input.adjustments ?? {}),
    mode
  };
}

// The box { left, top, width, height } of the pixels with alpha >= SUBJECT_ALPHA, or null if none.
export async function subjectBox(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + channels - 1] < SUBJECT_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// prepared.png -> the model input (7.1). With background removal on, cropped to the cut-out's box
// plus the margin; margin beyond the image is transparent. Then resized to MODEL_INPUT_SIDE on the
// longest side, aspect kept, no padding.
export async function modelInput(preparedPng, { cropToSubject = false } = {}) {
  let png = preparedPng;
  const box = cropToSubject ? await subjectBox(png) : null;
  if (box) {
    const { width, height } = await sharp(png).metadata();
    const m = Math.round(SUBJECT_MARGIN * Math.max(box.width, box.height));
    const left = box.left - m, top = box.top - m, right = box.left + box.width + m, bottom = box.top + box.height + m;
    const inside = { left: Math.max(0, left), top: Math.max(0, top) };
    inside.width = Math.min(width, right) - inside.left;
    inside.height = Math.min(height, bottom) - inside.top;
    png = await sharp(png)
      .ensureAlpha()
      .extract(inside)
      .extend({
        left: inside.left - left, top: inside.top - top, right: right - inside.left - inside.width,
        bottom: bottom - inside.top - inside.height, background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
  }
  return sharp(png)
    .resize(MODEL_INPUT_SIDE, MODEL_INPUT_SIDE, { fit: "inside" })
    .png()
    .toBuffer();
}

// The design after the SS16 cap and the overlap cleanup (7.5) -> { ok, stones, removed,
// removedShare, coverage, violations }: accepted when fewer than 3 % of the stones were removed, the
// coverage is still at least 0.5, the IS gap check finds no violation and at least 300 stones are
// left. The service's own violation count is not used.
export function acceptLayout(cleaned) {
  const { stoneLayout, removed, removedShare, coverage, gaps } = cleaned;
  const violations = gaps.belowMinGap;
  return {
    ok: removedShare < MAX_REMOVED_SHARE && coverage >= MIN_COVERAGE && violations === 0 && stoneLayout.count >= MIN_STONES,
    stones: stoneLayout.count,
    removed,
    removedShare: Math.round(removedShare * 10000) / 10000,
    coverage: Math.round(coverage * 1000) / 1000,
    violations
  };
}

function countBy(stones, keyOf) {
  const counts = {};
  for (const stone of stones) {
    const key = keyOf(stone);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

// result_json (spec section 7.7). outputPx (the provider output's pixel size) stays on the server.
export function designResult(stoneLayout, { coverage, settings, outputPx }) {
  const round = (v, p = 1) => Math.round(v * 10 ** p) / 10 ** p;
  return {
    stones: stoneLayout.count,
    bySize: countBy(stoneLayout.stones, (s) => findStoneSizeByDiameterMm(s.sizeMm)?.id ?? `${s.sizeMm}mm`),
    byColour: countBy(stoneLayout.stones, (s) => s.color),
    widthMm: round(stoneLayout.widthMm),
    heightMm: round(stoneLayout.heightMm),
    widthIn: round(stoneLayout.widthMm / MM_PER_INCH, 2),
    heightIn: round(stoneLayout.heightMm / MM_PER_INCH, 2),
    coverage,
    mode: settings.mode,
    outputPx
  };
}

async function rgbaOf(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function originalIn(dir) {
  const name = readdirSync(dir).find((f) => f.startsWith("original."));
  return name ? path.join(dir, name) : null;
}

// provider ({ redraw }) and layoutCall ((png, signal) -> callLayoutService answer) replace the real
// ones in tests; IS_FAKE=1 replaces both with the fixtures in fake/.
export function createPipeline({
  q, config, fetch = globalThis.fetch, provider = null, layoutCall = null, timers = DEFAULT_TIMERS,
  log = console, queueLimit = QUEUE_LIMIT
}) {
  const redraw = config.fake
    ? async () => ({ png: FAKE_PNG })
    : (provider || createProvider({ settings: config.provider, fetch, timers, logger: log })).redraw;
  const layoutOf = config.fake
    ? async () => ({ layout: FAKE_LAYOUT })
    : layoutCall || ((pngBuffer, signal) => callLayoutService({
      fetch, timers, url: config.strassServiceUrl, timeoutMs: config.layoutTimeoutMs, pngBuffer,
      colorIds: Object.keys(STONE_COLORS), signal
    }));
  const stopping = new AbortController();
  const queue = createQueue({ run: (id) => run(id), limit: queueLimit, log });

  const idOf = (code, n) => `${code}/${n}`;

  function codeChanged(code) {
    q.updateCode(code, { attempts_used: q.countedAttempts(code) });
    writeCodeJson(config.archiveDir, q.getCode(code));
  }

  function finish(code, n, status, fields, event) {
    q.updateAttempt(code, n, { status, finished_at: new Date().toISOString(), counts: 0, ...fields });
    q.logEvent(`design-${status}`, { code, detail: { n, ...event } });
    codeChanged(code);
  }

  const fail = (code, n, reason, extra = {}) => finish(code, n, "failed", { error_code: "failed", ...extra }, { reason });

  // A rejected design is made again once, as a new attempt, ahead of the queue (7.4).
  function rerunOrFail(code, n, settings, check, outputPx) {
    if (settings.rerunOf) {
      fail(code, n, "rejected", { result: { rejected: check, outputPx } });
      return;
    }
    const dir = attemptDir(config.archiveDir, code, n);
    const again = q.createAttempt(code, { ...settings, rerunOf: n });
    writeAttemptInputs(config.archiveDir, code, again.n, {
      originalFile: originalIn(dir),
      preparedPng: readFileSync(path.join(dir, "prepared.png")),
      settings: again.settings
    });
    fail(code, n, "rejected", { result: { rejected: check, outputPx, rerunAs: again.n } });
    q.logEvent("design-queued", { code, detail: { n: again.n, rerunOf: n } });
    queue.add(idOf(code, again.n), { front: true });
  }

  async function run(id) {
    const [code, nText] = id.split("/");
    const n = Number(nText);
    const attempt = q.getAttempt(code, n);
    if (!attempt || attempt.status !== "queued") return;
    const { settings } = attempt;
    const dir = attemptDir(config.archiveDir, code, n);
    const stage = (name) => q.updateAttempt(code, n, { status: "running", stage: name });

    try {
      stage("preparing");
      const input = await modelInput(readFileSync(path.join(dir, "prepared.png")), { cropToSubject: settings.removeBackground });

      stage("designing");
      const drawn = await redraw(input, { mode: settings.mode }, stopping.signal);
      if (!drawn) return fail(code, n, "cancelled");
      if (drawn.error === "declined") return finish(code, n, "declined", { error_code: "declined" }, { reason: drawn.detail });
      if (drawn.error) return fail(code, n, drawn.detail);
      // Archived without metadata (text, XMP, EXIF, C2PA chunks can name the provider); the layout
      // service gets the same pixels.
      const aiPng = await aiImageForArchive(drawn.png);
      storeNew(dir, "ai.png", aiPng);
      const outputPx = { width: drawn.width, height: drawn.height };

      stage("placing");
      const placed = await layoutOf(aiPng, stopping.signal);
      if (placed.cancelled) return fail(code, n, "cancelled");
      if (placed.error) {
        const refusal = IMAGE_REFUSALS.find((c) => placed.error.message.startsWith(`${c}:`));
        log.error(`Layout for ${id} failed: ${placed.error.code} ${placed.error.message}`);
        if (refusal) return rerunOrFail(code, n, settings, { refusal }, outputPx);
        return fail(code, n, placed.error.code);
      }
      storeNew(dir, "layout.json", `${JSON.stringify(placed.layout)}\n`);
      // Natural size: SS16 cap, overlap cleanup and hole fill (7.5; config.fillHoles, off with
      // IS_FILL_HOLES=0; filled stones, and with config.serviceFillNeighbours the service's fill
      // stones, in their neighbours' colour), then acceptance (7.4) on the result. Black & white reads
      // every other delivered stone's lightness from the AI image (7.6).
      const ai = await rgbaOf(aiPng);
      const natural = cleanedLayout(placed.layout, { fillHolesIn: config.fillHoles ? ai : null, serviceFillNeighbours: config.serviceFillNeighbours });
      const check = acceptLayout(natural);
      if (!check.ok) return rerunOrFail(code, n, settings, check, outputPx);
      const stoneLayout = settings.mode === "bw"
        ? mapBlackAndWhiteFromImage(natural.stoneLayout, ai, { ...placed.layout.report, originMm: natural.originMm }, config.bwThreshold, natural.voted)
        : natural.stoneLayout;

      stage("files");
      storeNew(dir, "stones.json", `${JSON.stringify(stoneLayout.toJSON())}\n`);
      storeNew(dir, "tinted.png", await renderFullOffThread(stoneLayout));
      const result = designResult(stoneLayout, { coverage: check.coverage, settings, outputPx });
      finish(code, n, "done", { counts: 1, result }, { stones: result.stones, capped: natural.capped, removed: natural.removed, filled: natural.filled, serviceVoted: natural.serviceVoted });
    } catch (error) {
      log.error(`Design ${id} failed: ${error.stack || error.message}`);
      fail(code, n, "error");
    }
  }

  // Create design. Throws DesignRefused(status, IS error code). Returns the new attempt row.
  async function createDesign(code, input) {
    let settings;
    try {
      settings = normalizeDesignSettings(input);
    } catch {
      throw new DesignRefused(400, "bad-request");
    }

    const row = q.getCode(code);
    if (!row) throw new DesignRefused(404, "not-found");
    const source = uploadDir(config.archiveDir, code, settings.uploadId);
    const sourcePng = path.join(source, settings.removeBackground ? "cutout.png" : "work.png");
    if (!existsSync(path.join(source, "work.png"))) throw new DesignRefused(404, "not-found");
    if (!existsSync(sourcePng)) throw new DesignRefused(409, "not-ready");

    const prepared = await preparePng(readFileSync(sourcePng), settings.adjustments);

    // From here on everything is synchronous, so two requests cannot both pass the checks.
    if (row.status !== "open" || q.countedAttempts(code) >= DESIGNS_PER_CODE) throw new DesignRefused(409, "limit");
    if (q.listAttempts(code).some((a) => ACTIVE.has(a.status))) throw new DesignRefused(409, "busy");
    if (queue.length() >= queueLimit) throw new DesignRefused(503, "busy");

    const attempt = q.createAttempt(code, settings);
    writeAttemptInputs(config.archiveDir, code, attempt.n, {
      originalFile: originalIn(source),
      preparedPng: prepared,
      settings
    });
    q.logEvent("design-queued", { code, detail: { n: attempt.n } });
    queue.add(idOf(code, attempt.n));
    return attempt;
  }

  // What the browser may see of attempt n (spec section 12): IS fields only. A re-run attempt is
  // followed to the attempt that replaced it.
  function view(code, n) {
    let attempt = q.getAttempt(code, n);
    while (attempt?.result?.rerunAs) attempt = q.getAttempt(code, attempt.result.rerunAs);
    if (!attempt) return null;
    const out = {
      code,
      attempt: attempt.n,
      status: attempt.status,
      designsLeft: Math.max(0, DESIGNS_PER_CODE - q.countedAttempts(code))
    };
    if (ACTIVE.has(attempt.status)) {
      out.stage = attempt.stage || STAGES[0];
      out.queue = { position: queue.position(idOf(code, attempt.n)), length: queue.length() };
    }
    if (attempt.status === "done") {
      const { stones, bySize, byColour, widthMm, heightMm, widthIn, heightIn, coverage, mode } = attempt.result;
      out.result = { stones, bySize, byColour, widthMm, heightMm, widthIn, heightIn, coverage, mode };
    }
    if (attempt.status === "failed" || attempt.status === "declined") out.error = attempt.error_code;
    return out;
  }

  // At start-up: a design that was running when the server stopped failed (it does not count);
  // queued designs are queued again in order.
  function recover() {
    const rows = q.listActiveAttempts();
    for (const a of rows.filter((r) => r.status === "running")) fail(a.code, a.n, "interrupted");
    for (const a of rows.filter((r) => r.status === "queued")) queue.add(idOf(a.code, a.n), { force: true });
  }

  return {
    createDesign,
    view,
    recover,
    idle: () => queue.idle(),
    stop: () => stopping.abort(),
    queueLength: () => queue.length()
  };
}
