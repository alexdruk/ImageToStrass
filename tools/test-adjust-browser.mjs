import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyAdjustments } from "../src/prep/adjust.js";
import { readRgba } from "../src/prep/prepare.js";

// adjust.js must give the same bytes in Node and in the browser (IS-02 "Done when"). The same
// raw RGBA input goes to both; each side hashes its outputs with SHA-256. The browser is an
// isolated headless Chrome with a throw-away profile, started and stopped by this test only.

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ADJUST_JS = new URL("../public/adjust.js", import.meta.url);
const PHOTO = new URL("../services/strass/tests/fixtures/photos/cat.jpg", import.meta.url).pathname;

const CASES = [
  {},
  { rotate: 90 },
  { rotate: 270, crop: { x: 0.13, y: 0.071, w: 0.6, h: 0.777 } },
  { brightness: 37, contrast: -23, saturation: 61 },
  { brightness: -100, contrast: 100, saturation: -100 },
  { autoEnhance: true },
  { rotate: 180, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, brightness: -11, contrast: 47, saturation: -33, autoEnhance: true }
];

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { applyAdjustments } from "/adjust.js";
const report = (body) => fetch("/result", { method: "POST", body: JSON.stringify(body) });
try {
  const meta = await (await fetch("/meta.json")).json();
  const data = new Uint8ClampedArray(await (await fetch("/input.bin")).arrayBuffer());
  const hashes = [];
  for (const settings of meta.cases) {
    const out = applyAdjustments({ data, width: meta.width, height: meta.height }, settings);
    const digest = await crypto.subtle.digest("SHA-256", out.data);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    hashes.push(hex + ":" + out.width + "x" + out.height);
  }
  await report({ hashes, userAgent: navigator.userAgent });
} catch (error) {
  await report({ error: String(error && error.stack || error) });
}
</script>`;

function nodeHashes(image) {
  return CASES.map((settings) => {
    const out = applyAdjustments(image, settings);
    const hex = crypto.createHash("sha256").update(out.data).digest("hex");
    return `${hex}:${out.width}x${out.height}`;
  });
}

function serve(image) {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const input = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => { res.end("ok"); resolveResult(JSON.parse(body)); });
      return;
    }

    const routes = {
      "/": ["text/html", PAGE],
      "/adjust.js": ["text/javascript", readFileSync(ADJUST_JS)],
      "/meta.json": ["application/json", JSON.stringify({ width: image.width, height: image.height, cases: CASES })],
      "/input.bin": ["application/octet-stream", input]
    };
    const route = routes[req.url];

    if (!route) {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { "Content-Type": route[0] }).end(route[1]);
  });

  return { server, result };
}

test("adjust.js gives identical output in Node and in the browser", { skip: !existsSync(CHROME) && "Chrome not found" }, async () => {
  // A real photo at the browser preview size.
  const image = await readRgba(await (await import("sharp")).default(PHOTO).resize(1024).ensureAlpha().png().toBuffer());
  const expected = nodeHashes(image);
  const { server, result } = serve(image);

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  const profile = mkdtempSync(path.join(tmpdir(), "is-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-gpu", "--disable-background-networking",
    `http://127.0.0.1:${server.address().port}/`
  ], { stdio: "ignore" });

  try {
    // The timers are cleared (or unref'd) so the test process exits as soon as the test is done.
    let timer;
    const got = await Promise.race([
      result,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("browser did not answer in 60 s")), 60_000); })
    ]).finally(() => clearTimeout(timer));

    assert.equal(got.error, undefined, got.error);
    assert.match(got.userAgent, /Chrome/);
    assert.equal(new Set(expected).size, CASES.length, "every case gives a different image");
    assert.deepEqual(got.hashes, expected);
  } finally {
    // Only the headless instance started above; it may still write to its profile while exiting.
    const exited = chrome.exitCode !== null ? null : new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    server.close();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    // Chrome's helper processes can outlive it and keep writing; a profile left in the OS temp
    // folder is not a test failure.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3_000).unref());
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* left to the OS */ }
    }
  }
});
