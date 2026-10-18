import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { attemptDir, storeNew, uploadDir, writeAttemptInputs, writeCodeJson } from "../prep/archive.js";
import { normalizeSettings } from "../prep/adjust.js";
import { preparePng } from "../prep/prepare.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { findStoneSizeByDiameterMm } from "../stones/StoneSizes.js";
import { mapBlackAndWhite } from "./bw.js";
import { FAKE_REDRAW_DATA_URL } from "./fake/FakeRedrawProvider.js";
import { callLayoutService } from "./layout.js";
import { DEFAULT_TIMERS, createProvider } from "./provider.js";
import { QUEUE_LIMIT, createQueue } from "./queue.js";
import { applyTier } from "./tiers.js";

// The design pipeline (spec section 7): Create design -> attempt row and archive inputs -> queue ->
// model input -> provider -> layout -> acceptance (one automatic re-run) -> tiers -> B&W -> result.
//
// Attempts accounting (D5, section 4.1): an attempt counts (counts = 1) only when it is done. A
// failed, declined or re-run attempt has counts = 0. A code makes a new design only while it is
// open, has fewer than 3 counted designs and has no design queued or running, so it can never
// pass 3. Every attempt, re-runs included, gets its own n and attempt-<n>/ folder.

export const DESIGNS_PER_CODE = 3;
export const STAGES = Object.freeze(["preparing", "designing", "placing", "files"]);
export const MODEL_INPUT_SIDE = 1024;
export const SIZE_RANGE = Object.freeze({ mm: [140, 600], in: [5.5, 23.6] });
export const MM_PER_INCH = 25.4;

// Acceptance (spec section 7.4).
export const MIN_STONES = 300;
export const MIN_COVERAGE = 0.5;

// Layout service refusals caused by the drawn image itself; like a failed acceptance check they
// lead to the automatic re-run.
const IMAGE_REFUSALS = ["no-stones", "no-alpha"];

const ACTIVE = new Set(["queued", "running"]);
const FAKE_PNG = Buffer.from(FAKE_REDRAW_DATA_URL.split(",")[1], "base64");
const FAKE_LAYOUT = JSON.parse(readFileSync(new URL("./fake/layout.json", import.meta.url), "utf8"));

export class DesignRefused extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// The buyer's choices (spec sections 6.3, 6.4) -> the settings stored with the attempt.
export function normalizeDesignSettings(input) {
  if (!input || typeof input !== "object") throw new RangeError("settings must be an object.");
  const upload = input.upload;
  if (!Number.isInteger(upload) || upload < 1) throw new RangeError("upload must be a positive integer.");
  const unit = input.unit ?? "mm";
  if (!(unit in SIZE_RANGE)) throw new RangeError("unit must be mm or in.");
  const size = input.size;
  const [min, max] = SIZE_RANGE[unit];
  if (typeof size !== "number" || !Number.isFinite(size) || size < min || size > max) {
    throw new RangeError(`size must be from ${min} to ${max} ${unit}.`);
  }
  const mode = input.mode ?? "colour";
  if (mode !== "colour" && mode !== "bw") throw new RangeError("mode must be colour or bw.");
  const removeBackground = input.removeBackground ?? true;
  if (typeof removeBackground !== "boolean") throw new RangeError("removeBackground must be true or false.");

  return {
    uploadId: upload,
    removeBackground,
    adjustments: normalizeSettings(input.adjustments ?? {}),
    size,
    unit,
    sizeMm: unit === "in" ? Math.round(size * MM_PER_INCH * 100) / 100 : size,
    mode
  };
}

