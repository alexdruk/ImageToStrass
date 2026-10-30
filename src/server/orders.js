import crypto from "node:crypto";
import express from "express";
import { writeCodeJson } from "../prep/archive.js";
import { clientIp } from "./client.js";
import { downloadState } from "./webapp.js";

// Buy first, design after (PN-08, spec sections 5 and 10): the buyer enters the Etsy order number
// (the receipt id) on /order. Each unit bought (the quantities of the receipt's transactions of the
// listings in IS_ETSY_LISTING_IDS) that has no code gets one new "prepaid" code, bound to its receipt
// and transaction; units whose personalization holds a known code keep it. The answer lists every
// code of the receipt, so redeeming again makes nothing new (and finds a lost code).
//
// POST /api/order { order, cf-turnstile-response }: Turnstile, then at most LOOKUPS_PER_IP_PER_HOUR
// per hashed IP (spec 13, "busy"). An order not stored yet asks the poller for a poll (the download
// page's limit: one a minute) and waits for it up to POLL_WAIT_MS; still missing, the answer is
// "waiting" with a ticket bound to that order number, and GET /api/order/<order>?ticket=<ticket>
// checks again (every 30 s from the page) without Turnstile or the limit: it can only ask for the
// same order. Answers carry IS fields only; refusals are { error: <IS code> } (spec 12).

export const LOOKUPS_PER_IP_PER_HOUR = 10;
export const HOUR_MS = 60 * 60 * 1000;
export const TICKET_MS = HOUR_MS;
export const POLL_WAIT_MS = 15000;
export const ORDER_REDEEMED = "order-redeemed";

// "1234 5678 90" -> 1234567890; null when it is not an order number (digits only, spaces allowed).
export function parseOrderNumber(input) {
  if (typeof input !== "string" && typeof input !== "number") return null;
  const digits = String(input).replace(/\s+/g, "");
  if (!/^[1-9]\d{3,15}$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

// What the order page shows of a code: prepaid (no pick yet), else its download state.
function codeView(q, row) {
  if (row.status === "prepaid") {
    return { code: row.code, state: "prepaid", designs: q.listAttempts(row.code).filter((a) => a.status === "done").length };
  }
  return { code: row.code, state: downloadState(row).state };
}

// The receipt's rows of the IS listings -> { state: "not-found" | "refunded" | "found", codes? }.
// Makes the prepaid codes the receipt is still owed, in one transaction.
export function redeemOrder({ q, config, receiptId, now = () => new Date() }) {
  const listings = new Set(config.etsy.listingIds.map(Number));
  const rows = q.listReceiptOrders(receiptId).filter((r) => listings.has(Number(r.listing_id)));
  if (rows.length === 0) return { state: "not-found" };
  if (rows.some((r) => r.status === "refunded")) return { state: "refunded" };

  const made = q.inTransaction(() => {
    const created = [];
    const byTransaction = new Map();
    for (const row of rows) {
      if (!byTransaction.has(row.transaction_id)) byTransaction.set(row.transaction_id, []);
      byTransaction.get(row.transaction_id).push(row);
    }
    for (const [transactionId, list] of byTransaction) {
      const units = Math.max(1, ...list.map((r) => r.quantity ?? 1));
      const matched = new Set(list.map((r) => r.matched_code).filter(Boolean));
      const first = list[0];
      for (let i = matched.size; i < units; i += 1) {
        const at = now().toISOString();
        const { code } = q.createCode();
        q.updateCode(code, {
          status: "prepaid", paid_at: first.paid_at || at, receipt_id: first.receipt_id,
          transaction_id: transactionId, redeemed_at: at
        });
        q.upsertEtsyOrder({
          receipt_id: first.receipt_id, transaction_id: transactionId, listing_id: first.listing_id,
          personalization: first.personalization, matched_code: code, paid_at: first.paid_at,
          status: first.status, quantity: first.quantity
        });
        q.logEvent(ORDER_REDEEMED, { code, detail: { receiptId: first.receipt_id, transactionId } });
        created.push(code);
      }
      if (matched.size < units) q.deleteUnmatchedOrder(transactionId);
    }
    return created;
  });
  for (const code of made) writeCodeJson(config.archiveDir, q.getCode(code));

  const codes = [...new Set(q.listReceiptOrders(receiptId)
    .filter((r) => listings.has(Number(r.listing_id)))
    .map((r) => r.matched_code).filter(Boolean))]
    .map((code) => q.getCode(code)).filter(Boolean);
  return { state: "found", codes: codes.map((row) => codeView(q, row)), created: made.length };
}

// poller: the Etsy poller (requestPoll, runOnce); null in tests without one.
export function orderRoutes({ q, config, verifyTurnstile, hashIp, poller = null, now = () => Date.now(), pollWaitMs = POLL_WAIT_MS }) {
  const router = express.Router();
  const lookups = new Map();
  const tickets = new Map();

  // A lookup by ipHash now, unless it made LOOKUPS_PER_IP_PER_HOUR in the last hour.
  function takeLookup(ipHash) {
    const t = now();
    for (const [key, times] of lookups) {
      const recent = times.filter((at) => t - at < HOUR_MS);
      if (recent.length) lookups.set(key, recent); else lookups.delete(key);
    }
    const times = lookups.get(ipHash) || [];
    if (times.length >= LOOKUPS_PER_IP_PER_HOUR) return false;
    lookups.set(ipHash, [...times, t]);
    return true;
  }

  function newTicket(receiptId) {
    for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key);
    const id = crypto.randomBytes(18).toString("base64url");
    tickets.set(id, { receiptId, expires: now() + TICKET_MS });
    return id;
  }

  // The order now; when it is not stored yet, after a poll (if one may run now), else "waiting".
  async function lookUp(receiptId, ticket = null) {
    let result = redeemOrder({ q, config, receiptId });
    if (result.state === "not-found" && poller?.requestPoll()) {
      let timer;
      await Promise.race([
        poller.runOnce().catch(() => null),
        new Promise((resolve) => { timer = setTimeout(resolve, pollWaitMs); })
      ]);
      clearTimeout(timer);
      result = redeemOrder({ q, config, receiptId });
    }
    if (result.state === "not-found") return { state: "waiting", ticket: ticket || newTicket(receiptId) };
    if (ticket) tickets.delete(ticket);
    const { created, ...answer } = result;
    return answer;
  }

  router.post("/api/order", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ip = clientIp(req);
    if (!(await verifyTurnstile(body["cf-turnstile-response"], ip))) {
      res.status(403).json({ error: "verification" });
      return;
    }
    const receiptId = parseOrderNumber(body.order);
    if (!receiptId) {
      res.status(400).json({ error: "bad-order" });
      return;
    }
    if (!takeLookup(hashIp(ip))) {
      res.status(429).json({ error: "busy" });
      return;
    }
    res.set("Cache-Control", "no-store").json(await lookUp(receiptId));
  });

  router.get("/api/order/:order", async (req, res) => {
    const receiptId = parseOrderNumber(req.params.order);
    const id = typeof req.query.ticket === "string" ? req.query.ticket : "";
    const ticket = tickets.get(id);
    if (!receiptId || !ticket || ticket.receiptId !== receiptId || ticket.expires <= now()) {
      if (ticket && ticket.expires <= now()) tickets.delete(id);
      res.set("Cache-Control", "no-store").json({ state: "expired" });
      return;
    }
    res.set("Cache-Control", "no-store").json(await lookUp(receiptId, id));
  });

  return router;
}
