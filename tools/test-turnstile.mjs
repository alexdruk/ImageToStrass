import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createTurnstile } from "../src/server/turnstile.js";
import { CHROME, launchBrowser } from "./browser-cdp.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { runFlow } from "./webapp-flow.mjs";

// Turnstile on Upload and Create design (spec section 13). The unit part mocks siteverify. The
// wiring part uses Cloudflare's official test keys against the real Turnstile service (skipped when
// it cannot be reached): the server with the always-pass and always-fail secret keys, and the web
// app in a browser with the always-pass and always-block site keys. Real keys stay empty until launch.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/

const KEYS = {
  sitePass: "1x00000000000000000000AA",
  siteBlock: "2x00000000000000000000AB",
  secretPass: "1x0000000000000000000000000000000AA",
  secretFail: "2x0000000000000000000000000000000AA"
};
// The token the test site keys give; the test secret keys accept it (pass) or refuse it (fail).
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const PHOTO = readFileSync(new URL("./fixtures/upload/photo.png", import.meta.url));
const CAT = new URL("../services/strass/tests/fixtures/photos/cat.jpg", import.meta.url).pathname;

const online = await fetch("https://challenges.cloudflare.com/turnstile/v0/api.js", { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok, () => false);
const offline = !online && "Turnstile cannot be reached";

test("verify posts the secret, token and IP to siteverify and reads success", async () => {
  const calls = [];
  const answers = [{ success: true }, { success: false, "error-codes": ["invalid-input-response"] }];
  const verify = createTurnstile({
    secret: "s3cret",
    fetch: async (url, options) => {
      calls.push({ url, body: Object.fromEntries(options.body) });
      return { json: async () => answers.shift() };
    }
  });

  assert.equal(await verify("tok", "203.0.113.9"), true);
  assert.equal(await verify("tok", "203.0.113.9"), false);
  assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(calls[0].body, { secret: "s3cret", response: "tok", remoteip: "203.0.113.9" });
});

test("verify refuses an empty or oversized token without a call, and fails closed on errors", async () => {
  let calls = 0;
  const verify = createTurnstile({ secret: "s", fetch: async () => { calls += 1; throw new Error("down"); } });
  assert.equal(await verify("", "ip"), false);
  assert.equal(await verify(undefined, "ip"), false);
  assert.equal(await verify("x".repeat(2049), "ip"), false);
  assert.equal(calls, 0);
  assert.equal(await verify("tok", "ip"), false);
  assert.equal(calls, 1);
  // No secret (local development): no check.
  assert.equal(await createTurnstile({ secret: "", fetch: () => assert.fail() })("", "ip"), true);
});

async function uploadAndCreate(srv, token) {
  const form = new FormData();
  form.append("consent", "1");
  form.append("cf-turnstile-response", token);
  form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
  const up = await fetch(`${srv.url}/api/upload`, { method: "POST", body: form });
  const upBody = await up.json();
  if (!up.ok) return { upload: up.status, error: upBody.error };
  for (let i = 0; i < 100 && (await (await fetch(`${srv.url}/api/uploads/${upBody.code}/1`)).json()).background !== "ready"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const created = await fetch(`${srv.url}/api/attempts/${upBody.code}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload: 1, mode: "colour", removeBackground: true, "cf-turnstile-response": token })
  });
  return { upload: up.status, create: created.status, error: (await created.json()).error };
}

test("server with the always-pass test secret: Upload and Create design pass", { skip: offline, timeout: 60_000 }, async () => {
  const srv = await startFakeServer({ env: { TURNSTILE_SECRET_KEY: KEYS.secretPass, TURNSTILE_SITE_KEY: KEYS.sitePass } });
  try {
    assert.deepEqual(await uploadAndCreate(srv, DUMMY_TOKEN), { upload: 201, create: 202, error: undefined });
    // No token at all is still refused (checked before any call).
    assert.deepEqual(await uploadAndCreate(srv, ""), { upload: 403, error: "verification" });
    await srv.pipeline.idle();
  } finally {
    await srv.stop();
  }
});

test("server with the always-fail test secret: Upload is refused", { skip: offline, timeout: 60_000 }, async () => {
  const srv = await startFakeServer({ env: { TURNSTILE_SECRET_KEY: KEYS.secretFail, TURNSTILE_SITE_KEY: KEYS.sitePass } });
  try {
    assert.deepEqual(await uploadAndCreate(srv, DUMMY_TOKEN), { upload: 403, error: "verification" });
    // Create design checks on its own: a code made earlier still cannot start a design.
    const { code } = srv.q.createCode();
    const created = await fetch(`${srv.url}/api/attempts/${code}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload: 1, mode: "colour", "cf-turnstile-response": DUMMY_TOKEN })
    });
    assert.equal(created.status, 403);
    assert.equal((await created.json()).error, "verification");
  } finally {
    await srv.stop();
  }
});

const noBrowser = offline || (!existsSync(CHROME) && "Chrome not found");

test("browser, always-pass site and secret keys: the whole flow goes through the widget", { skip: noBrowser, timeout: 180_000 }, async () => {
  const server = await startFakeServer({ env: { TURNSTILE_SECRET_KEY: KEYS.secretPass, TURNSTILE_SITE_KEY: KEYS.sitePass } });
  const browser = await launchBrowser();
  try {
    const result = await runFlow({ page: browser.page, server, width: 1280, height: 860, mobile: false, photo: CAT });
    assert.deepEqual(result.leaks, []);
    assert.equal(result.overflow, 0);
    // The server refuses an empty token, so the upload and both designs got tokens from the widget.
    assert.equal(server.q.getCode(result.code).attempts_used, 2);
  } finally {
    await browser.close();
    await server.stop();
  }
});

async function uploadInBrowser(env) {
  const server = await startFakeServer({ env });
  const browser = await launchBrowser();
  const { page } = browser;
  try {
    await page.viewport(1280, 860);
    await page.goto(`${server.url}/`);
    await page.waitFor("document.querySelector('#drop') && document.querySelector('#check input[name=cf-turnstile-response]')", { what: "the Turnstile widget" });
    await page.click("#consent");
    await page.setFiles("#file", [CAT]);
    await page.waitFor("location.pathname.endsWith('/prepare') || document.querySelector('#error').textContent", { timeoutMs: 40_000 });
    return { path: await page.eval("location.pathname"), error: await page.eval("document.querySelector('#error')?.textContent || ''") };
  } finally {
    await browser.close();
    await server.stop();
  }
}

test("browser, always-block site key: the upload is refused with the verification text", { skip: noBrowser, timeout: 90_000 }, async () => {
  const out = await uploadInBrowser({ TURNSTILE_SECRET_KEY: KEYS.secretPass, TURNSTILE_SITE_KEY: KEYS.siteBlock });
  assert.equal(out.path, "/");
  assert.equal(out.error, "The security check didn't pass. Please try again.");
});

test("browser, always-pass site key but always-fail secret: the upload is refused", { skip: noBrowser, timeout: 90_000 }, async () => {
  const out = await uploadInBrowser({ TURNSTILE_SECRET_KEY: KEYS.secretFail, TURNSTILE_SITE_KEY: KEYS.sitePass });
  assert.equal(out.path, "/");
  assert.equal(out.error, "The security check didn't pass. Please try again.");
});
