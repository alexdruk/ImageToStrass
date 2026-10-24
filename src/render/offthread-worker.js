import { parentPort } from "node:worker_threads";
import { buildDeliveryZip } from "../export/zip.js";
import { StoneLayout } from "../stones/StoneLayout.js";
import { renderFull, renderPreview } from "./tinted.js";

// The render worker of offthread.js: one job per message { id, kind, args }, answered with
// { id, ok, value } or { id, ok: false, error } (the message only; the caller logs it on the server).

const JOBS = {
  full: ({ layout, bwGap }) => renderFull(StoneLayout.fromJSON(layout), { bwGap }).png,
  preview: ({ layout, code, bwGap }) => renderPreview(StoneLayout.fromJSON(layout), code, { bwGap }).png,
  zip: (options) => buildDeliveryZip(options)
};

let queue = Promise.resolve();

parentPort.on("message", ({ id, kind, args }) => {
  queue = queue.then(async () => {
    try {
      const value = await JOBS[kind](args);
      parentPort.postMessage({ id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: error?.message || String(error) });
    }
  });
});
