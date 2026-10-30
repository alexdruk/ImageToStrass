import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { normalizeCode } from "../db/codes.js";
import { DESIGNS_PER_CODE } from "../pipeline/design.js";
import { attemptDir, uploadDir, writeCodeJson } from "../prep/archive.js";
import { previewPng } from "../prep/prepare.js";
import { renderPreviewOffThread } from "../render/offthread.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { listAllStoneSizes } from "../stones/StoneSizes.js";
import { isLocalRequest } from "./admin-access.js";
import { DELIVERY_DAYS, deliveryExpiry } from "./delivery.js";

// The web app's own routes (spec section 10): the screens' URLs, the session of a code, the two
// views of a design (Original and the watermarked Tinted preview), "Use this design" and the
// download page. Answers carry IS fields only; refusals are { error: <IS code> } (spec 12).

export { DELIVERY_DAYS };
const PREVIEW_CACHE_SIZE = 24;

// Every screen URL of the app; each answers with the one page (public/index.html).
export const SCREEN_PATHS = /^\/(?:c\/[^/]+(?:\/prepare|\/working|\/done|\/result\/\d+)?|download|order|privacy|terms|contact|legal)?\/?$/;

const INDEX_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

// Names and swatches for the Result screen's stone counts.
const COLOURS = Object.fromEntries(Object.values(STONE_COLORS).map((c) => [c.id, { name: c.name, fill: c.fill }]));
const SIZES = Object.fromEntries(listAllStoneSizes().map((s) => [s.id, s.name]));

const nOf = (text) => (/^[1-9]\d{0,5}$/.test(text) ? Number(text) : null);

// The buyer agrees, once per code, that the download starts now and that any right to withdraw is
// lost (PN-07, EU and UK digital content); the first agreement is this event, its time the event's.
export const WITHDRAWAL_CONSENT = "withdrawal-consent";

// The download state of a code row (spec 10, screen 6).
export function downloadState(row, now = Date.now()) {
  if (!row) return { state: "unknown" };
  if (row.status === "refunded") return { state: "refunded" };
  // Made from an Etsy order, no design picked yet (PN-08): the buyer picks one first.
  if (row.status === "prepaid") return { state: "pick" };
  // Paid after its design was deleted (D7): nothing to deliver; the order is refunded on Etsy.
  if (row.undeliverable_at) return { state: "deleted" };
  const expiresAt = row.delivery_expires_at;
  if (row.status === "expired" || (row.status === "paid" && expiresAt && Date.parse(expiresAt) <= now)) {
    return { state: "expired" };
  }
  if (row.status === "paid") return { state: "ready", expiresAt };
  return { state: "unpaid" };
}

