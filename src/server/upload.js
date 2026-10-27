import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, rmSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import busboy from "busboy";
import express from "express";
import sharp from "sharp";
import { normalizeCode } from "../db/codes.js";
import { createUploadDir, storeNew, storeOriginal, uploadDir, writeCodeJson } from "../prep/archive.js";
import { BadFile, decodeToWork } from "../prep/decode.js";
import { FORMATS, SIGNATURE_BYTES, detectFormat } from "../prep/formats.js";
import { previewPng } from "../prep/prepare.js";
import { clientIp } from "./client.js";

// POST /api/upload and the upload's status and previews (spec sections 6.1 and 6.2).
// Answers carry IS fields only; refusals are { error: <IS code> } (spec section 12).

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DESIGNS_PER_CODE = 3;

// Multipart overhead allowed on top of the file when the request declares its length.
const ENVELOPE_BYTES = 64 * 1024;
// After a refusal, read at most this much more of the body (so the client sees the answer
// instead of a reset connection), then close the socket.
const DRAIN_BYTES = 8 * 1024 * 1024;
const DRAIN_MS = 2000;

const CONSENT_VALUES = new Set(["1", "true", "on", "yes"]);

function refuse(req, res, status, error) {
  if (res.headersSent) {
    return;
  }

  // No "Connection: close": with it Node closes the socket as soon as the answer is written,
  // while the client is still sending, and the client can get a reset before it reads the answer.
  res.status(status).json({ error });

  // Drain a little of what the client is still sending, then cut it off.
  let drained = 0;
  const stop = () => req.destroy();
  const timer = setTimeout(stop, DRAIN_MS);
  req.on("data", (chunk) => {
    drained += chunk.length;
    if (drained > DRAIN_BYTES) {
      clearTimeout(timer);
      stop();
    }
  });
  req.on("end", () => clearTimeout(timer));
  req.resume();
}

