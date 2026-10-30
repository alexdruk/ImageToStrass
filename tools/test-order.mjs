import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { business } from "../src/control/probes.js";
import { prepaidNotes } from "../src/control/page.js";
import { runNightly } from "../src/ops/nightly.js";
import { LOOKUPS_PER_IP_PER_HOUR, parseOrderNumber } from "../src/server/orders.js";
import { DELIVERY_DAYS } from "../src/server/delivery.js";
import { zipEntries } from "./zip-read.mjs";
import { etsyMock } from "./etsy-mock.mjs";
import { startFakeServer } from "./fake-server.mjs";

// PN-08, buy first, design after (spec sections 1, 4.1, 5, 10, 11.3, 13, D6, D7): an Etsy order with
// an empty Personalization field is redeemed on /order for prepaid codes, one per unit; a prepaid
// code makes designs outside the daily limits, its pick makes it paid and downloadable, the nightly
// job delivers its latest design after 30 days, a refund locks it, and its files are never deleted
// before the pick. IS_FAKE=1 throughout; Etsy is mocked from receipt JSON shaped as the recorded
// fixtures (tools/fixtures/etsy/); nothing reaches Etsy or a provider.

const FIXTURES = new URL("./fixtures/etsy/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const RECEIPTS = read("shop-receipts.json").results;
const SHOP = read("shop.json");
const PHOTO = readFileSync(new URL("./fixtures/upload/photo.png", import.meta.url));
const IS_LISTING = 1850000001;
const OTHER_LISTING = 1850000002;
const DAY_MS = 24 * 60 * 60 * 1000;

// A paid receipt of the IS listing shaped as the fixture's, one transaction per [quantity, text].
let nextId = 1;
function receipt(transactions, { listing = IS_LISTING, status = "Paid", refunds = [] } = {}) {
  const at = Math.floor(Date.now() / 1000) - 60;
  const receiptId = 3810000000 + nextId++;
  return {
    ...RECEIPTS[0],
    receipt_id: receiptId, status, refunds, is_paid: true,
    create_timestamp: at, created_timestamp: at, update_timestamp: at, updated_timestamp: at,
    transactions: transactions.map(([quantity, text], i) => ({
      ...RECEIPTS[0].transactions[0],
      transaction_id: receiptId + 1000000000 + i, receipt_id: receiptId, listing_id: listing, quantity,
      paid_timestamp: at,
      variations: text === null ? [] : [{ property_id: 54, value_id: null, formatted_name: "Personalization", formatted_value: text }]
    }))
  };
}

async function setup({ env = {}, deps = {} } = {}) {
  let receipts = [];
  const mock = etsyMock({ shop: SHOP, receipts: () => receipts });
  const srv = await startFakeServer({
    env: { IS_ETSY_LISTING_IDS: String(IS_LISTING), ...env },
    deps: { request: mock.request, loadShop: async () => SHOP, ...deps }
  });
  const poller = srv.app.locals.poller;
  const post = async (pathname, body, headers = {}) => {
    const r = await fetch(`${srv.url}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (pathname) => {
    const r = await fetch(`${srv.url}${pathname}`);
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null, response: r };
  };
  return {
    ...srv, poller, post, get, mock,
    setReceipts(list) { receipts = list; },
    // The receipts are stored by a poll, as the poller does every few minutes.
    async store(list) { receipts = list; assert.equal((await poller.runOnce()).ok, true); },
    redeem: (order, token = "t") => post("/api/order", { order: String(order), "cf-turnstile-response": token }),
    async upload(code) {
      const form = new FormData();
      form.append("consent", "1");
      form.append("code", code);
      form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
      const r = await fetch(`${srv.url}/api/upload`, { method: "POST", body: form });
      await srv.app.locals.background.idle();
      return { status: r.status, body: await r.json() };
    },
    async design(code, upload = 1) {
      const r = await post(`/api/attempts/${code}`, { upload, mode: "colour", removeBackground: true });
      await srv.pipeline.idle();
      return r;
    }
  };
}

test("order numbers: digits with spaces allowed, nothing else", () => {
  assert.equal(parseOrderNumber("3810000001"), 3810000001);
  assert.equal(parseOrderNumber(" 3810 000 001 "), 3810000001);
  for (const bad of ["", "12", "38100a0001", "#3810000001", "PN-7K3Q-9XPA", "-3810000001", "0381000000", "1".repeat(17), null, {}]) {
    assert.equal(parseOrderNumber(bad), null, String(bad));
  }
});

test("redeem: one unit makes one prepaid code; again returns the same code (a lost code is found)", async () => {
  const srv = await setup();
  try {
    const r = receipt([[1, ""]]);
    await srv.store([r]);
    assert.equal(srv.q.listUnmatchedOrders().length, 1);

    const first = await srv.redeem(r.receipt_id);
    assert.equal(first.status, 200);
    assert.equal(first.body.state, "found");
    assert.equal(first.body.codes.length, 1);
    const [{ code, state, designs }] = first.body.codes;
    assert.deepEqual({ state, designs }, { state: "prepaid", designs: 0 });
    const row = srv.q.getCode(code);
    assert.equal(row.status, "prepaid");
    assert.equal(row.receipt_id, r.receipt_id);
    assert.equal(row.transaction_id, r.transactions[0].transaction_id);
    assert.equal(row.paid_at, new Date(r.transactions[0].paid_timestamp * 1000).toISOString());
    assert.equal(row.delivery_expires_at, null);
    assert.ok(row.redeemed_at);
    assert.equal(row.ip_hash, null);
    // The order is matched: no "without a code" row is left, the code's row is there.
    assert.equal(srv.q.listUnmatchedOrders().length, 0);
    assert.equal(srv.q.getEtsyOrder(r.transactions[0].transaction_id, code).receipt_id, r.receipt_id);
    assert.deepEqual(srv.q.listEvents(code).map((e) => e.kind), ["order-redeemed"]);
    assert.ok(existsSync(path.join(srv.config.archiveDir, code, "code.json")));

    const again = await srv.redeem(` ${String(r.receipt_id).replace(/(\d{4})/g, "$1 ")}`);
    assert.deepEqual(again.body, first.body);
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 1);

    // A later poll keeps the match and makes no unmatched row again.
    await srv.poller.runOnce();
    assert.equal(srv.q.listUnmatchedOrders().length, 0);
    assert.equal(srv.q.getCode(code).status, "prepaid");

    // The session says where it came from; the download page asks for a pick.
    const session = await srv.get(`/api/codes/${code}`);
    assert.equal(session.body.status, "prepaid");
    assert.equal(session.body.fromOrder, true);
    assert.deepEqual((await srv.get(`/api/download/${code}`)).body, { state: "pick" });
    assert.equal((await srv.get(`/api/download/${code}/zip?agree=1`)).status, 403);
  } finally {
    await srv.stop();
  }
});

test("redeem: two units (one transaction of 2, or two transactions) make two codes", async () => {
  const srv = await setup();
  try {
    const one = receipt([[2, ""]]);
    const two = receipt([[1, ""], [1, null]]);
    await srv.store([one, two]);
    for (const r of [one, two]) {
      const answer = await srv.redeem(r.receipt_id);
      assert.equal(answer.body.codes.length, 2);
      assert.ok(answer.body.codes.every((c) => c.state === "prepaid"));
      assert.notEqual(answer.body.codes[0].code, answer.body.codes[1].code);
      assert.deepEqual((await srv.redeem(r.receipt_id)).body, answer.body);
    }
    const rows = srv.db.prepare("SELECT transaction_id, COUNT(*) n FROM codes GROUP BY transaction_id ORDER BY transaction_id").all();
    assert.deepEqual(rows.map((x) => x.n), [2, 1, 1]);
  } finally {
    await srv.stop();
  }
});

test("redeem: a unit whose personalization holds a code keeps it and nothing is made", async () => {
  const srv = await setup();
  try {
    const { code } = srv.q.createCode();
    const r = receipt([[1, `my code ${code.toLowerCase()}`]]);
    await srv.store([r]);
    assert.equal(srv.q.getCode(code).status, "paid");
    const answer = await srv.redeem(r.receipt_id);
    assert.deepEqual(answer.body, { state: "found", codes: [{ code, state: "ready" }] });
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 1);
    assert.equal(srv.q.listEvents(code).filter((e) => e.kind === "order-redeemed").length, 0);

    // Two units, one code in the text: that code is kept and one prepaid code is made.
    const { code: other } = srv.q.createCode();
    const mixed = receipt([[2, other]]);
    await srv.store([r, mixed]);
    const both = await srv.redeem(mixed.receipt_id);
    assert.equal(both.body.codes.length, 2);
    assert.ok(both.body.codes.some((c) => c.code === other && c.state !== "prepaid"));
    assert.equal(both.body.codes.filter((c) => c.state === "prepaid").length, 1);
  } finally {
    await srv.stop();
  }
});

test("redeem: a refunded or cancelled order gives no code; a refund later locks the prepaid codes", async () => {
  const srv = await setup();
  try {
    const refunded = receipt([[1, ""]], { status: "Fully Refunded" });
    const later = receipt([[2, ""]]);
    await srv.store([refunded, later]);
    assert.deepEqual((await srv.redeem(refunded.receipt_id)).body, { state: "refunded" });
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 0);

    const { body } = await srv.redeem(later.receipt_id);
    const codes = body.codes.map((c) => c.code);
    assert.equal(codes.length, 2);
    // The order turns refunded on Etsy: the poller marks its prepaid codes refunded.
    await srv.store([refunded, { ...later, status: "Fully Refunded", updated_timestamp: later.updated_timestamp + 5 }]);
    for (const code of codes) {
      assert.equal(srv.q.getCode(code).status, "refunded");
      assert.deepEqual((await srv.get(`/api/download/${code}`)).body, { state: "refunded" });
      assert.equal((await srv.get(`/api/codes/${code}`)).body.status, "refunded");
      assert.equal((await srv.upload(code)).status, 409);
    }
    assert.deepEqual((await srv.redeem(later.receipt_id)).body, { state: "refunded" });
  } finally {
    await srv.stop();
  }
});

test("redeem: an order not stored yet triggers a poll; still missing, the page waits with a ticket", async () => {
  const srv = await setup();
  try {
    // Paid on Etsy, not polled yet: the lookup's own poll finds it.
    const fresh = receipt([[1, ""]]);
    srv.setReceipts([fresh]);
    const calls = srv.mock.calls.length;
    const found = await srv.redeem(fresh.receipt_id);
    assert.equal(found.body.state, "found");
    assert.ok(srv.mock.calls.length > calls, "the lookup asked Etsy");

    // Unknown: the poll may run only once a minute, so the page waits and checks again with its ticket.
    const unknown = receipt([[1, ""]]);
    const waiting = await srv.redeem(unknown.receipt_id);
    assert.equal(waiting.body.state, "waiting");
    assert.match(waiting.body.ticket, /^[\w-]{20,}$/);
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 1);
    const still = await srv.get(`/api/order/${unknown.receipt_id}?ticket=${waiting.body.ticket}`);
    assert.deepEqual(still.body, waiting.body);
    // A ticket is for its own order only.
    assert.deepEqual((await srv.get(`/api/order/${fresh.receipt_id}?ticket=${waiting.body.ticket}`)).body, { state: "expired" });
    assert.deepEqual((await srv.get(`/api/order/${unknown.receipt_id}?ticket=nope`)).body, { state: "expired" });
    // The payment comes in with the next poll; the page's next check finds it.
    await srv.store([fresh, unknown]);
    const later = await srv.get(`/api/order/${unknown.receipt_id}?ticket=${waiting.body.ticket}`);
    assert.equal(later.body.state, "found");
    assert.equal(later.body.codes[0].state, "prepaid");
    // The ticket is used up.
    assert.deepEqual((await srv.get(`/api/order/${unknown.receipt_id}?ticket=${waiting.body.ticket}`)).body, { state: "expired" });
  } finally {
    await srv.stop();
  }
});

test("redeem: orders of other listings are never found and never make codes", async () => {
  const srv = await setup();
  try {
    const other = receipt([[1, ""]], { listing: OTHER_LISTING });
    await srv.store([other]);
    // Not stored at all (spec 11.3); stored by hand all the same, still never redeemed.
    srv.q.upsertEtsyOrder({ receipt_id: other.receipt_id, transaction_id: other.transactions[0].transaction_id, listing_id: OTHER_LISTING, status: "paid", quantity: 1 });
    assert.equal((await srv.redeem(other.receipt_id)).body.state, "waiting");
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 0);
  } finally {
    await srv.stop();
  }
});

test("lookup limits: Turnstile on each, a valid number, at most 10 per IP an hour, then busy", async () => {
  const srv = await setup({ deps: { verifyTurnstile: async (token) => token === "ok" } });
  try {
    const r = receipt([[1, ""]]);
    await srv.store([r]);
    assert.deepEqual(await srv.redeem(r.receipt_id, "bad"), { status: 403, body: { error: "verification" } });
    assert.deepEqual(await srv.redeem("PN-7K3Q-9XPA", "ok"), { status: 400, body: { error: "bad-order" } });
    for (let i = 0; i < LOOKUPS_PER_IP_PER_HOUR; i++) assert.equal((await srv.redeem(r.receipt_id, "ok")).status, 200, `lookup ${i + 1}`);
    assert.deepEqual(await srv.redeem(r.receipt_id, "ok"), { status: 429, body: { error: "busy" } });
    // Another IP (through the tunnel) still may.
    const tunnel = { host: "patternnifty.com", "cf-connecting-ip": "203.0.113.50" };
    assert.equal((await srv.post("/api/order", { order: String(r.receipt_id), "cf-turnstile-response": "ok" }, tunnel)).status, 200);
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 1);
  } finally {
    await srv.stop();
  }
});

test("prepaid designs skip the per-IP limit and the daily cap; the code's 3 designs and the queue stay", async () => {
  const srv = await setup({ env: { IS_DESIGNS_PER_IP_PER_DAY: "1", IS_DAILY_DESIGN_CAP: "1" } });
  try {
    // An open code takes the one design the limits allow; its next is refused.
    const open = srv.q.createCode().code;
    assert.equal((await srv.upload(open)).status, 201);
    assert.equal((await srv.design(open)).status, 202);
    assert.equal((await srv.design(open)).body.error, "busy");

    const r = receipt([[1, ""]]);
    await srv.store([r]);
    const code = (await srv.redeem(r.receipt_id)).body.codes[0].code;
    assert.equal((await srv.upload(code)).status, 201);
    for (let i = 0; i < 3; i++) {
      const made = await srv.design(code);
      assert.equal(made.status, 202, `prepaid design ${i + 1}`);
      assert.equal(srv.q.getAttempt(code, made.body.attempt).status, "done");
      assert.equal(srv.q.getAttempt(code, made.body.attempt).settings.prepaid, true);
    }
    assert.deepEqual((await srv.design(code)).body, { error: "limit" });
    // They never counted: the open code is still the only counted design today.
    assert.equal(srv.q.countDesignsSince(new Date(Date.now() - DAY_MS).toISOString()), 1);
    // The browser never sees the flag.
    const session = await srv.get(`/api/codes/${code}`);
    assert.equal(JSON.stringify(session.body).includes("prepaid\":true"), false);
    assert.equal(session.body.designsLeft, 0);
  } finally {
    await srv.stop();
  }
});

test("pick: a prepaid code becomes paid (Etsy paid time kept, 30 days from the pick), ZIP built and downloaded", async () => {
  const srv = await setup();
  try {
    const r = receipt([[1, ""]]);
    await srv.store([r]);
    const code = (await srv.redeem(r.receipt_id)).body.codes[0].code;
    const paidAt = srv.q.getCode(code).paid_at;
    await srv.upload(code);
    const first = (await srv.design(code)).body.attempt;
    const second = (await srv.design(code)).body.attempt;

    const before = Date.now();
    const pick = await srv.post(`/api/codes/${code}/select`, { attempt: first });
    assert.deepEqual(pick.body, { code, selected: first, paid: true });
    const row = srv.q.getCode(code);
    assert.equal(row.status, "paid");
    assert.equal(row.selected_attempt, first);
    assert.equal(row.paid_at, paidAt);
    const expires = Date.parse(row.delivery_expires_at);
    assert.ok(expires >= before + DELIVERY_DAYS * DAY_MS && expires <= Date.now() + DELIVERY_DAYS * DAY_MS);
    assert.deepEqual(srv.q.listEvents(code).map((e) => e.kind).filter((k) => !k.startsWith("design") && k !== "upload"), ["order-redeemed", "prepaid-picked"]);
    assert.deepEqual(JSON.parse(srv.q.firstEvent(code, "prepaid-picked").detail), { n: first, how: "buyer", receiptId: r.receipt_id, transactionId: r.transactions[0].transaction_id });

    // A second pick changes nothing; neither does a new design.
    assert.equal((await srv.post(`/api/codes/${code}/select`, { attempt: second })).body.error, "paid");
    assert.equal((await srv.design(code)).body.error, "limit");

    const state = (await srv.get(`/api/download/${code}`)).body;
    assert.equal(state.state, "ready");
    assert.equal(state.consented, false);
    const zip = await fetch(`${srv.url}/api/download/${code}/zip?agree=1`);
    assert.equal(zip.status, 200);
    const names = zipEntries(Buffer.from(await zip.arrayBuffer())).entries.map((e) => e.name);
    assert.ok(names.includes(`${code}.svg`) && names.includes("production-sheet-A4.pdf"), names.join());
    assert.ok(existsSync(path.join(srv.config.deliveryDir, code, `${code}.zip`)));
    // The order page shows it ready now.
    assert.deepEqual((await srv.redeem(r.receipt_id)).body.codes, [{ code, state: "ready" }]);
  } finally {
    await srv.stop();
  }
});

test("nightly: no pick 30 days after payment delivers the latest design; no design waits on the control panel; files kept until after the pick", async () => {
  const srv = await setup();
  try {
    const r = receipt([[3, ""]]);
    await srv.store([r]);
    const [withDesigns, without, recent] = (await srv.redeem(r.receipt_id)).body.codes.map((c) => c.code);
    await srv.upload(withDesigns);
    await srv.design(withDesigns);
    const latest = (await srv.design(withDesigns)).body.attempt;
    const paidAt = Date.parse(srv.q.getCode(withDesigns).paid_at);
    // The third was paid later (made up: its own date), so its 30 days are not over.
    srv.q.updateCode(recent, { paid_at: new Date(paidAt + 10 * DAY_MS).toISOString() });
    const config = { ...srv.config, logsDir: path.join(srv.root, "logs"), backupDir: path.join(srv.root, "backup") };

    // Day 29: nothing happens.
    let night = await runNightly({ db: srv.db, config, now: new Date(paidAt + 29 * DAY_MS), log: { error() {} } });
    assert.deepEqual(night.prepaid, { delivered: 0, waiting: 0 });
    assert.equal(srv.q.getCode(withDesigns).status, "prepaid");

    // Day 31: the latest design is delivered, its download starts then.
    const day31 = new Date(paidAt + 31 * DAY_MS);
    night = await runNightly({ db: srv.db, config, now: day31, log: { error() {} } });
    assert.deepEqual(night.prepaid, { delivered: 1, waiting: 1 });
    assert.match(night.line, /prepaid delivered 1 \(waiting 1\)/);
    const row = srv.q.getCode(withDesigns);
    assert.equal(row.status, "paid");
    assert.equal(row.selected_attempt, latest);
    assert.equal(row.delivery_expires_at, new Date(day31.getTime() + DELIVERY_DAYS * DAY_MS).toISOString());
    assert.equal(JSON.parse(srv.q.firstEvent(withDesigns, "prepaid-picked").detail).how, "auto");
    assert.ok(existsSync(path.join(srv.config.deliveryDir, withDesigns, `${withDesigns}.zip`)));
    assert.equal(srv.q.getCode(without).status, "prepaid");

    // The control panel: "Paid, no design yet" with the receipt number, for the one past 30 days only.
    const b = await business({ config: { dbFile: path.join(srv.root, "panel.sqlite"), pollerFile: "", shopFile: "" }, loadTokens: async () => null });
    assert.equal(b.db, false);
    await srv.db.backup(path.join(srv.root, "panel.sqlite"));
    const panel = await business({ config: { dbFile: path.join(srv.root, "panel.sqlite"), pollerFile: "", shopFile: "" }, loadTokens: async () => null, now: day31 });
    assert.deepEqual(panel.prepaidNoDesign.map((p) => [p.code, p.receiptId]), [[without, r.receipt_id]]);
    const html = prepaidNotes(panel.prepaidNoDesign);
    assert.match(html, /Paid, no design yet[\s\S]*?Receipt <b>\d+<\/b> · code <code>PN-/);

    // Day 120: nothing of a prepaid code is ever deleted; the delivered one goes when its download ends.
    night = await runNightly({ db: srv.db, config, now: new Date(paidAt + 120 * DAY_MS), log: { error() {} } });
    assert.equal(srv.q.getCode(without).files_deleted_at, null);
    assert.ok(existsSync(path.join(srv.config.archiveDir, without, "code.json")));
    assert.equal(srv.q.getCode(recent).files_deleted_at, null);
    assert.ok(srv.q.getCode(withDesigns).files_deleted_at);
    assert.equal(existsSync(path.join(srv.config.archiveDir, withDesigns)), false);
  } finally {
    await srv.stop();
  }
});

test("nightly: a picked prepaid code's files stay until its download ends (the pick + 30 days)", async () => {
  const srv = await setup();
  try {
    const r = receipt([[1, ""]]);
    await srv.store([r]);
    const code = (await srv.redeem(r.receipt_id)).body.codes[0].code;
    await srv.upload(code);
    const n = (await srv.design(code)).body.attempt;
    const paidAt = Date.parse(srv.q.getCode(code).paid_at);
    // Picked on day 20 (made up through the delivery directly, as the route does).
    const { createDelivery } = await import("../src/server/delivery.js");
    const delivery = createDelivery({ q: srv.q, config: srv.config, log: { error() {} } });
    await delivery.pickPrepaid(code, n, { how: "buyer", now: new Date(paidAt + 20 * DAY_MS) }).build;
    const config = { ...srv.config, logsDir: path.join(srv.root, "logs"), backupDir: path.join(srv.root, "backup") };
    await runNightly({ db: srv.db, config, now: new Date(paidAt + 45 * DAY_MS), log: { error() {} } });
    assert.equal(srv.q.getCode(code).files_deleted_at, null);
    assert.equal(srv.q.getCode(code).status, "paid");
    await runNightly({ db: srv.db, config, now: new Date(paidAt + 51 * DAY_MS), log: { error() {} } });
    assert.equal(srv.q.getCode(code).status, "expired");
    assert.ok(srv.q.getCode(code).files_deleted_at);
  } finally {
    await srv.stop();
  }
});

test("end to end (IS_FAKE=1): Etsy order with an empty Personalization -> /order -> design -> pick -> download", async () => {
  const srv = await setup();
  try {
    // The screens answer.
    for (const p of ["/order", "/"]) assert.equal((await fetch(`${srv.url}${p}`)).status, 200, p);
    const app = await (await fetch(`${srv.url}/app.js`)).text();
    assert.ok(app.includes("Already bought on Etsy?") && app.includes("Use this design and download") && app.includes("Pick your design first."));

    // The buyer checks out with the Personalization field empty (no variation at all).
    const order = receipt([[1, null]]);
    srv.setReceipts([order]);
    const found = await srv.redeem(order.receipt_id);
    assert.equal(found.body.state, "found");
    const code = found.body.codes[0].code;
    assert.equal((await srv.upload(code)).status, 201);
    const made = await srv.design(code);
    const view = (await srv.get(`/api/attempts/${code}/${made.body.attempt}`)).body;
    assert.equal(view.status, "done");
    assert.equal((await srv.get(`/api/attempts/${code}/${view.attempt}/tinted.png`)).status, 200);
    assert.equal((await srv.post(`/api/codes/${code}/select`, { attempt: view.attempt })).body.paid, true);
    const ready = (await srv.get(`/api/download/${code}`)).body;
    assert.equal(ready.state, "ready");
    const zip = await fetch(`${srv.url}/api/download/${code}/zip?agree=1`);
    assert.equal(zip.status, 200);
    assert.equal(zipEntries(Buffer.from(await zip.arrayBuffer())).entries.length, 9);
    assert.equal(srv.q.getCode(code).downloads, 1);
    assert.deepEqual(srv.q.listEvents(code).map((e) => e.kind).filter((k) => !k.startsWith("design") && k !== "upload"),
      ["order-redeemed", "prepaid-picked", "withdrawal-consent", "download"]);
  } finally {
    await srv.stop();
  }
});
