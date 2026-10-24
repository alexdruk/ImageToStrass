import { Worker } from "node:worker_threads";
import { StoneLayout } from "../stones/StoneLayout.js";

// The tinted renders (spec section 8) and the delivery ZIP build (section 9) take seconds of CPU.
// They run in one worker thread (offthread-worker.js), so the server keeps answering polls and
// page requests meanwhile. Jobs are queued in the worker and run one at a time. The worker is
// started on the first job, kept while it is busy, and does not keep the process alive when idle.
// A worker that dies fails its pending jobs; the next job starts a new one.

let worker = null;
let nextId = 1;
const pending = new Map();

function failAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL("./offthread-worker.js", import.meta.url));
  w.on("message", ({ id, ok, value, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (!pending.size) w.unref();
    if (ok) job.resolve(value);
    else job.reject(new Error(error));
  });
  w.on("error", (error) => {
    if (worker === w) worker = null;
    failAll(error);
  });
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    failAll(new Error(`render worker stopped (exit code ${code})`));
  });
  w.unref();
  worker = w;
  return w;
}

function run(kind, args) {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.ref();
    w.postMessage({ id, kind, args });
  });
}

const toBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const layoutJson = (stoneLayout) => (stoneLayout instanceof StoneLayout ? stoneLayout.toJSON() : stoneLayout);

// The full render (2400 px, transparent) of a StoneLayout -> PNG Buffer. bwGap: the gap rule of a
// black & white design (tinted.js BW_GAPS), null for colour.
export async function renderFullOffThread(stoneLayout, { bwGap = null } = {}) {
  return toBuffer(await run("full", { layout: layoutJson(stoneLayout), bwGap }));
}

// The browser's preview (900 px, white, watermarked with the code) -> PNG Buffer.
export async function renderPreviewOffThread(stoneLayout, code, { bwGap = null } = {}) {
  return toBuffer(await run("preview", { layout: layoutJson(stoneLayout), code, bwGap }));
}

// buildDeliveryZip({ archiveDir, deliveryDir, code, n }) in the worker -> the ZIP's path.
export function buildDeliveryZipOffThread(options) {
  return run("zip", options);
}

// Tests: stop the worker (pending jobs fail).
export async function stopRenderWorker() {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}
