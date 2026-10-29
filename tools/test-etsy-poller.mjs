import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { createPoller, FIRST_LOOKBACK_MS, OVERLAP_MS } from "../src/etsy/poller.js";
import { isRefunded, ordersFromReceipts, personalizationOf } from "../src/etsy/matcher.js";
import { zipEntryNames } from "../src/export/zip.js";
import { createDelivery, deliveryExpiry } from "../src/server/delivery.js";
import { downloadState } from "../src/server/webapp.js";
import { etsyMock } from "./etsy-mock.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { findLeaks } from "./leak-words.mjs";

// IS-06 (spec sections 11.2-11.4): the matcher and the poller on recorded receipt JSON
// (tools/fixtures/etsy/, shaped as Etsy Open API v3 getShopReceipts answers), the delivery ZIP built
// when a code becomes paid, refunds, the download page's poll, the admin page and the OAuth routes'
// guards. The Etsy API is mocked throughout (etsy-mock.mjs); nothing reaches Etsy.
//
// The fixture shop: listing 1850000001 is IS, 1850000002 another product. Receipts:
//   3800000001  "pn 7k3q 9xpa"                    spaces, lower case       -> PN-7K3Q-9XPA
//   3800000002  "PN-ORIT-H8W2"                    O for 0, I for 1          -> PN-0R1T-H8W2
//   3800000003  "PN-C4DE-5FG6, pn h7j8 k9mn" (x2) two codes                 -> both
//   3800000004  "Please make it sparkle!"         no code                   -> unmatched
//   3800000005  "PN-ZZZZ-ZZZZ"                    a code IS never made      -> unmatched
//   3800000006  IS "my code: PN 9ABC DEFG thanks" + another listing ("Lily") -> PN-9ABC-DEFG only
//   3800000007  another listing only, its text looks like a code            -> ignored
//   3800000008  not paid yet (Payment Processing)                           -> not returned
// receipt-refunded.json is 3800000001 later, fully refunded.

