// The web app in fake mode (IS_FAKE=1) on its own temporary data folder, for clicking through and
// for the IS-05 browser checks. Nothing under data/ is read or written, and no provider, strass or
// Etsy call is made: background removal copies the upload and every design is the fixture layout.
//   node tools/fake-server.mjs [port] [--stage-ms=<ms>]
// --stage-ms keeps each pipeline stage busy that long so the Working screen can be seen (default 0,
// the plain IS_FAKE=1 pipeline).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createPipeline } from "../src/pipeline/design.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { etsyTestConfig, noEtsy } from "./etsy-mock.mjs";

// The fixtures of IS_FAKE=1 (src/pipeline/design.js): the fake layout and its own AI image, so the
// hole fill and black & white read the image the layout came from.
const FAKE_PNG = readFileSync(new URL("../src/pipeline/fake/ai.png", import.meta.url));
const FAKE_PX = { width: FAKE_PNG.readUInt32BE(16), height: FAKE_PNG.readUInt32BE(20) };
const FAKE_LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/layout.json", import.meta.url), "utf8"));
const quiet = { error() {}, warn() {}, log() {} };

// deps: createApp's (the Etsy API is noEtsy unless a test passes request).
export async function startFakeServer({ port = 0, stageMs = 0, env = {}, deps = {}, log = quiet } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "is-fake-"));
  const base = loadConfig({ IS_FAKE: "1", ...env });
  const config = {
    ...base,
    dataDir: root,
    etsy: etsyTestConfig(base.etsy, root),
    dbFile: ":memory:",
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    tmpDir: path.join(root, "tmp"),
    ipKeyFile: path.join(root, "ip-hash.key")
  };
  const db = openDatabase(config.dbFile);
  const q = createQueries(db);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // With stageMs the same fixtures as IS_FAKE=1, each answer delayed.
  const pipeline = stageMs > 0
    ? createPipeline({
      q, config: { ...config, fake: false }, log,
      provider: { redraw: async () => (await wait(stageMs), { png: FAKE_PNG, ...FAKE_PX }) },
      layoutCall: async () => (await wait(stageMs), { layout: FAKE_LAYOUT })
    })
    : createPipeline({ q, config, log });
  const app = createApp({ db, config, deps: { pipeline, request: noEtsy, ...deps } });
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    config, db, q, pipeline, root, app,
    async stop() {
      pipeline.stop();
      await pipeline.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv.find((a) => /^\d+$/.test(a)) || 3013);
  const stageMs = Number(process.argv.find((a) => a.startsWith("--stage-ms="))?.split("=")[1] || 0);
  const srv = await startFakeServer({ port, stageMs, log: console });
  console.log(`IS fake mode at ${srv.url} (data in ${srv.root}, removed on exit)`);
  const stop = async () => { await srv.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
