import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { downloadState } from "../src/server/webapp.js";
import { zipEntryNames } from "../src/export/zip.js";
import { startFakeServer } from "./fake-server.mjs";
import { findLeaks } from "./leak-words.mjs";

// The web app's routes (spec section 10) in fake mode: screens, session, the two views, "Use this
// design", the download states and the ZIP, and the test-only payment switch and its guards.
// Every response is checked for the words of spec section 12, and so is every file in public/.

const PHOTO = readFileSync(new URL("./fixtures/upload/photo.png", import.meta.url));
const PUBLIC = new URL("../public/", import.meta.url).pathname;
const SCREENS = ["/", "/c/IS-AAAA-BBBB", "/c/IS-AAAA-BBBB/prepare", "/c/IS-AAAA-BBBB/working",
  "/c/IS-AAAA-BBBB/result/2", "/c/IS-AAAA-BBBB/done", "/download", "/privacy", "/terms", "/contact"];

// fetch that checks every answer's headers and (text) body for the section 12 words.
function checkedFetch(base) {
  return async (url, options) => {
    const response = await fetch(`${base}${url}`, options);
    const body = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") || "";
    const where = `${options?.method || "GET"} ${url}`;
    assert.deepEqual(findLeaks(JSON.stringify([...response.headers])), [], `${where} headers`);
    assert.equal(response.headers.get("x-powered-by"), null, `${where} x-powered-by`);
    if (/json|text|javascript|svg/.test(type)) assert.deepEqual(findLeaks(body.toString("utf8")), [], `${where} body`);
    return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body.toString("utf8")) };
  };
}