function readHead(file) {
  const fd = openSync(file, "r");

  try {
    const head = Buffer.alloc(SIGNATURE_BYTES);
    return head.subarray(0, readSync(fd, head, 0, SIGNATURE_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

// Streams the multipart body: the "image" file goes to a temp file under data/ and is cut off
// the moment it passes MAX_UPLOAD_BYTES. Resolves { fields, file, size } or { error, status }.
function receive(req, tmpDir) {
  return new Promise((resolve) => {
    let parser;

    try {
      parser = busboy({
        headers: req.headers,
        // busboy reports "limit" when the file reaches fileSize, so + 1 lets exactly 50 MB through.
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES + 1, fields: 10, fieldSize: 4096, parts: 12 }
      });
    } catch {
      resolve({ status: 400, error: "bad-file" });
      return;
    }

    const fields = {};
    let upload = null;
    let settled = false;

    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const fail = (status, error) => {
      req.unpipe(parser);
      upload?.out.destroy();
      finish({ status, error, file: upload?.file });
    };

    parser.on("field", (name, value) => {
      fields[name] = value;
    });

    parser.on("file", (name, stream) => {
      if (name !== "image" || upload) {
        stream.resume();
        return;
      }

      mkdirSync(tmpDir, { recursive: true });
      const file = path.join(tmpDir, `upload-${crypto.randomUUID()}`);
      const out = createWriteStream(file, { flags: "wx" });
      upload = { file, out, size: 0, written: new Promise((done) => out.on("close", done)) };

      stream.on("data", (chunk) => {
        upload.size += chunk.length;
      });
      stream.on("limit", () => fail(413, "too-large"));
      out.on("error", () => fail(500, "failed"));
      stream.pipe(out);
    });

    parser.on("error", () => fail(400, "bad-file"));

    parser.on("close", async () => {
      if (settled) {
        return;
      }

      if (!upload) {
        finish({ status: 400, error: "bad-file" });
        return;
      }

      await upload.written;
      finish({ fields, file: upload.file, size: upload.size });
    });

    req.pipe(parser);
  });
}

export function uploadRoutes({ q, config, background, verifyTurnstile, hashIp, limits, log = console }) {
  const router = express.Router();

  function codeOf(req) {
    return normalizeCode(req.params.code);
  }

  function uploadOf(req) {
    const code = codeOf(req);
    const k = /^[1-9]\d{0,5}$/.test(req.params.k) ? Number(req.params.k) : null;

    if (!code || !k || !q.getCode(code)) {
      return null;
    }

    const dir = uploadDir(config.archiveDir, code, k);
    return existsSync(path.join(dir, "work.png")) ? { code, k, dir } : null;
  }

  router.post("/api/upload", async (req, res) => {
    const declared = Number(req.headers["content-length"]);

    if (declared > MAX_UPLOAD_BYTES + ENVELOPE_BYTES) {
      refuse(req, res, 413, "too-large");
      return;
    }

    const received = await receive(req, config.tmpDir);

    try {
      if (received.error) {
        refuse(req, res, received.status, received.error);
        return;
      }

      const { fields, file, size } = received;

      if (!CONSENT_VALUES.has(String(fields.consent ?? "").toLowerCase())) {
        res.status(400).json({ error: "consent" });
        return;
      }

      const ip = clientIp(req);

      if (!(await verifyTurnstile(fields["cf-turnstile-response"], ip))) {
        res.status(403).json({ error: "verification" });
        return;
      }

      const format = size > 0 ? detectFormat(readHead(file)) : null;

      if (!format) {
        res.status(400).json({ error: "bad-file" });
        return;
      }

      // An existing code takes the upload only while it can still make designs.
      let row = fields.code ? q.getCode(normalizeCode(fields.code) ?? "") : null;

      if (row && (row.status !== "open" || q.countedAttempts(row.code) >= DESIGNS_PER_CODE)) {
        res.status(409).json({ error: "limit" });
        return;
      }

      const work = await decodeToWork(readFileSync(file), format);
      const now = new Date().toISOString();

      // New codes per IP (spec 13); checked and made with no await between, so it holds.
      const refusal = row ? null : limits.codeRefusal(hashIp(ip));
      if (refusal) {
        res.status(refusal.status).json({ error: refusal.error });
        return;
      }

      row ??= q.createCode({ ipHash: hashIp(ip), consentAt: now });

      // The archive is written before the buyer sees anything (spec section 4.2).
      const { k, dir } = createUploadDir(config.archiveDir, row.code);
      storeOriginal(dir, FORMATS[format].ext, file);
      storeNew(dir, "work.png", work.png);
      writeCodeJson(config.archiveDir, q.getCode(row.code));
      q.logEvent("upload", { code: row.code, detail: { k, format, bytes: size } });

      background.start(dir);

      res.status(201).json({
        code: row.code,
        upload: k,
        width: work.width,
        height: work.height,
        background: background.state(dir)
      });
    } catch (error) {
      if (error instanceof BadFile) {
        log.error(`Upload refused: ${error.message}`);
        res.status(400).json({ error: "bad-file" });
      } else {
        log.error(`Upload failed: ${error.stack || error.message}`);
        res.status(500).json({ error: "failed" });
      }
    } finally {
      if (received.file) {
        rmSync(received.file, { force: true });
      }
    }
  });

  router.get("/api/uploads/:code/:k", async (req, res) => {
    const upload = uploadOf(req);

    if (!upload) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    // A removal lost to a restart is started again.
    if (background.state(upload.dir) === "none") {
      background.start(upload.dir);
    }

    const { width, height } = await sharp(path.join(upload.dir, "work.png")).metadata();

    res.set("Cache-Control", "no-store").json({
      code: upload.code,
      upload: upload.k,
      width,
      height,
      background: background.state(upload.dir)
    });
  });

  // ?background=removed (the cutout) or kept (the decoded upload). 1024 px long side.
  router.get("/api/uploads/:code/:k/preview", async (req, res) => {
    const upload = uploadOf(req);
    const removed = req.query.background === "removed";

    if (!upload || !["removed", "kept"].includes(req.query.background)) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    if (removed && background.state(upload.dir) !== "ready") {
      res.status(409).json({ error: "not-ready" });
      return;
    }

    try {
      const png = await previewPng(path.join(upload.dir, removed ? "cutout.png" : "work.png"));
      res.set("Cache-Control", "no-store").type("png").send(png);
    } catch (error) {
      log.error(`Preview failed: ${error.message}`);
      res.status(500).json({ error: "failed" });
    }
  });

  return router;
}
