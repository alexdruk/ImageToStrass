import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Background removal (spec section 6.2). Runs right after an upload, one at a time, on the
// strass service (POST /remove-background). The result is uploads/<k>/cutout.png; its
// presence means "ready". A failure is kept in memory only, so after a restart the removal is
// simply tried again when the browser asks. IS_FAKE=1 makes no strass call: the cutout is a
// copy of work.png.

const TIMEOUT_MS = 300_000; // may wait behind a layout holding the service lock
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function callRemoveBackground(png, { serviceUrl, fetch, timeoutMs = TIMEOUT_MS }) {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "work.png");

  const response = await fetch(`${serviceUrl}/remove-background`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`remove-background answered ${response.status}`);
  }

  const out = Buffer.from(await response.arrayBuffer());

  if (!out.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("remove-background did not answer a PNG");
  }

  return out;
}

// Writes cutout.png without ever replacing an existing one.
function storeCutout(dir, png) {
  const target = path.join(dir, "cutout.png");
  const tmp = path.join(dir, `.cutout.${process.pid}.tmp`);

  writeFileSync(tmp, png);

  try {
    linkSync(tmp, target);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  } finally {
    unlinkSync(tmp);
  }
}

export function createBackgroundRemover({ config, fetch = globalThis.fetch, log = console }) {
  const failed = new Set();
  const pending = new Set();
  let queue = Promise.resolve();

  async function run(dir) {
    try {
      const work = readFileSync(path.join(dir, "work.png"));
      const png = config.fake
        ? work
        : await callRemoveBackground(work, { serviceUrl: config.strassServiceUrl, fetch });

      storeCutout(dir, png);
    } catch (error) {
      failed.add(dir);
      log.error(`Background removal failed for ${dir}: ${error.message}`);
    } finally {
      pending.delete(dir);
    }
  }

  // "ready" | "pending" | "failed" | "none" (never started in this process).
  function state(dir) {
    if (existsSync(path.join(dir, "cutout.png"))) return "ready";
    if (pending.has(dir)) return "pending";
    if (failed.has(dir)) return "failed";
    return "none";
  }

  function start(dir) {
    if (state(dir) === "ready" || pending.has(dir)) {
      return;
    }

    failed.delete(dir);
    pending.add(dir);
    queue = queue.then(() => run(dir));
  }

  return { start, state, idle: () => queue };
}
