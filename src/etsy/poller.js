import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeCode } from "../db/codes.js";
import { etsyApiRequest } from "./etsy-api.js";
import { ordersFromReceipts } from "./matcher.js";

// The Etsy poller (spec section 11.3). Every ETSY_POLL_SECONDS it reads the shop's paid receipts
// modified since its last good run (minus 10 minutes), stores each IS transaction in etsy_orders
// (one row per transaction and code, upserted) and changes the codes: paid (ZIP built) or, on a
// refund or cancellation, refunded. Its state (times and counts only, no buyer data) is kept in
// config.etsy.stateFile so a restart, or a Mac that was off, catches up from the last good run.

export const OVERLAP_MS = 10 * 60 * 1000;
// With no good run yet, look back as far as a delivery lasts.
export const FIRST_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const PAGE_LIMIT = 100;
// The download page may ask for a poll; at most one such poll a minute (all buyers together).
export const REQUEST_INTERVAL_MS = 60 * 1000;
const MAX_PAGES = 50;

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

// Etsy errors can be long HTML pages; the admin page shows a short, single-line form.
const shortError = (error) => String(error?.message || error).replace(/\s+/g, " ").slice(0, 200);

// request(path) -> parsed JSON (etsyApiRequest: OAuth token, refresh, x-api-key); getShop() -> the
// saved shop (shop-store.js). Tests pass mocks.
export function createPoller({
  q, delivery, config, getShop, request = etsyApiRequest, now = () => Date.now(),
  pageLimit = PAGE_LIMIT, log = console
}) {
  const stateFile = config.etsy.stateFile;
  let state = readState(stateFile);
  let running = null;
  let timer = null;
  let lastRequest = 0;

  async function fetchReceipts(shopId, sinceSeconds) {
    const receipts = [];
    for (let offset = 0, page = 0; page < MAX_PAGES; page += 1, offset += pageLimit) {
      const params = new URLSearchParams({
        was_paid: "true",
        min_last_modified: String(sinceSeconds),
        sort_on: "updated",
        sort_order: "asc",
        limit: String(pageLimit),
        offset: String(offset)
      });
      const data = await request(`/application/shops/${shopId}/receipts?${params}`);
      const results = Array.isArray(data?.results) ? data.results : [];
      receipts.push(...results);
      if (results.length < pageLimit || offset + results.length >= Number(data?.count ?? 0)) break;
    }
    return receipts;
  }

  // Applies one order (matcher.js) to the database. Returns what it did, for the run's counts.
  function applyOrder(order, seenAt) {
    const known = order.codes.filter((code) => q.getCode(code));
    // A code matched earlier (on the admin page) stays matched although the text does not name it.
    const earlier = q.listTransactionOrders(order.transaction_id).map((r) => r.matched_code).filter(Boolean);
    const codes = [...new Set([...known, ...earlier])];
    const row = {
      receipt_id: order.receipt_id,
      transaction_id: order.transaction_id,
      listing_id: order.listing_id,
      personalization: order.personalization,
      paid_at: order.paid_at ?? new Date(now()).toISOString(),
      status: order.status,
      seen_at: seenAt
    };
    const done = { rows: 0, unmatched: 0, paid: 0, refunded: 0, builds: [] };

    if (codes.length === 0) {
      q.upsertEtsyOrder({ ...row, matched_code: null });
      done.rows = 1;
      done.unmatched = 1;
      return done;
    }

    q.deleteUnmatchedOrder(order.transaction_id);
    for (const code of codes) {
      const before = q.getEtsyOrder(order.transaction_id, code);
      q.upsertEtsyOrder({ ...row, matched_code: code });
      done.rows += 1;
      const ids = { receiptId: order.receipt_id, transactionId: order.transaction_id, how: "etsy" };
      if (order.status === "refunded") {
        // Only when the order turns refunded, so an admin unlock after a refund is not undone.
        if (before?.status !== "refunded" && delivery.markRefunded(code, ids)) done.refunded += 1;
      } else {
        const paid = delivery.markPaid(code, { ...ids, paidAt: row.paid_at });
        if (paid) {
          done.paid += 1;
          done.builds.push(paid.build);
        } else if (!before) {
          // A new order for a code that was already paid and whose files are gone (D7).
          delivery.markPaidAfterDelete(code, ids);
        }
      }
    }
    return done;
  }

  async function poll() {
    const startedAt = now();
    const run = { at: new Date(startedAt).toISOString() };
    try {
      const shop = await getShop();
      if (!shop?.shop_id) throw new Error("Etsy shop is not connected.");
      const since = Number.isFinite(state.lastOkStartedAt)
        ? state.lastOkStartedAt - OVERLAP_MS
        : startedAt - FIRST_LOOKBACK_MS;
      const receipts = await fetchReceipts(shop.shop_id, Math.floor(since / 1000));
      const orders = ordersFromReceipts(receipts, config.etsy.listingIds);
      const counts = { receipts: receipts.length, transactions: orders.length, rows: 0, unmatched: 0, paid: 0, refunded: 0 };
      const builds = [];
      for (const order of orders) {
        const done = applyOrder(order, run.at);
        for (const key of ["rows", "unmatched", "paid", "refunded"]) counts[key] += done[key];
        builds.push(...done.builds);
      }
      state = { ...state, lastRun: { ...run, ok: true, ...counts }, lastOkAt: run.at, lastOkStartedAt: startedAt, lastError: null };
      writeState(stateFile, state);
      if (counts.paid || counts.refunded || counts.unmatched) {
        log.log(`Etsy poll: ${counts.paid} paid, ${counts.refunded} refunded, ${counts.unmatched} without a code.`);
      }
      return { ok: true, ...counts, builds: Promise.all(builds) };
    } catch (error) {
      const message = shortError(error);
      // Logged once per new error (not connected yet would otherwise log every few minutes).
      if (state.lastError?.message !== message || state.lastRun?.ok) log.error(`Etsy poll failed: ${message}`);
      state = { ...state, lastRun: { ...run, ok: false }, lastError: { at: run.at, message } };
      writeState(stateFile, state);
      return { ok: false, error: message, builds: Promise.resolve([]) };
    }
  }

  // One poll at a time; a call while one runs gets that run.
  function runOnce() {
    running ??= poll().finally(() => { running = null; });
    return running;
  }

  return {
    runOnce,

    start() {
      if (timer) return;
      runOnce();
      timer = setInterval(runOnce, config.etsy.pollMs);
      timer.unref();
    },

    stop() {
      clearInterval(timer);
      timer = null;
      return running ?? Promise.resolve();
    },

    // From the download page: a poll now, unless one was asked for in the last minute.
    requestPoll() {
      if (now() - lastRequest < REQUEST_INTERVAL_MS) return false;
      lastRequest = now();
      runOnce();
      return true;
    },

    // Admin "match to code": an unmatched order row gets the code, and the code its payment state.
    // Returns { ok: true } or { ok: false, error } (unknown-order, matched, unknown-code).
    matchOrder(id, input) {
      const order = q.getEtsyOrderById(id);
      if (!order) return { ok: false, error: "unknown-order" };
      if (order.matched_code) return { ok: false, error: "matched" };
      const code = normalizeCode(input);
      if (!code || !q.getCode(code)) return { ok: false, error: "unknown-code" };

      if (q.getEtsyOrder(order.transaction_id, code)) q.deleteUnmatchedOrder(order.transaction_id);
      else q.setOrderCode(id, code);
      q.logEvent("order-matched", { code, detail: { how: "admin", receiptId: order.receipt_id, transactionId: order.transaction_id } });
      const ids = { receiptId: order.receipt_id, transactionId: order.transaction_id, how: "admin-match" };
      const paid = order.status === "refunded"
        ? (delivery.markRefunded(code, ids), null)
        : delivery.markPaid(code, { ...ids, paidAt: order.paid_at ?? new Date(now()).toISOString() });
      return { ok: true, code, build: paid?.build ?? Promise.resolve(null) };
    },

    status: () => ({
      running: Boolean(running),
      everyMs: config.etsy.pollMs,
      listingIds: config.etsy.listingIds,
      lastRun: state.lastRun ?? null,
      lastOkAt: state.lastOkAt ?? null,
      lastError: state.lastError ?? null
    })
  };
}