const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function uploadAndDesign(srv, get, settings = { upload: 1, mode: "colour", removeBackground: true, adjustments: { brightness: 12 } }) {
  const form = new FormData();
  form.append("consent", "1");
  form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
  const up = (await get("/api/upload", { method: "POST", body: form })).json();
  // The fake cut-out is written right after the upload.
  for (let i = 0; i < 50 && (await get(`/api/uploads/${up.code}/1`)).json().background !== "ready"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const created = await get(`/api/attempts/${up.code}`, post(settings));
  assert.equal(created.status, 202);
  await srv.pipeline.idle();
  return { code: up.code, n: created.json().attempt };
}

test("every screen URL answers the app page with a CSP; other paths are 404", async () => {
  const srv = await startFakeServer();
  const get = checkedFetch(srv.url);
  try {
    const index = readFileSync(path.join(PUBLIC, "index.html"));
    for (const url of SCREENS) {
      const r = await get(url);
      assert.equal(r.status, 200, url);
      assert.ok(r.body.equals(index), url);
      assert.match(r.headers.get("content-security-policy"), /default-src 'self'/, url);
    }
    for (const url of ["/nope", "/c/IS-AAAA-BBBB/other", "/customizer", "/api/frames"]) {
      assert.equal((await get(url)).status, 404, url);
    }
    for (const file of ["app.js", "styles.css", "logo.svg", "adjust.js"]) assert.equal((await get(`/${file}`)).status, 200, file);
  } finally {
    await srv.stop();
  }
});

test("no file in public/ contains the words of spec section 12", () => {
  const files = readdirSync(PUBLIC, { recursive: true }).map((f) => path.join(PUBLIC, f)).filter((f) => statSync(f).isFile());
  assert.ok(files.length >= 5);
  for (const file of files) {
    assert.deepEqual(findLeaks(path.basename(file)), [], file);
    assert.deepEqual(findLeaks(readFileSync(file, "utf8")), [], file);
  }
});

test("session, views, Use this design and Try again settings", async () => {
  const srv = await startFakeServer();
  const get = checkedFetch(srv.url);
  try {
    const config = (await get("/api/config")).json();
    assert.equal(config.designsPerCode, 3);
    assert.equal(config.colours.jet.name, "Jet");
    assert.equal(config.sizes.ss6, "SS6");

    const { code, n } = await uploadAndDesign(srv, get);
    const session = (await get(`/api/codes/${code.toLowerCase().replace(/-/g, " ")}`)).json();
    assert.equal(session.code, code, "codes are normalised");
    assert.equal(session.designsLeft, 2);
    assert.deepEqual(session.designs, [{ attempt: n, mode: "colour" }]);
    assert.equal(session.active, null);
    assert.equal(session.upload.upload, 1);
    // Try again starts from the previous settings (spec 6.3).
    assert.deepEqual(session.settings, {
      removeBackground: true, mode: "colour",
      adjustments: { rotate: 0, crop: null, brightness: 12, contrast: 0, saturation: 0, autoEnhance: false }
    });

    const view = (await get(`/api/attempts/${code}/${n}`)).json();
    assert.ok(view.result.widthMm > 0 && view.result.widthIn > 0 && view.result.heightIn > 0);
    assert.equal(view.result.outputPx, undefined);

    // Tinted: the watermarked 900 px preview. Original: prepared.png or the decoded upload.
    const tinted = await get(`/api/attempts/${code}/${n}/tinted.png`);
    assert.equal(tinted.headers.get("content-type"), "image/png");
    const meta = await sharp(tinted.body).metadata();
    assert.equal(Math.max(meta.width, meta.height), 900);
    for (const source of ["prepared", "upload"]) {
      const r = await get(`/api/attempts/${code}/${n}/original.png?source=${source}`);
      assert.equal(r.status, 200, source);
      assert.equal(r.headers.get("content-type"), "image/png");
    }
    assert.equal((await get(`/api/attempts/${code}/${n}/original.png?source=ai`)).status, 404);
    assert.equal((await get(`/api/attempts/${code}/99/tinted.png`)).status, 404);
    // No route hands out the archive's other files.
    for (const name of ["ai.png", "layout.json", "stones.json", "settings.json"]) {
      assert.equal((await get(`/api/attempts/${code}/${n}/${name}`)).status, 404, name);
    }

    assert.equal((await get(`/api/codes/${code}/select`, post({ attempt: 99 }))).status, 404);
    const chosen = await get(`/api/codes/${code}/select`, post({ attempt: n }));
    assert.equal(chosen.status, 200);
    assert.equal(srv.q.getCode(code).selected_attempt, n);
    assert.equal((await get(`/api/codes/${code}`)).json().selected, n);
    assert.equal((await get("/api/codes/IS-0000-0000")).status, 404);
  } finally {
    await srv.stop();
  }
});

test("download states, the ZIP, and the test-only payment switch", async () => {
  const srv = await startFakeServer();
  const get = checkedFetch(srv.url);
  const pay = (code, state, headers = {}) => get(`/api/test/payment/${code}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ state })
  });
  try {
    const { code, n } = await uploadAndDesign(srv, get);
    const state = async () => (await get(`/api/download/${code}`)).json();

    assert.deepEqual((await get("/api/download/IS-0000-0000")).json(), { state: "unknown" });
    assert.deepEqual(await state(), { state: "unpaid" });
    assert.equal((await get(`/api/download/${code}/zip`)).status, 403);

    // Through the tunnel (CF-Connecting-IP set) the switch does not answer, even in fake mode.
    assert.equal((await pay(code, "paid", { "CF-Connecting-IP": "203.0.113.9" })).status, 404);
    assert.equal(srv.q.getCode(code).status, "open");

    const paid = (await pay(code, "paid")).json();
    assert.equal(paid.state, "ready");
    const row = srv.q.getCode(code);
    assert.equal(Date.parse(row.delivery_expires_at) - Date.parse(row.paid_at), 30 * 24 * 3600 * 1000);
    assert.equal((await state()).expiresAt, row.delivery_expires_at);

    // Paid: the design can no longer be changed; the ZIP has the spec's files (names are stored
    // uncompressed in the ZIP's directory).
    assert.equal((await get(`/api/codes/${code}/select`, post({ attempt: n }))).status, 409);
    const zip = await get(`/api/download/${code.replace(/-/g, "").toLowerCase()}/zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.match(zip.headers.get("content-disposition"), new RegExp(`filename="${code}.zip"`));
    assert.equal(zip.body.subarray(0, 2).toString(), "PK");
    for (const name of zipEntryNames(code)) assert.ok(zip.body.includes(Buffer.from(name)), name);
    assert.equal(srv.q.getCode(code).downloads, 1);

    // Past the 30 days, expired; refunded; and back.
    srv.q.updateCode(code, { delivery_expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(await state(), { state: "expired" });
    assert.equal((await get(`/api/download/${code}/zip`)).status, 403);
    await pay(code, "refunded");
    assert.deepEqual(await state(), { state: "refunded" });
    await pay(code, "expired");
    assert.deepEqual(await state(), { state: "expired" });
    assert.equal((await pay("IS-0000-0000", "paid")).status, 404);
    assert.equal((await pay(code, "free")).status, 404);
  } finally {
    await srv.stop();
  }
});

test("the payment switch does not exist without IS_FAKE=1", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "is-webapp-"));
  const config = { ...loadConfig({}), archiveDir: path.join(root, "archive"), deliveryDir: path.join(root, "delivery"), tmpDir: path.join(root, "tmp"), ipKeyFile: path.join(root, "key") };
  assert.equal(config.fake, false);
  const db = openDatabase(":memory:");
  const q = createQueries(db);
  const app = createApp({ db, config, deps: { verifyTurnstile: async () => true, background: { start() {}, state: () => "none" } } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { code } = q.createCode();
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/test/payment/${code}`, post({ state: "paid" }));
    assert.equal(r.status, 404);
    assert.equal(q.getCode(code).status, "open");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloadState", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.deepEqual(downloadState(null), { state: "unknown" });
  assert.deepEqual(downloadState({ status: "open" }, now), { state: "unpaid" });
  assert.deepEqual(downloadState({ status: "paid", delivery_expires_at: "2026-11-18T12:00:00.000Z" }, now), { state: "ready", expiresAt: "2026-11-18T12:00:00.000Z" });
  assert.deepEqual(downloadState({ status: "paid", delivery_expires_at: "2026-10-19T11:59:59.000Z" }, now), { state: "expired" });
  assert.deepEqual(downloadState({ status: "expired" }, now), { state: "expired" });
  assert.deepEqual(downloadState({ status: "refunded" }, now), { state: "refunded" });
});