const FIXTURES = new URL("./fixtures/etsy/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const RECEIPTS = read("shop-receipts.json").results;
const REFUNDED = read("receipt-refunded.json");
const SHOP = read("shop.json");
const USER = read("users-me.json");
const PHOTO = readFileSync(new URL("./fixtures/upload/photo.png", import.meta.url));
const IS_LISTING = 1850000001;
const NOW = Date.parse("2026-10-21T12:00:00Z");
const CODES = { a: "PN-7K3Q-9XPA", b: "PN-0R1T-H8W2", c: "PN-C4DE-5FG6", d: "PN-H7J8-K9MN", e: "PN-9ABC-DEFG", f: "PN-MNPQ-RST0", g: "PN-GGGG-2345" };
const quiet = { error() {}, warn() {}, log() {} };
const iso = (seconds) => new Date(seconds * 1000).toISOString();

// --- matcher -------------------------------------------------------------------------------------

test("matcher: the personalization is the variation with property 54 or named Personalization", () => {
  assert.equal(personalizationOf(RECEIPTS[0].transactions[0]), "pn 7k3q 9xpa");
  assert.equal(personalizationOf({ variations: [{ property_id: 513, formatted_name: "Personalisation", formatted_value: "PN-AAAA-BBBB" }] }), "PN-AAAA-BBBB");
  assert.equal(personalizationOf({ variations: [{ property_id: 200, formatted_name: "Colour", formatted_value: "Blue" }] }), "");
  assert.equal(personalizationOf({}), "");
});

test("matcher fallback (PN-07): with no code in the Personalization variation, every variation is read", () => {
  // The only variation has another property id and another name.
  const only = { listing_id: IS_LISTING, transaction_id: 4900000099, variations: [{ property_id: 1234, formatted_name: "Your design code", formatted_value: "pn-7k3q 9xpa" }] };
  assert.equal(personalizationOf(only), "pn-7k3q 9xpa");
  const [order] = ordersFromReceipts([{ ...RECEIPTS[0], transactions: [only] }], [IS_LISTING]);
  assert.deepEqual(order.codes, ["PN-7K3Q-9XPA"]);
  // The exact match comes first: its codes only, not another variation's.
  const both = { variations: [
    { property_id: 54, formatted_name: "Personalization", formatted_value: "PN-AAAA-BBBB" },
    { property_id: 1234, formatted_name: "Your design code", formatted_value: "PN-CCCC-DDDD" }
  ] };
  assert.equal(personalizationOf(both), "PN-AAAA-BBBB");
  // An empty Personalization falls back to the others; no code anywhere keeps the exact text.
  both.variations[0].formatted_value = "";
  assert.equal(personalizationOf(both), "\nPN-CCCC-DDDD");
  assert.equal(personalizationOf({ variations: [{ property_id: 54, formatted_name: "Personalization", formatted_value: "see message" }, { property_id: 200, formatted_name: "Colour", formatted_value: "Blue" }] }), "see message");
});

test("matcher: refunds and cancellations", () => {
  assert.equal(isRefunded(RECEIPTS[0]), false);
  assert.equal(isRefunded(REFUNDED), true);
  for (const status of ["Canceled", "Fully Refunded", "Partially Refunded"]) assert.equal(isRefunded({ status, refunds: [] }), true, status);
  assert.equal(isRefunded({ status: "Completed", refunds: [{ amount: {} }] }), true);
  assert.equal(isRefunded({ status: "Completed" }), false);
});

test("matcher: IS transactions only, every code normalised", () => {
  const orders = ordersFromReceipts(RECEIPTS, [IS_LISTING]);
  assert.deepEqual(orders.map((o) => [o.receipt_id, o.transaction_id, o.codes]), [
    [3800000001, 4900000001, [CODES.a]],
    [3800000002, 4900000002, [CODES.b]],
    [3800000003, 4900000003, [CODES.c, CODES.d]],
    [3800000004, 4900000004, []],
    [3800000005, 4900000005, ["PN-ZZZZ-ZZZZ"]],
    [3800000006, 4900000006, [CODES.e]]
  ]);
  assert.ok(orders.every((o) => o.status === "paid" && o.listing_id === IS_LISTING));
  assert.equal(orders[0].paid_at, iso(RECEIPTS[0].transactions[0].paid_timestamp));
  assert.equal(ordersFromReceipts([{ ...RECEIPTS[0], is_paid: false }], [IS_LISTING]).length, 0);
  assert.deepEqual(ordersFromReceipts(RECEIPTS, []), []);
  assert.deepEqual(ordersFromReceipts([REFUNDED], [IS_LISTING]).map((o) => o.status), ["refunded"]);
  // L for 1 too, and a code split over the text by underscores.
  const t = { listing_id: IS_LISTING, variations: [{ property_id: 54, formatted_value: "Pn_LNVK_7Q2W" }] };
  assert.deepEqual(ordersFromReceipts([{ receipt_id: 1, is_paid: true, transactions: [t] }], [IS_LISTING])[0].codes, ["PN-1NVK-7Q2W"]);
  // Codes made before PN-01 (IS-XXXX-XXXX) are no longer matched.
  const old = { listing_id: IS_LISTING, variations: [{ property_id: 54, formatted_value: "IS-7K3Q-9XPA" }] };
  assert.deepEqual(ordersFromReceipts([{ receipt_id: 1, is_paid: true, transactions: [old] }], [IS_LISTING])[0].codes, []);
});

// --- poller --------------------------------------------------------------------------------------

async function setup({ pageLimit } = {}) {
  let receipts = RECEIPTS;
  const mock = etsyMock({ user: USER, shop: SHOP, receipts: () => receipts });
  const srv = await startFakeServer({ deps: { request: mock.request, loadShop: async () => SHOP } });
  const insert = srv.db.prepare("INSERT INTO codes (code, created_at) VALUES (?, ?)");
  for (const code of Object.values(CODES)) insert.run(code, new Date(NOW - 3600_000).toISOString());

  // Code A gets a design (IS_FAKE), so its ZIP can be built.
  const form = new FormData();
  form.append("consent", "1");
  form.append("code", CODES.a);
  form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
  assert.equal((await fetch(`${srv.url}/api/upload`, { method: "POST", body: form })).status, 201);
  for (let i = 0; i < 100 && (await (await fetch(`${srv.url}/api/uploads/${CODES.a}/1`)).json()).background !== "ready"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await srv.pipeline.createDesign(CODES.a, { upload: 1, mode: "colour", removeBackground: true });
  await srv.pipeline.idle();

  const clock = { now: NOW };
  const config = { ...srv.config, etsy: { ...srv.config.etsy, listingIds: [IS_LISTING] } };
  const delivery = createDelivery({ q: srv.q, config, log: quiet });
  const poller = createPoller({
    q: srv.q, delivery, config, request: mock.request, getShop: async () => SHOP, now: () => clock.now,
    log: quiet, ...(pageLimit && { pageLimit })
  });
  const rows = () => srv.db.prepare("SELECT transaction_id, matched_code, status FROM etsy_orders ORDER BY transaction_id, matched_code").all();
  return { srv, mock, poller, delivery, clock, rows, setReceipts: (r) => { receipts = r; } };
}

const receiptCalls = (mock) => mock.calls.filter((c) => c.includes("/receipts")).map((c) => Object.fromEntries(new URL(c, "https://x").searchParams));

test("poller: first poll matches every case, marks the codes paid and builds the ZIP", { timeout: 120_000 }, async () => {
  const { srv, mock, poller, rows } = await setup();
  try {
    const out = await poller.runOnce();
    assert.equal(out.ok, true);
    assert.deepEqual(
      { receipts: out.receipts, transactions: out.transactions, rows: out.rows, unmatched: out.unmatched, paid: out.paid, refunded: out.refunded },
      // 7 paid receipts (the unpaid one is not returned); 6 IS transactions; A, B, C+D, E and 2 without a code.
      { receipts: 7, transactions: 6, rows: 7, unmatched: 2, paid: 5, refunded: 0 }
    );
    assert.deepEqual(rows(), [
      { transaction_id: 4900000001, matched_code: CODES.a, status: "paid" },
      { transaction_id: 4900000002, matched_code: CODES.b, status: "paid" },
      { transaction_id: 4900000003, matched_code: CODES.c, status: "paid" },
      { transaction_id: 4900000003, matched_code: CODES.d, status: "paid" },
      { transaction_id: 4900000004, matched_code: null, status: "paid" },
      { transaction_id: 4900000005, matched_code: null, status: "paid" },
      { transaction_id: 4900000006, matched_code: CODES.e, status: "paid" }
    ]);
    assert.deepEqual(srv.q.listUnmatchedOrders().map((o) => o.personalization).sort(), ["PN-ZZZZ-ZZZZ", "Please make it sparkle!"]);

    // The request: paid receipts modified in the last 30 days (no good run yet), first page.
    assert.deepEqual(receiptCalls(mock)[0], {
      was_paid: "true", min_last_modified: String(Math.floor((NOW - FIRST_LOOKBACK_MS) / 1000)),
      sort_on: "updated", sort_order: "asc", limit: "100", offset: "0"
    });

    const a = srv.q.getCode(CODES.a);
    const paidAt = iso(RECEIPTS[0].transactions[0].paid_timestamp);
    assert.deepEqual(
      { status: a.status, paid_at: a.paid_at, delivery_expires_at: a.delivery_expires_at, receipt_id: a.receipt_id, transaction_id: a.transaction_id },
      { status: "paid", paid_at: paidAt, delivery_expires_at: deliveryExpiry(paidAt), receipt_id: 3800000001, transaction_id: 4900000001 }
    );
    assert.equal(Date.parse(a.delivery_expires_at) - Date.parse(a.paid_at), 30 * 24 * 3600 * 1000);
    for (const code of [CODES.b, CODES.c, CODES.d, CODES.e]) assert.equal(srv.q.getCode(code).status, "paid", code);
    assert.equal(srv.q.getCode(CODES.f).status, "open", "a receipt not paid yet changes nothing");
    assert.equal(srv.q.getCode(CODES.g).status, "open");

    // The ZIP of A, built in the render worker when A became paid.
    await out.builds;
    const zip = readFileSync(`${srv.config.deliveryDir}/${CODES.a}/${CODES.a}.zip`);
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    for (const name of zipEntryNames(CODES.a)) assert.ok(zip.includes(Buffer.from(name)), name);
    // archive copy of the code row follows the change
    assert.equal(JSON.parse(readFileSync(`${srv.config.archiveDir}/${CODES.a}/code.json`, "utf8")).status, "paid");

    // The download page reads the real state.
    const state = await (await fetch(`${srv.url}/api/download/pn7k3q9xpa`)).json();
    assert.equal(state.state, "ready");
    assert.equal(state.expiresAt, a.delivery_expires_at);
    const download = await fetch(`${srv.url}/api/download/${CODES.a}/zip?agree=1`);
    assert.equal(download.status, 200);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(zip));

    // The poller's state file holds times and counts only.
    const saved = readFileSync(srv.config.etsy.stateFile, "utf8");
    for (const word of ["Test Buyer", "example.com", "sparkle", CODES.a]) assert.ok(!saved.includes(word), word);
  } finally {
    await srv.stop();
  }
});

test("poller (PN-07 follow-up): paid after the design was deleted is matched and paid, but flagged, not built, and the download page says so", { timeout: 120_000 }, async () => {
  const { srv, poller } = await setup();
  try {
    // The nightly job deleted A's files (D7); E was paid long ago, expired and deleted, and is bought again.
    rmSync(`${srv.config.archiveDir}/${CODES.a}`, { recursive: true, force: true });
    srv.q.updateCode(CODES.a, { files_deleted_at: new Date(NOW - 86400_000).toISOString() });
    srv.q.updateCode(CODES.e, { status: "expired", paid_at: "2026-08-01T10:00:00.000Z", transaction_id: 4900000111, files_deleted_at: "2026-09-01T03:30:00.000Z" });

    const out = await poller.runOnce();
    await out.builds;
    const a = srv.q.getCode(CODES.a);
    assert.equal(a.status, "paid", "the order is matched and the code paid as usual");
    assert.equal(a.receipt_id, 3800000001);
    assert.ok(a.undeliverable_at);
    assert.equal(existsSync(`${srv.config.deliveryDir}/${CODES.a}`), false, "no ZIP build");
    assert.equal(existsSync(`${srv.config.archiveDir}/${CODES.a}`), false, "the archive folder is not made again");
    const alerts = (code) => srv.q.listEvents(code).filter((e) => e.kind === "paid-after-delete").map((e) => JSON.parse(e.detail));
    assert.deepEqual(alerts(CODES.a), [{ how: "etsy", receiptId: 3800000001, transactionId: 4900000001 }]);
    // The expired code is not changed, but the new order cannot be delivered either.
    const e = srv.q.getCode(CODES.e);
    assert.equal(e.status, "expired");
    assert.ok(e.undeliverable_at);
    assert.deepEqual(alerts(CODES.e), [{ how: "etsy", receiptId: 3800000006, transactionId: 4900000006 }]);
    // Codes with their files are not flagged.
    assert.equal(srv.q.getCode(CODES.b).undeliverable_at, null);

    // The download page: the deleted state, no tick box, no download.
    for (const code of [CODES.a, CODES.e]) {
      assert.deepEqual(await (await fetch(`${srv.url}/api/download/${code}`)).json(), { state: "deleted" });
      assert.equal((await fetch(`${srv.url}/api/download/${code}/zip?agree=1`)).status, 403);
    }
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    assert.ok(app.includes("This design was deleted because it was more than 30 days old. Send us a message on Etsy and we will refund you."));

    // A later poll adds no second alert.
    await (await poller.runOnce()).builds;
    assert.equal(alerts(CODES.a).length, 1);
    assert.equal(alerts(CODES.e).length, 1);
    // Refunded on Etsy afterwards: the page then says refunded.
    srv.q.updateCode(CODES.a, { status: "refunded" });
    assert.deepEqual(await (await fetch(`${srv.url}/api/download/${CODES.a}`)).json(), { state: "refunded" });
  } finally {
    await srv.stop();
  }
});

test("poller: a repeated poll adds no row and changes nothing; it reads from the last good run - 10 min", { timeout: 120_000 }, async () => {
  const { srv, mock, poller, rows, clock } = await setup();
  try {
    // The fixture receipts were modified 8 to 15 minutes before NOW; the first poll runs 5 minutes
    // before NOW, so the second one (from that run - 10 min) reads them all again.
    clock.now = NOW - 5 * 60 * 1000;
    const first = await poller.runOnce();
    await first.builds;
    const zipFile = `${srv.config.deliveryDir}/${CODES.a}/${CODES.a}.zip`;
    const mtime = statSync(zipFile).mtimeMs;
    const before = { rows: rows(), codes: Object.values(CODES).map((c) => srv.q.getCode(c)) };

    clock.now = NOW;
    const again = await poller.runOnce();
    assert.equal(again.ok, true);
    assert.equal(again.paid, 0);
    assert.equal(again.rows, 7);
    assert.deepEqual(rows(), before.rows);
    assert.deepEqual(Object.values(CODES).map((c) => srv.q.getCode(c)), before.codes);
    assert.equal(statSync(zipFile).mtimeMs, mtime, "the ZIP is not built again");
    assert.equal(receiptCalls(mock)[1].min_last_modified, String(Math.floor((NOW - 5 * 60 * 1000 - OVERLAP_MS) / 1000)));
    assert.equal(srv.q.listEvents(CODES.a).filter((e) => e.kind === "paid").length, 1);
  } finally {
    await srv.stop();
  }
});

test("poller: pages through the receipts", { timeout: 120_000 }, async () => {
  const { srv, mock, poller, rows } = await setup({ pageLimit: 3 });
  try {
    const out = await poller.runOnce();
    assert.equal(out.receipts, 7);
    assert.deepEqual(receiptCalls(mock).map((c) => [c.limit, c.offset]), [["3", "0"], ["3", "3"], ["3", "6"]]);
    assert.equal(rows().length, 7);
  } finally {
    await srv.stop();
  }
});

test("poller: a refund locks the download; an admin unlock afterwards is not undone by the next poll", { timeout: 120_000 }, async () => {
  const { srv, poller, delivery, clock, setReceipts, rows } = await setup();
  try {
    await (await poller.runOnce()).builds;
    setReceipts([REFUNDED, ...RECEIPTS.slice(1)]);
    clock.now = NOW + 31 * 60 * 1000;

    const out = await poller.runOnce();
    assert.equal(out.refunded, 1);
    assert.equal(srv.q.getCode(CODES.a).status, "refunded");
    assert.equal(rows().find((r) => r.matched_code === CODES.a).status, "refunded");
    assert.equal(rows().length, 7);
    assert.deepEqual(await (await fetch(`${srv.url}/api/download/${CODES.a}`)).json(), { state: "refunded" });
    assert.equal((await fetch(`${srv.url}/api/download/${CODES.a}/zip`)).status, 403);
    // The ZIP file itself stays until the nightly job (only it deletes delivery ZIPs).
    assert.ok(existsSync(`${srv.config.deliveryDir}/${CODES.a}/${CODES.a}.zip`));
    assert.equal(srv.q.getCode(CODES.b).status, "paid", "other codes are untouched");

    // Alex unlocks it by hand; the same refunded receipt seen again does not lock it again.
    assert.ok(delivery.unlock(CODES.a));
    clock.now += 3 * 60 * 1000;
    const after = await poller.runOnce();
    assert.equal(after.refunded, 0);
    assert.equal(downloadState(srv.q.getCode(CODES.a)).state, "ready");
  } finally {
    await srv.stop();
  }
});

test("poller: an order without a code matched by hand pays the code and stays matched", { timeout: 120_000 }, async () => {
  const { srv, poller, clock, rows } = await setup();
  try {
    await (await poller.runOnce()).builds;
    const sparkle = srv.q.listUnmatchedOrders().find((o) => o.transaction_id === 4900000004);

    assert.deepEqual(poller.matchOrder(sparkle.id, "nope"), { ok: false, error: "unknown-code" });
    assert.deepEqual(poller.matchOrder(999999, CODES.g), { ok: false, error: "unknown-order" });
    const out = poller.matchOrder(sparkle.id, "pn gggg 2345");
    assert.equal(out.ok, true);
    await out.build;
    assert.equal(srv.q.getCode(CODES.g).status, "paid");
    assert.equal(srv.q.getCode(CODES.g).transaction_id, 4900000004);
    assert.deepEqual(poller.matchOrder(sparkle.id, CODES.g), { ok: false, error: "matched" });

    clock.now = NOW + 3 * 60 * 1000;
    await poller.runOnce();
    assert.deepEqual(rows().filter((r) => r.transaction_id === 4900000004), [{ transaction_id: 4900000004, matched_code: CODES.g, status: "paid" }]);
    assert.equal(srv.q.listUnmatchedOrders().length, 1);
  } finally {
    await srv.stop();
  }
});

test("poller: Etsy errors and a missing shop are recorded, and the next poll still reads from the last good run", async () => {
  const srv = await startFakeServer();
  try {
    let fail = true;
    let shop = null;
    const mock = etsyMock({ user: USER, shop: SHOP, receipts: () => RECEIPTS });
    const config = { ...srv.config, etsy: { ...srv.config.etsy, listingIds: [IS_LISTING] } };
    const clock = { now: NOW };
    const poller = createPoller({
      q: srv.q, delivery: createDelivery({ q: srv.q, config, log: quiet }), config, getShop: async () => shop, now: () => clock.now, log: quiet,
      request: async (p) => { if (fail) throw new Error("Etsy API request failed (503): <html>\n  busy </html>"); return mock.request(p); }
    });
    assert.deepEqual(await poller.runOnce().then(({ ok, error }) => ({ ok, error })), { ok: false, error: "Etsy shop is not connected." });
    shop = SHOP;
    const out = await poller.runOnce();
    assert.equal(out.ok, false);
    assert.equal(poller.status().lastError.message, "Etsy API request failed (503): <html> busy </html>");
    fail = false;
    clock.now = NOW + 60_000;
    assert.equal((await poller.runOnce()).ok, true);
    assert.equal(poller.status().lastError, null);
    assert.equal(receiptCalls(mock)[0].min_last_modified, String(Math.floor((NOW + 60_000 - FIRST_LOOKBACK_MS) / 1000)));
  } finally {
    await srv.stop();
  }
});

test("poller: the download page's polls are at most one a minute", async () => {
  const srv = await startFakeServer();
  try {
    const clock = { now: NOW };
    let polls = 0;
    const poller = createPoller({
      q: srv.q, delivery: createDelivery({ q: srv.q, config: srv.config, log: quiet }), config: srv.config, log: quiet,
      getShop: async () => { polls += 1; return null; }, now: () => clock.now
    });
    assert.equal(poller.requestPoll(), true);
    await poller.runOnce();
    clock.now += 59_000;
    assert.equal(poller.requestPoll(), false);
    clock.now += 1_000;
    assert.equal(poller.requestPoll(), true);
    await poller.runOnce();
    assert.equal(polls, 2);
  } finally {
    await srv.stop();
  }
});

test("download page: an unpaid code asks the poller for a poll, other states do not", async () => {
  const asked = [];
  const stub = { requestPoll: () => asked.push(1), status: () => ({}), runOnce: async () => ({ ok: true }), matchOrder: () => ({}) };
  const srv = await startFakeServer({ deps: { poller: stub } });
  try {
    const { code } = srv.q.createCode();
    await fetch(`${srv.url}/api/download/${code}`);
    await fetch(`${srv.url}/api/download/PN-0000-0000`);
    srv.q.updateCode(code, { status: "refunded" });
    await fetch(`${srv.url}/api/download/${code}`);
    assert.equal(asked.length, 1);
  } finally {
    await srv.stop();
  }
});

// --- admin page and OAuth routes -----------------------------------------------------------------

// GET/POST with full control of the Host and CF-Connecting-IP headers (the tunnel adds the latter).
function call(base, path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, method, headers: { host: url.host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const TUNNEL = { "cf-connecting-ip": "203.0.113.7" };
const form = (fields) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString()
});

test("admin and Etsy routes: this Mac or ADMIN_TOKEN only", async () => {
  const srv = await startFakeServer({
    env: { ADMIN_TOKEN: "t0ken-for-tests", ETSY_KEYSTRING: "kkk", ETSY_REDIRECT_URI: "https://example.trycloudflare.com/oauth/callback" },
    deps: { loadTokens: async () => null }
  });
  try {
    for (const path of ["/admin", "/auth/etsy", "/etsy/status", "/etsy/listings"]) {
      assert.equal((await call(srv.url, path, { headers: TUNNEL })).status, 404, `${path} through the tunnel`);
      assert.equal((await call(srv.url, path, { headers: { host: "evil.example:80" } })).status, 404, `${path} with another Host`);
      assert.equal((await call(srv.url, path, { headers: { ...TUNNEL, "x-admin-token": "wrong" } })).status, 404, `${path} wrong token`);
    }
    assert.equal((await call(srv.url, "/admin")).status, 200);
    assert.equal((await call(srv.url, "/admin", { headers: { ...TUNNEL, "x-admin-token": "t0ken-for-tests" } })).status, 200);
    assert.equal((await call(srv.url, "/admin", { method: "POST", ...form({}), headers: { ...form({}).headers, ...TUNNEL } })).status, 404);
    // Without ADMIN_TOKEN set, no token opens it.
    const plain = await startFakeServer();
    try {
      assert.equal((await call(plain.url, "/admin", { headers: { ...TUNNEL, "x-admin-token": "" } })).status, 404);
    } finally {
      await plain.stop();
    }
  } finally {
    await srv.stop();
  }
});

test("OAuth: /auth/etsy starts PKCE; the callback through the tunnel needs that state, once", async () => {
  const exchanged = [];
  const saved = [];
  const mock = etsyMock({ user: USER, shop: SHOP });
  const srv = await startFakeServer({
    env: { ETSY_KEYSTRING: "kkk", ETSY_REDIRECT_URI: "https://example.trycloudflare.com/oauth/callback" },
    deps: {
      request: mock.request,
      exchange: async (settings, code, verifier) => {
        exchanged.push({ settings, code, verifier });
        return { access_token: "acc", refresh_token: "ref", expires_in: 3600, token_type: "Bearer" };
      },
      saveTokens: async (tokens) => saved.push(tokens)
    }
  });
  try {
    const start = await call(srv.url, "/auth/etsy");
    assert.equal(start.status, 302);
    const to = new URL(start.headers.location);
    assert.equal(to.origin + to.pathname, "https://www.etsy.com/oauth/connect");
    assert.equal(to.searchParams.get("redirect_uri"), "https://example.trycloudflare.com/oauth/callback");
    assert.ok(to.searchParams.get("scope").split(" ").includes("transactions_r"));
    const state = to.searchParams.get("state");

    assert.equal((await call(srv.url, "/oauth/callback?code=c0de&state=forged", { headers: TUNNEL })).status, 404);
    assert.equal((await call(srv.url, "/oauth/callback?code=c0de", { headers: TUNNEL })).status, 404);

    const back = await call(srv.url, `/oauth/callback?code=c0de&state=${state}`, { headers: TUNNEL });
    assert.equal(back.status, 200);
    assert.match(back.text, /Etsy connected/);
    assert.match(back.text, /ISTestShop/);
    assert.equal(exchanged.length, 1);
    assert.equal(exchanged[0].code, "c0de");
    assert.equal(exchanged[0].settings.etsyRedirectUri, "https://example.trycloudflare.com/oauth/callback");
    assert.ok(exchanged[0].verifier.length >= 43);
    assert.equal(saved[0].refresh_token, "ref");
    assert.ok(Math.abs(saved[0].expires_at - (Date.now() / 1000 + 3600)) < 10);
    assert.deepEqual(JSON.parse(readFileSync(srv.config.etsy.shopFile, "utf8")).shop_id, SHOP.shop_id);
    // The token is not in the page.
    assert.ok(!back.text.includes("acc") && !back.text.includes("ref"));

    // A state is used once.
    assert.equal((await call(srv.url, `/oauth/callback?code=c0de&state=${state}`, { headers: TUNNEL })).status, 404);
    assert.equal((await call(srv.url, `/oauth/callback?code=c0de&state=${state}`)).status, 400);

    // Etsy's error text is shown as plain text, never as markup.
    const again = new URL((await call(srv.url, "/auth/etsy")).headers.location).searchParams.get("state");
    const denied = await call(srv.url, `/oauth/callback?state=${again}&error=access_denied&error_description=${encodeURIComponent("<script>x</script>")}`, { headers: TUNNEL });
    assert.equal(denied.status, 400);
    assert.match(denied.headers["content-type"], /^text\/plain/);
  } finally {
    await srv.stop();
  }
});

test("admin page: shows the state, matches, unlocks and polls; forms need the page's token", { timeout: 120_000 }, async () => {
  // This poll runs on the real clock: the fixture receipts are moved to now.
  const shift = Math.floor(Date.now() / 1000) - NOW / 1000;
  const recent = RECEIPTS.map((r) => ({ ...r, updated_timestamp: r.updated_timestamp + shift }));
  const mock = etsyMock({ user: USER, shop: SHOP, receipts: () => recent });
  const srv = await startFakeServer({
    env: { IS_ETSY_LISTING_IDS: String(IS_LISTING) },
    deps: { request: mock.request, loadShop: async () => SHOP, loadTokens: async () => ({ refresh_token: "r", expires_in: 3600, expires_at: Date.now() / 1000 + 1800 }) }
  });
  try {
    const insert = srv.db.prepare("INSERT INTO codes (code, created_at) VALUES (?, ?)");
    for (const code of Object.values(CODES)) insert.run(code, new Date().toISOString());

    let page = await call(srv.url, "/admin");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.match(page.text, /Connected/);
    assert.match(page.text, /ISTestShop/);
    assert.match(page.text, /href="\/auth\/etsy"/);
    const csrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];

    // A form without the page's token changes nothing.
    const forged = await call(srv.url, "/admin/poll", form({}));
    assert.equal(forged.status, 303);
    assert.equal(forged.headers.location, "/admin?msg=csrf");
    assert.equal(mock.calls.length, 0);

    assert.equal((await call(srv.url, "/admin/poll", form({ csrf }))).headers.location, "/admin?msg=polled");
    page = await call(srv.url, "/admin");
    assert.match(page.text, /7 receipts, 6 IS transactions, 5 paid, 0 refunded, 2 without a code/);
    assert.match(page.text, /Please make it sparkle!/);
    assert.match(page.text, /Orders without a code \(2\)/);
    assert.deepEqual(findLeaks(page.text), []);
    for (const word of ["Test Buyer", "example.com"]) assert.ok(!page.text.includes(word), word);

    const id = srv.q.listUnmatchedOrders().find((o) => o.transaction_id === 4900000004).id;
    assert.equal((await call(srv.url, "/admin/match", form({ csrf, id: String(id), code: "PN-0000-0000" }))).headers.location, "/admin?msg=unknown-code");
    assert.equal((await call(srv.url, "/admin/match", form({ csrf, id: String(id), code: CODES.g }))).headers.location, "/admin?msg=matched");
    assert.equal(srv.q.getCode(CODES.g).status, "paid");

    srv.q.updateCode(CODES.b, { status: "refunded" });
    assert.equal((await call(srv.url, "/admin/unlock", form({ csrf, code: "pn-0rit-h8w2" }))).headers.location, "/admin?msg=unlocked");
    assert.equal(srv.q.getCode(CODES.b).status, "paid");
    assert.equal((await call(srv.url, "/admin/unlock", form({ csrf, code: "PN-0000-0000" }))).headers.location, "/admin?msg=unknown-code");

    page = await call(srv.url, "/admin?msg=<b>x</b>");
    assert.ok(!page.text.includes("<b>x</b>"));
    assert.match(page.text, /Orders without a code \(1\)/);
    assert.match(page.text, /Disk use of data\//);
  } finally {
    await srv.stop();
  }
});

test("poller: a code made before PN-01 (IS-XXXX-XXXX) is left untouched and not matched or downloadable", { timeout: 120_000 }, async () => {
  const { srv, poller, setReceipts } = await setup();
  try {
    const old = "IS-7K3Q-9XPA";
    srv.db.prepare("INSERT INTO codes (code, created_at) VALUES (?, ?)").run(old, new Date(NOW - 3600_000).toISOString());
    const receipt = structuredClone(RECEIPTS[0]);
    receipt.transactions[0].variations.find((v) => v.property_id === 54).formatted_value = old;
    setReceipts([receipt]);
    const out = await poller.runOnce();
    await out.builds;
    assert.deepEqual([out.paid, out.unmatched], [0, 1]);
    assert.equal(srv.q.getCode(old).status, "open");
    assert.equal(srv.q.getCode(CODES.a).status, "open");
    assert.deepEqual(await (await fetch(`${srv.url}/api/download/${old}`)).json(), { state: "unknown" });
  } finally {
    await srv.stop();
  }
});
