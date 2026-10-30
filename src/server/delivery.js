import { existsSync } from "node:fs";
import { deliveryZipPath } from "../export/zip.js";
import { writeCodeJson } from "../prep/archive.js";
import { buildDeliveryZipOffThread } from "../render/offthread.js";

// A code's payment state and its delivery ZIP (spec sections 4.1, 9 and 11.3). The Etsy poller,
// the admin page and the download page all change codes through here, so every change is written
// to code.json and the event log the same way.

export const DELIVERY_DAYS = 30;
export const PAID_AFTER_DELETE = "paid-after-delete";
export const PREPAID_PICKED = "prepaid-picked";
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
    // Paid after the nightly job deleted its files (D7): paid all the same (the order is matched),
    // but undeliverable_at is set, no ZIP is built and the event "paid-after-delete" asks Alex
    // (control panel) to refund the order on Etsy.
    markPaid(code, { paidAt, receiptId = null, transactionId = null, how }) {
      const row = q.getCode(code);
      if (!row || row.status !== "open") return null;
      const deleted = Boolean(row.files_deleted_at);
      q.updateCode(code, {
        status: "paid",
        paid_at: paidAt,
        delivery_expires_at: deliveryExpiry(paidAt),
        receipt_id: receiptId,
        transaction_id: transactionId,
        ...(deleted && { undeliverable_at: new Date().toISOString() })
      });
      const updated = changed(code, "paid", { how, receiptId, transactionId });
      if (deleted) {
        q.logEvent(PAID_AFTER_DELETE, { code, detail: { how, receiptId, transactionId } });
        log.error(`Paid after its design was deleted: refund receipt ${receiptId} on Etsy (control panel).`);
        return { row: updated, build: Promise.resolve(null) };
      }
      return { row: updated, build: buildZipNow(updated) };
    },

    // A new paid order for a code that is no longer open and whose files are deleted (an expired
    // code bought again): the code is not changed, but the order cannot be delivered either.
    // Returns true when it was recorded now (once per transaction).
    markPaidAfterDelete(code, { receiptId = null, transactionId = null, how }) {
      const row = q.getCode(code);
      if (!row || row.status === "open" || !row.files_deleted_at || row.transaction_id === transactionId) return false;
      const seen = q.listEvents(code).some((e) => e.kind === PAID_AFTER_DELETE && JSON.parse(e.detail || "{}").transactionId === transactionId);
      if (seen) return false;
      q.updateCode(code, { undeliverable_at: row.undeliverable_at || new Date().toISOString() });
      q.logEvent(PAID_AFTER_DELETE, { code, detail: { how, receiptId, transactionId } });
      log.error(`Paid after its design was deleted: refund receipt ${receiptId} on Etsy (control panel).`);
      return true;
    },

    // A refund or cancellation locks the download (a prepaid code's designs too, PN-08). Returns the
    // row when it changed, else null.
    markRefunded(code, { receiptId = null, transactionId = null, how }) {
      const row = q.getCode(code);
      if (!row || !["open", "prepaid", "paid"].includes(row.status)) return null;
      q.updateCode(code, { status: "refunded" });
      return changed(code, "refunded", { how, receiptId, transactionId });
    },

    // A prepaid code (PN-08) gets its delivered design: the buyer's pick ("Use this design and
    // download", how "buyer"), or after 30 days without one its latest design (D6, how "auto",
    // nightly). It becomes paid; paid_at stays the Etsy payment time and the 30-day download starts
    // now. Returns { row, build } when it changed, else null (not prepaid, or no such done design).
    pickPrepaid(code, n, { how, now = new Date() }) {
      const row = q.getCode(code);
      const attempt = row && n ? q.getAttempt(code, n) : null;
      if (!row || row.status !== "prepaid" || attempt?.status !== "done") return null;
      q.updateCode(code, { status: "paid", selected_attempt: n, delivery_expires_at: deliveryExpiry(now.toISOString()) });
      const updated = changed(code, PREPAID_PICKED, { n, how, receiptId: row.receipt_id, transactionId: row.transaction_id });
      return { row: updated, build: buildZipNow(updated) };
    },

    // Nightly job: a paid code whose delivery_expires_at has passed becomes expired. Returns the row
    // when it changed, else null.
    markExpired(code, { now = new Date() } = {}) {
      const row = q.getCode(code);
      if (!row || row.status !== "paid" || !row.delivery_expires_at ||
        Date.parse(row.delivery_expires_at) > now.getTime()) return null;
      q.updateCode(code, { status: "expired" });
      return changed(code, "expired", { how: "nightly" });
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
