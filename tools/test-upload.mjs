import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createBackgroundRemover } from "../src/prep/background.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { MAX_UPLOAD_BYTES } from "../src/server/upload.js";

const FIXTURES = new URL("./fixtures/upload/", import.meta.url).pathname;
const fixture = (name) => readFileSync(path.join(FIXTURES, name));
const CODE = /^IS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const FORMATS = [
  ["photo.png", "png"], ["photo.jpg", "jpg"], ["photo.bmp", "bmp"], ["photo.tif", "tif"],
  ["photo.webp", "webp"], ["photo.avif", "avif"], ["drawing.svg", "svg"]
];

// A server on a random port with its own data folder. env and deps can be overridden.
async function start({ env = { IS_FAKE: "1" }, deps = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "is-upload-"));
  const config = {
    ...loadConfig(env),
    archiveDir: path.join(root, "archive"),
    tmpDir: path.join(root, "tmp"),
    ipKeyFile: path.join(root, "ip-hash.key")
  };
  const db = openDatabase(":memory:");
  const background = deps.background || createBackgroundRemover({ config, fetch: deps.fetch, log: quiet });
  const app = createApp({ db, config, deps: { verifyTurnstile: async () => true, background, ...deps } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    root,
    config,
    db,
    q: createQueries(db),
    background,
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    async stop() {
      await background.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const quiet = { error() {}, warn() {}, log() {} };

function form({ file, name = "upload.bin", consent = "1", code, token } = {}) {
  const body = new FormData();
  if (consent !== null) body.append("consent", consent);
  if (code) body.append("code", code);
  if (token) body.append("cf-turnstile-response", token);
  if (file) body.append("image", new Blob([file]), name);
  return body;
}

async function upload(srv, fields) {
  const response = await fetch(`${srv.url}/api/upload`, { method: "POST", body: form(fields) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function tmpFiles(srv) {
  return existsSync(srv.config.tmpDir) ? readdirSync(srv.config.tmpDir) : [];
}

test("every accepted format uploads, is archived and becomes work.png", async () => {
  const srv = await start();

  try {
    for (const [name, ext] of FORMATS) {
      // A misleading name: the type comes from the signature.
      const { status, body, headers } = await upload(srv, { file: fixture(name), name: "picture.gif" });

      assert.equal(status, 201, name);
      assert.match(body.code, CODE);
      assert.deepEqual(Object.keys(body).sort(), ["background", "code", "height", "upload", "width"]);
      assert.equal(body.upload, 1);
      assert.equal(headers.get("x-powered-by"), null);

      const dir = path.join(srv.config.archiveDir, body.code, "uploads", "1");
      assert.deepEqual(readFileSync(path.join(dir, `original.${ext}`)), fixture(name), `${name}: original as received`);
      const meta = await sharp(path.join(dir, "work.png")).metadata();
      assert.deepEqual([meta.width, meta.height], [body.width, body.height]);

      const codeJson = JSON.parse(readFileSync(path.join(srv.config.archiveDir, body.code, "code.json"), "utf8"));
      const row = srv.q.getCode(body.code);
      assert.deepEqual(codeJson, row);
      assert.ok(row.consent_at);
      assert.match(row.ip_hash, /^[0-9a-f]{32}$/);
      assert.equal(srv.q.listEvents(body.code)[0].kind, "upload");
    }

    assert.deepEqual(tmpFiles(srv), [], "temp files removed");
  } finally {
    await srv.stop();
  }
});

test("a second upload to the same code gets the next upload number", async () => {
  const srv = await start();

  try {
    const first = await upload(srv, { file: fixture("photo.png") });
    const second = await upload(srv, { file: fixture("photo.jpg"), code: first.body.code.toLowerCase().replaceAll("-", " ") });

    assert.equal(second.status, 201);
    assert.equal(second.body.code, first.body.code);
    assert.equal(second.body.upload, 2);
    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 1);

    // An unknown code (e.g. a stale one in localStorage) gets a fresh code.
    const fresh = await upload(srv, { file: fixture("photo.png"), code: "IS-0000-0000" });
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.code, "IS-0000-0000");
  } finally {
    await srv.stop();
  }
});

test("bad files, missing consent and failed verification are refused without a code", async () => {
  let verified = false;
  const srv = await start({ deps: { verifyTurnstile: async (token) => verified && token === "ok" } });

  try {
    assert.deepEqual((await upload(srv, { file: fixture("photo.png"), token: "ok" })).body, { error: "verification" });
    verified = true;

    for (const [fields, status, error] of [
      [{ file: fixture("not-an-image.png"), token: "ok" }, 400, "bad-file"],
      [{ file: fixture("broken.png"), token: "ok" }, 400, "bad-file"],
      [{ file: fixture("malicious-script.svg"), token: "ok" }, 400, "bad-file"],
      [{ file: fixture("malicious-external-href.svg"), token: "ok" }, 400, "bad-file"],
      [{ file: Buffer.alloc(0), token: "ok" }, 400, "bad-file"],
      [{ token: "ok" }, 400, "bad-file"],
      [{ file: fixture("photo.png"), consent: null, token: "ok" }, 400, "consent"],
      [{ file: fixture("photo.png"), consent: "0", token: "ok" }, 400, "consent"],
      [{ file: fixture("photo.png"), token: "nope" }, 403, "verification"]
    ]) {
      const { status: got, body } = await upload(srv, fields);
      assert.equal(got, status, JSON.stringify(body));
      assert.deepEqual(body, { error });
    }

    assert.equal(srv.db.prepare("SELECT COUNT(*) FROM codes").pluck().get(), 0);
    assert.equal(existsSync(srv.config.archiveDir), false, "nothing archived");
    assert.deepEqual(tmpFiles(srv), []);
  } finally {
    await srv.stop();
  }
});

test("a code that is used up or no longer open takes no more uploads", async () => {
  const srv = await start();

  try {
    const { body } = await upload(srv, { file: fixture("photo.png") });

    for (let i = 0; i < 3; i += 1) {
      const { n } = srv.q.createAttempt(body.code, null);
      srv.q.updateAttempt(body.code, n, { status: "failed", counts: 0 });
    }
    assert.equal((await upload(srv, { file: fixture("photo.png"), code: body.code })).status, 201, "failed attempts do not count");

    for (let i = 0; i < 3; i += 1) {
      const { n } = srv.q.createAttempt(body.code, null);
      srv.q.updateAttempt(body.code, n, { status: "done", counts: 1 });
    }
    assert.deepEqual((await upload(srv, { file: fixture("photo.png"), code: body.code })).body, { error: "limit" });

    const other = (await upload(srv, { file: fixture("photo.png") })).body.code;
    srv.q.updateCode(other, { status: "paid" });
    assert.deepEqual((await upload(srv, { file: fixture("photo.png"), code: other })).body, { error: "limit" });
  } finally {
    await srv.stop();
  }
});

// Streams a multipart body with an image part of fileBytes bytes, chunked (no Content-Length),
// and stops sending as soon as the answer arrives. Resolves the status, body and bytes sent.
function streamUpload(srv, fileBytes, { declareLength = false } = {}) {
  const boundary = "----is-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="consent"\r\n\r\n1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="big.png"\r\n` +
    "Content-Type: image/png\r\n\r\n"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = Buffer.alloc(256 * 1024, 0x41);
  chunk.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return new Promise((resolve, reject) => {
    let sent = 0;
    let answered = false;
    const headers = { "Content-Type": `multipart/form-data; boundary=${boundary}` };

    if (declareLength) {
      headers["Content-Length"] = head.length + fileBytes + tail.length;
    }

    const req = http.request({ host: "127.0.0.1", port: srv.port, path: "/api/upload", method: "POST", headers });

    req.on("response", (res) => {
      answered = true;
      let text = "";
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text), sent }));
    });
    req.on("error", (error) => {
      if (!answered) reject(error);
    });

    function pump() {
      if (sent === 0) req.write(head);

      while (!answered && sent < fileBytes) {
        const part = chunk.subarray(0, Math.min(chunk.length, fileBytes - sent));
        sent += part.length;

        if (!req.write(part)) {
          req.once("drain", pump);
          return;
        }
      }

      if (!answered) req.end(tail);
    }

    if (declareLength) {
      req.flushHeaders();
      setTimeout(() => { if (!answered) pump(); }, 500);
    } else {
      pump();
    }
  });
}

