import { existsSync } from "node:fs";
import { deliveryZipPath } from "../export/zip.js";
import { writeCodeJson } from "../prep/archive.js";
import { buildDeliveryZipOffThread } from "../render/offthread.js";

// A code's payment state and its delivery ZIP (spec sections 4.1, 9 and 11.3). The Etsy poller,
// the admin page and the download page all change codes through here, so every change is written
// to code.json and the event log the same way.

export const DELIVERY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const deliveryExpiry = (paidAt) => new Date(Date.parse(paidAt) + DELIVERY_DAYS * DAY_MS).toISOString();

export function createDelivery({ q, config, log = console, buildZipFile = buildDeliveryZipOffThread }) {
  const zipBuilds = new Map();

  // The delivered attempt (D6): the buyer's pick, else the latest done design.
  function deliveredAttempt(row) {
    if (row.selected_attempt) return row.selected_attempt;
    const done = q.listAttempts(row.code).filter((a) => a.status === "done");
    return done.length ? done[done.length - 1].n : null;
  }

  // Builds data/delivery/<code>/<code>.zip in the render worker; one build per code at a time.
  function buildZip(row) {
    const { code } = row;
    if (!zipBuilds.has(code)) {
      const n = deliveredAttempt(row);
      const build = n
        ? buildZipFile({ archiveDir: config.archiveDir, deliveryDir: config.deliveryDir, code, n })
        : Promise.reject(new Error("no design to deliver"));
      zipBuilds.set(code, build.finally(() => zipBuilds.delete(code)));
    }
    return zipBuilds.get(code);
  }

  // The ZIP is built when the code becomes paid (spec section 9); a failed build is made again at
  // the first download. Resolves when done, never rejects.
  function buildZipNow(row) {
    if (!deliveredAttempt(row)) return Promise.resolve(null);
    return buildZip(row).catch((error) => {
      log.error(`ZIP build for ${row.code} failed: ${error.message}`);
      return null;
    });
  }

  function changed(code, kind, detail) {
    const row = q.getCode(code);
    writeCodeJson(config.archiveDir, row);
    q.logEvent(kind, { code, detail });
    return row;
  }

  return {
    deliveredAttempt,
    buildZip,
    zipPath: (code) => deliveryZipPath(config.deliveryDir, code),
    zipExists: (code) => existsSync(deliveryZipPath(config.deliveryDir, code)),

    // An open code becomes paid: paid_at, delivery_expires_at = paid_at + 30 days, ZIP built.
    // Returns { row, build } when it changed, else null (already paid, refunded or expired).
    markPaid(code, { paidAt, receiptId = null, transactionId = null, how }) {
      const row = q.getCode(code);
      if (!row || row.status !== "open") return null;
      q.updateCode(code, {
        status: "paid",
        paid_at: paidAt,
        delivery_expires_at: deliveryExpiry(paidAt),
        receipt_id: receiptId,
        transaction_id: transactionId
      });
      const updated = changed(code, "paid", { how, receiptId, transactionId });
      return { row: updated, build: buildZipNow(updated) };
    },

    // A refund or cancellation locks the download. Returns the row when it changed, else null.
    markRefunded(code, { receiptId = null, transactionId = null, how }) {
      const row = q.getCode(code);
      if (!row || (row.status !== "open" && row.status !== "paid")) return null;
      q.updateCode(code, { status: "refunded" });
      return changed(code, "refunded", { how, receiptId, transactionId });
    },

    // Admin "unlock": the code is paid (whatever its state) and downloadable for 30 days from now.
    unlock(code, { now = new Date() } = {}) {
      const row = q.getCode(code);
      if (!row) return null;
      const at = now.toISOString();
      q.updateCode(code, { status: "paid", paid_at: row.paid_at || at, delivery_expires_at: deliveryExpiry(at) });
      const updated = changed(code, "unlocked", { how: "admin", was: row.status });
      return { row: updated, build: buildZipNow(updated) };
    }
  };
}