// delivery: createDelivery (delivery.js). poller: the Etsy poller, asked for a poll when the download
// page sees an unpaid code (it polls at most once a minute however often it is asked).
export function webappRoutes({ q, config, background, delivery, poller = null, log = console }) {
  const router = express.Router();
  const previews = new Map();

  const codeRow = (req) => {
    const code = normalizeCode(req.params.code);
    return code ? q.getCode(code) : null;
  };

  // Attempt n of a code, following an automatic re-run to the attempt that replaced it.
  function attemptOf(code, n) {
    let attempt = n ? q.getAttempt(code, n) : null;
    while (attempt?.result?.rerunAs) attempt = q.getAttempt(code, attempt.result.rerunAs);
    return attempt;
  }

  function latestUpload(code) {
    const parent = path.join(config.archiveDir, code, "uploads");
    if (!existsSync(parent)) return null;
    const ks = readdirSync(parent).map(Number).filter((k) => Number.isInteger(k) && k > 0)
      .filter((k) => existsSync(path.join(uploadDir(config.archiveDir, code, k), "work.png")));
    return ks.length ? Math.max(...ks) : null;
  }

  // The settings the Prepare screen starts from: the latest design's, when it was made from the
  // latest upload ("Try again starts from the previous settings", spec 6.3).
  function lastSettings(attempts, upload) {
    const last = [...attempts].reverse().find((a) => a.settings);
    if (!last || last.settings.uploadId !== upload) return null;
    const { removeBackground, adjustments, mode, bwStyle } = last.settings;
    return { removeBackground, adjustments, mode, ...(bwStyle ? { bwStyle } : {}) };
  }

  router.get("/api/config", (_req, res) => {
    res.json({
      turnstileSiteKey: config.turnstileSiteKey || null,
      listingUrl: config.listingUrl || null,
      // The seller's details for the legal pages (PN-07); "" when not set in .env.
      legal: config.legal,
      designsPerCode: DESIGNS_PER_CODE,
      colours: COLOURS,
      sizes: SIZES
    });
  });

  // The session of a code (/c/<code> resumes it, spec section 5). Opening it is the code's last
  // visit (D7: an unpaid code's files are deleted 30 days after its last activity).
  router.get("/api/codes/:code", async (req, res) => {
    const row = codeRow(req);
    if (!row) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    if (row.files_deleted_at) {
      res.status(410).json({ error: "deleted" });
      return;
    }
    q.updateCode(row.code, { last_seen_at: new Date().toISOString() });

    const attempts = q.listAttempts(row.code);
    const k = latestUpload(row.code);
    let upload = null;
    if (k) {
      const dir = uploadDir(config.archiveDir, row.code, k);
      if (background.state(dir) === "none") background.start(dir);
      const { width, height } = await sharp(path.join(dir, "work.png")).metadata();
      upload = { upload: k, width, height, background: background.state(dir) };
    }
    const active = attempts.find((a) => a.status === "queued" || a.status === "running");

    res.set("Cache-Control", "no-store").json({
      code: row.code,
      status: row.status,
      // Made from an Etsy order on /order (PN-08): no "Your code" screen, the pick downloads.
      fromOrder: Boolean(row.redeemed_at),
      designsLeft: Math.max(0, DESIGNS_PER_CODE - q.countedAttempts(row.code)),
      selected: row.selected_attempt ?? null,
      designs: attempts.filter((a) => a.status === "done").map((a) => ({ attempt: a.n, mode: a.result?.mode })),
      active: active ? active.n : null,
      upload,
      settings: lastSettings(attempts, k)
    });
  });

  // Tinted view (spec section 8): the watermarked 900 px preview, white background, rendered in the
  // render worker. One render per design at a time; concurrent requests share it.
  router.get("/api/attempts/:code/:n/tinted.png", async (req, res) => {
    const row = codeRow(req);
    const attempt = row && attemptOf(row.code, nOf(req.params.n));
    if (!attempt || attempt.status !== "done") {
      res.status(404).json({ error: "not-found" });
      return;
    }

    const key = `${row.code}/${attempt.n}`;
    try {
      if (!previews.has(key)) {
        const file = path.join(attemptDir(config.archiveDir, row.code, attempt.n), "stones.json");
        const layout = JSON.parse(readFileSync(file, "utf8"));
        const render = renderPreviewOffThread(layout, row.code, { bwGap: attempt.result?.mode === "bw" ? config.bwGap : null });
        previews.set(key, render);
        render.catch(() => previews.delete(key));
        if (previews.size > PREVIEW_CACHE_SIZE) previews.delete(previews.keys().next().value);
      }
      const png = await previews.get(key);
      res.set("Cache-Control", "private, max-age=3600").type("png").send(png);
    } catch (error) {
      log.error(`Tinted preview of ${key} failed: ${error.message}`);
      res.status(500).json({ error: "failed" });
    }
  });

  // Original view (spec section 8): prepared.png, or ?source=upload for the decoded upload. 1024 px.
  router.get("/api/attempts/:code/:n/original.png", async (req, res) => {
    const row = codeRow(req);
    const attempt = row && attemptOf(row.code, nOf(req.params.n));
    const source = req.query.source ?? "prepared";
    if (!attempt || !attempt.settings || !["prepared", "upload"].includes(source)) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    const file = source === "prepared"
      ? path.join(attemptDir(config.archiveDir, row.code, attempt.n), "prepared.png")
      : path.join(uploadDir(config.archiveDir, row.code, attempt.settings.uploadId), "work.png");
    try {
      res.set("Cache-Control", "private, max-age=3600").type("png").send(await previewPng(file));
    } catch (error) {
      log.error(`Original view of ${row.code}/${attempt.n} failed: ${error.message}`);
      res.status(500).json({ error: "failed" });
    }
  });

  // "Use this design" (D6). For a prepaid code (PN-08) "Use this design and download": the code
  // becomes paid and its ZIP is built (delivery.pickPrepaid); the answer says paid.
  router.post("/api/codes/:code/select", (req, res) => {
    const row = codeRow(req);
    const n = Number.isInteger(req.body?.attempt) ? req.body.attempt : null;
    const attempt = row && n ? q.getAttempt(row.code, n) : null;
    if (!attempt || attempt.status !== "done") {
      res.status(404).json({ error: "not-found" });
      return;
    }
    if (row.status === "prepaid") {
      const picked = delivery.pickPrepaid(row.code, n, { how: "buyer" });
      if (!picked) {
        res.status(409).json({ error: "failed" });
        return;
      }
      res.json({ code: row.code, selected: n, paid: true });
      return;
    }
    if (row.status !== "open") {
      res.status(409).json({ error: "paid" });
      return;
    }

    q.updateCode(row.code, { selected_attempt: n });
    writeCodeJson(config.archiveDir, q.getCode(row.code));
    q.logEvent("design-selected", { code: row.code, detail: { n } });
    res.json({ code: row.code, selected: n });
  });

  const consented = (row) => Boolean(q.firstEvent(row.code, WITHDRAWAL_CONSENT));

  // A ready code says whether the buyer has agreed yet (the page then asks no more).
  router.get("/api/download/:code", (req, res) => {
    const row = codeRow(req);
    const state = downloadState(row);
    if (state.state === "unpaid") poller?.requestPoll();
    if (state.state === "ready") state.consented = consented(row);
    res.set("Cache-Control", "no-store").json(state);
  });

  // ?agree=1: the buyer ticked the box; the first time is recorded. Without it, and with no
  // agreement recorded, the ZIP is refused ("consent").
  router.get("/api/download/:code/zip", async (req, res) => {
    const row = codeRow(req);
    const { state } = downloadState(row);
    if (state !== "ready") {
      res.status(state === "unknown" ? 404 : 403).json({ error: state });
      return;
    }
    if (!consented(row)) {
      if (req.query.agree !== "1") {
        res.status(403).json({ error: "consent" });
        return;
      }
      q.logEvent(WITHDRAWAL_CONSENT, { code: row.code });
    }

    try {
      const file = delivery.zipPath(row.code);
      if (!existsSync(file)) await delivery.buildZip(row);
      q.updateCode(row.code, { downloads: (row.downloads || 0) + 1 });
      q.logEvent("download", { code: row.code });
      res.set("Cache-Control", "no-store").download(file, `${row.code}.zip`);
    } catch (error) {
      log.error(`Download of ${row.code} failed: ${error.stack || error.message}`);
      res.status(500).json({ error: "failed" });
    }
  });

  // Test only (IS_FAKE=1; real codes are marked paid by the Etsy poller or the admin page): sets a
  // code's payment state. Guarded twice: the route exists only when IS_FAKE=1, and even then it
  // answers only a request made on this Mac directly (isLocalRequest: nothing that came through the
  // tunnel, and no ADMIN_TOKEN way in).
  if (config.fake) {
    router.post("/api/test/payment/:code", async (req, res) => {
      if (!isLocalRequest(req)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const row = codeRow(req);
      const state = req.body?.state ?? "paid";
      if (!row || !["paid", "refunded", "expired", "open"].includes(state)) {
        res.status(404).json({ error: "not-found" });
        return;
      }

      const now = new Date().toISOString();
      const fields = state === "paid"
        ? { status: "paid", paid_at: now, delivery_expires_at: deliveryExpiry(now) }
        : { status: state };
      q.updateCode(row.code, fields);
      const updated = q.getCode(row.code);
      writeCodeJson(config.archiveDir, updated);
      q.logEvent("test-payment", { code: row.code, detail: { state } });
      // The ZIP is built when the code becomes paid (spec section 9).
      if (state === "paid" && delivery.deliveredAttempt(updated)) await delivery.buildZip(updated).catch((error) => log.error(error.message));
      res.json({ code: row.code, ...downloadState(updated) });
    });
  }

  router.get(SCREEN_PATHS, (_req, res) => {
    res.set("Content-Security-Policy", INDEX_CSP).set("Cache-Control", "no-cache")
      .sendFile("index.html", { root: "public" });
  });

  return router;
}