async function withStream(fileBytes, options, check) {
  const srv = await start();

  try {
    await check(await streamUpload(srv, fileBytes, options));
    assert.equal(existsSync(srv.config.archiveDir), false, "nothing archived");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(tmpFiles(srv), [], "temp files removed");
  } finally {
    await srv.stop();
  }
}

test("50 MB + 1 byte is refused while streaming", () =>
  withStream(MAX_UPLOAD_BYTES + 1, {}, (over) => {
    assert.equal(over.status, 413);
    assert.deepEqual(over.body, { error: "too-large" });
  }));

test("a much larger body is answered long before the client has sent it all", () =>
  withStream(400 * 1024 * 1024, {}, (huge) => {
    assert.equal(huge.status, 413);
    assert.ok(huge.sent < 120 * 1024 * 1024, `answered after ${huge.sent} bytes`);
  }));

test("a declared length over the limit is refused before the body is read", () =>
  withStream(MAX_UPLOAD_BYTES + 1024 * 1024, { declareLength: true }, (declared) => {
    assert.equal(declared.status, 413);
    assert.equal(declared.sent, 0);
  }));

test("exactly 50 MB is received in full (junk after the signature, so bad-file)", () =>
  withStream(MAX_UPLOAD_BYTES, {}, (exact) => {
    assert.equal(exact.status, 400);
    assert.deepEqual(exact.body, { error: "bad-file" });
  }));

