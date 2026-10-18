import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/index.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const HOUR = 3600;

function freshTokens(ageHours) {
  const issuedAt = Math.floor(Date.now() / 1000) - ageHours * HOUR;
  return { access_token: "a", refresh_token: "r", expires_in: HOUR, expires_at: issuedAt + HOUR };
}

async function getHealth({ config, loadTokens, fetch, db = openDatabase(":memory:") }) {
  const app = createApp({ db, config, deps: { loadTokens, fetch } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${server.address().port}/health`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

function strassAnswer(body, status = 200) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test("config reads IS_FAKE and the strass URL", () => {
  assert.equal(loadConfig({}).fake, false);
  assert.equal(loadConfig({ IS_FAKE: "1" }).fake, true);
  assert.equal(loadConfig({ IS_FAKE: "0" }).fake, false);
  assert.equal(loadConfig({}).port, 3003);
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({}).strassServiceUrl, "http://127.0.0.1:8000");
  assert.equal(loadConfig({ STRASS_SERVICE_URL: "http://127.0.0.1:9000/" }).strassServiceUrl, "http://127.0.0.1:9000");
});

test("all green: 200 with db, strass and etsy ok", async () => {
  const strass = strassAnswer({ ok: true, modelsLoaded: true, version: "1.2.0", busy: false });
  const { status, body } = await getHealth({
    config: loadConfig({}),
    loadTokens: async () => freshTokens(2),
    fetch: strass.fetch
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.fake, false);
  assert.deepEqual(body.db, { ok: true });
  assert.deepEqual(body.strass, { ok: true, busy: false });
  assert.equal(body.etsy.connected, true);
  assert.equal(body.etsy.tokenAgeHours, 2);
  assert.deepEqual(strass.calls, ["http://127.0.0.1:8000/health"]);
});

test("IS_FAKE=1 makes no strass call", async () => {
  const strass = strassAnswer({});
  const { status, body } = await getHealth({
    config: loadConfig({ IS_FAKE: "1" }),
    loadTokens: async () => freshTokens(1),
    fetch: strass.fetch
  });

  assert.equal(status, 200);
  assert.equal(body.fake, true);
  assert.deepEqual(body.strass, { ok: true, skipped: true });
  assert.deepEqual(strass.calls, []);
});

test("strass down or models not loaded: 503", async () => {
  for (const fetch of [
    async () => { throw new Error("ECONNREFUSED 127.0.0.1:8000"); },
    strassAnswer({ ok: true, modelsLoaded: false }).fetch,
    strassAnswer({ error: "x" }, 500).fetch
  ]) {
    const { status, body } = await getHealth({
      config: loadConfig({}),
      loadTokens: async () => freshTokens(1),
      fetch
    });

    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.strass.ok, false);
    assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "no error text in the answer");
  }
});

test("etsy not connected, unreadable or too old: 503", async () => {
  const strass = strassAnswer({ ok: true, modelsLoaded: true }).fetch;

  for (const [loadTokens, connected] of [
    [async () => null, false],
    [async () => { throw new Error("TOKEN_ENCRYPTION_KEY is not configured."); }, false],
    [async () => freshTokens(91 * 24), true]
  ]) {
    const { status, body } = await getHealth({ config: loadConfig({}), loadTokens, fetch: strass });

    assert.equal(status, 503);
    assert.equal(body.etsy.ok, false);
    assert.equal(body.etsy.connected, connected);
    assert.ok(!JSON.stringify(body).includes("TOKEN_ENCRYPTION_KEY"));
  }
});

test("database failure: 503", async () => {
  const db = openDatabase(":memory:");
  db.close();

  const { status, body } = await getHealth({
    db,
    config: loadConfig({ IS_FAKE: "1" }),
    loadTokens: async () => freshTokens(1),
    fetch: strassAnswer({}).fetch
  });

  assert.equal(status, 503);
  assert.deepEqual(body.db, { ok: false });
});