// prepared.png padded to a square on a transparent canvas and resized to 1024 x 1024 (7.1).
export function modelInput(preparedPng) {
  return sharp(preparedPng)
    .resize(MODEL_INPUT_SIDE, MODEL_INPUT_SIDE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// (violations == 0, coverage >= 0.5, at least 300 stones) -> { ok, stones, violations, coverage }.
export function acceptLayout(layout) {
  const report = layout.report || {};
  const stones = layout.stones.length;
  const violations = Number(report.violations);
  const coverage = Number(report.coverage);
  return {
    ok: violations === 0 && coverage >= MIN_COVERAGE && stones >= MIN_STONES,
    stones,
    violations,
    coverage
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

// result_json (spec section 7.7).
export function designResult(stoneLayout, { tier, coverage, settings }) {
  const round = (v, p = 1) => Math.round(v * 10 ** p) / 10 ** p;
  return {
    stones: stoneLayout.count,
    bySize: countBy(stoneLayout.stones, (s) => findStoneSizeByDiameterMm(s.sizeMm)?.id ?? `${s.sizeMm}mm`),
    byColour: countBy(stoneLayout.stones, (s) => s.color),
    tier: tier.k,
    stretch: round(tier.r, 4),
    widthMm: round(stoneLayout.widthMm),
    heightMm: round(stoneLayout.heightMm),
    // The buyer's longest side; the real one is larger when the design is larger than asked (7.5).
    requestedMm: settings.sizeMm,
    coverage,
    mode: settings.mode
  };
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
  function rerunOrFail(code, n, settings, check) {
    if (settings.rerunOf) {
      fail(code, n, "rejected", { result: { rejected: check } });
      return;
    }
    const dir = attemptDir(config.archiveDir, code, n);
    const again = q.createAttempt(code, { ...settings, rerunOf: n });
    writeAttemptInputs(config.archiveDir, code, again.n, {
      originalFile: originalIn(dir),
      preparedPng: readFileSync(path.join(dir, "prepared.png")),
      settings: again.settings
    });
    fail(code, n, "rejected", { result: { rejected: check, rerunAs: again.n } });
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
      const input = await modelInput(readFileSync(path.join(dir, "prepared.png")));

      stage("designing");
      const drawn = await redraw(input, { size: settings.size, unit: settings.unit, mode: settings.mode }, stopping.signal);
      if (!drawn) return fail(code, n, "cancelled");
      if (drawn.error === "declined") return finish(code, n, "declined", { error_code: "declined" }, { reason: drawn.detail });
      if (drawn.error) return fail(code, n, drawn.detail);
      storeNew(dir, "ai.png", drawn.png);

      stage("placing");
      const placed = await layoutOf(drawn.png, stopping.signal);
      if (placed.cancelled) return fail(code, n, "cancelled");
      if (placed.error) {
        const refusal = IMAGE_REFUSALS.find((c) => placed.error.message.startsWith(`${c}:`));
        log.error(`Layout for ${id} failed: ${placed.error.code} ${placed.error.message}`);
        if (refusal) return rerunOrFail(code, n, settings, { refusal });
        return fail(code, n, placed.error.code);
      }
      storeNew(dir, "layout.json", `${JSON.stringify(placed.layout)}\n`);
      const check = acceptLayout(placed.layout);
      if (!check.ok) return rerunOrFail(code, n, settings, check);

      const tiered = applyTier(placed.layout, settings.sizeMm);
      if (!tiered.gaps.ok) {
        log.error(`Tier gap check failed for ${id}: ${JSON.stringify(tiered.gaps)}`);
        return fail(code, n, "tier-gaps", { result: { gaps: tiered.gaps } });
      }
      const stoneLayout = settings.mode === "bw"
        ? mapBlackAndWhite(tiered.stoneLayout, config.bwThreshold)
        : tiered.stoneLayout;

      stage("files");
      storeNew(dir, "stones.json", `${JSON.stringify(stoneLayout.toJSON())}\n`);
      const result = designResult(stoneLayout, { tier: tiered.tier, coverage: check.coverage, settings });
      finish(code, n, "done", { counts: 1, result }, { stones: result.stones, tier: result.tier });
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
      const { stones, bySize, byColour, tier, widthMm, heightMm, requestedMm, coverage, mode } = attempt.result;
      out.result = { stones, bySize, byColour, tier, widthMm, heightMm, requestedMm, coverage, mode };
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