test("background removal runs after upload; status and both previews are served", async () => {
  const calls = [];
  const fakeStrass = async (url, init) => {
    calls.push(url);
    const input = Buffer.from(await init.body.get("image").arrayBuffer());
    const cut = await sharp(input).ensureAlpha(0.5).png().toBuffer();
    return new Response(cut, { status: 200, headers: { "Content-Type": "image/png" } });
  };
  const srv = await start({ env: {}, deps: { fetch: fakeStrass } });

  try {
    const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const { body } = await upload(srv, { file: big });
    assert.equal(body.background, "pending");
    assert.deepEqual([body.width, body.height], [1600, 1200]);

    await srv.background.idle();
    assert.deepEqual(calls, ["http://127.0.0.1:8000/remove-background"]);

    const status = await (await fetch(`${srv.url}/api/uploads/${body.code}/1`)).json();
    assert.deepEqual(status, { code: body.code, upload: 1, width: 1600, height: 1200, background: "ready" });

    for (const which of ["kept", "removed"]) {
      const response = await fetch(`${srv.url}/api/uploads/${body.code}/1/preview?background=${which}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.deepEqual([meta.width, meta.height], [1024, 768], which);
    }

    assert.ok(existsSync(path.join(srv.config.archiveDir, body.code, "uploads", "1", "cutout.png")));
    assert.equal((await fetch(`${srv.url}/api/uploads/${body.code}/2`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/uploads/IS-0000-0000/1`)).status, 404);
    assert.equal((await fetch(`${srv.url}/api/uploads/${body.code}/1/preview?background=mask`)).status, 404);
  } finally {
    await srv.stop();
  }
});

test("a failed background removal reports failed, keeps the upload and can be retried", async () => {
  let fail = true;
  const strass = async () => (fail
    ? new Response(JSON.stringify({ error: "background-failed", message: "boom" }), { status: 500 })
    : new Response(await sharp(fixture("photo.png")).png().toBuffer(), { status: 200 }));
  const srv = await start({ env: {}, deps: { fetch: strass } });

  try {
    const { body } = await upload(srv, { file: fixture("photo.jpg") });
    await srv.background.idle();

    const status = await (await fetch(`${srv.url}/api/uploads/${body.code}/1`)).json();
    assert.equal(status.background, "failed");
    assert.ok(!JSON.stringify(status).includes("boom"), "no service error text");
    assert.deepEqual(await (await fetch(`${srv.url}/api/uploads/${body.code}/1/preview?background=removed`)).json(), { error: "not-ready" });
    assert.equal((await fetch(`${srv.url}/api/uploads/${body.code}/1/preview?background=kept`)).status, 200);

    fail = false;
    srv.background.start(path.join(srv.config.archiveDir, body.code, "uploads", "1"));
    await srv.background.idle();
    assert.equal((await (await fetch(`${srv.url}/api/uploads/${body.code}/1`)).json()).background, "ready");
  } finally {
    await srv.stop();
  }
});

test("IS_FAKE=1 makes no strass call for background removal", async () => {
  const calls = [];
  const srv = await start({ env: { IS_FAKE: "1" }, deps: { fetch: async (url) => { calls.push(url); throw new Error("no"); } } });

  try {
    const { body } = await upload(srv, { file: fixture("photo.png") });
    await srv.background.idle();
    assert.equal((await (await fetch(`${srv.url}/api/uploads/${body.code}/1`)).json()).background, "ready");
    assert.deepEqual(calls, []);
  } finally {
    await srv.stop();
  }
});

test("the browser gets the same adjust.js the server runs", async () => {
  const srv = await start();

  try {
    const response = await fetch(`${srv.url}/adjust.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.equal(await response.text(), readFileSync(new URL("../src/prep/adjust.js", import.meta.url), "utf8"));
  } finally {
    await srv.stop();
  }
});
