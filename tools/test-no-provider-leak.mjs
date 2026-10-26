import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createPipeline } from "../src/pipeline/design.js";
import { FAKE_REDRAW_DATA_URL } from "../src/pipeline/fake/FakeRedrawProvider.js";
import { createBackgroundRemover } from "../src/prep/background.js";
import { PNG_SIGNATURE, aiImageForArchive, pngChunks, stripPngMetadata } from "../src/prep/pngmeta.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { etsyTestConfig, noEtsy } from "./etsy-mock.mjs";
import { buildPrompt } from "../src/pipeline/prompt.js";
import { findLeaks, leakWords } from "./leak-words.mjs";
import { zipEntries } from "./zip-read.mjs";

// Spec section 12 (CLAUDE.md "Never expose the provider"): a fake design end to end, every HTTP
// response body and header, every file the server sends (pages, scripts, images, the ZIP) and every
// ZIP entry is checked for the words of leak-words.mjs, image and document metadata included: PNG
// text, XMP, EXIF, ICC and C2PA chunks, JPEG APP and comment segments, PDF info and streams, SVG
// and DXF comments. Files the buyer gets may carry no metadata chunk at all. A provider whose image
// carries metadata naming it and whose errors name it must leave no trace either; its AI image is
// archived without metadata.

const ROOT = new URL("../", import.meta.url).pathname;
const PUBLIC = path.join(ROOT, "public");
const PHOTO = readFileSync(path.join(ROOT, "tools/fixtures/upload/photo.png"));
const FAKE_PNG = Buffer.from(FAKE_REDRAW_DATA_URL.split(",")[1], "base64");
const GOOD_LAYOUT = JSON.parse(readFileSync(path.join(ROOT, "src/pipeline/fake/layout.json"), "utf8"));
const WORDS = leakWords();
const MODEL = loadConfig().provider.model;
const quiet = { error() {}, warn() {}, log() {} };

// PNG chunks a file the buyer gets may have: the pixels, their physical size (spec 9) and the
// colour-encoding chunks the canvas writes (sRGB, sBIT; numbers only, no room for a name). Text,
// XMP, EXIF, ICC profile, time and C2PA chunks are metadata.
const SERVED_PNG_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "pHYs", "sRGB", "sBIT", "gAMA", "cHRM"]);

// ---- scanners: name + bytes -> problems found ([] when clean) ---------------------------------

const leaksIn = (where, text) => findLeaks(text, WORDS).map((w) => `${where}: "${w}"`);

function scanPng(name, buf) {
  const out = [];
  for (const c of pngChunks(buf)) {
    if (c.type === "IDAT") continue;
    if (!SERVED_PNG_CHUNKS.has(c.type)) out.push(`${name}: PNG metadata chunk ${c.type}`);
    let text = c.data.toString("latin1");
    // zTXt and iCCP: keyword/name, NUL, method, zlib data. iTXt: keyword, NUL, flag, method, ...
    if (c.type === "zTXt" || c.type === "iCCP") {
      const nul = c.data.indexOf(0);
      try { text += inflateSync(c.data.subarray(nul + 2)).toString("latin1"); } catch { /* raw text above */ }
    }
    if (c.type === "iTXt" && c.data[c.data.indexOf(0) + 1] === 1) {
      // keyword NUL, compressed flag, method, language NUL, translated keyword NUL, text.
      const lang = c.data.indexOf(0, c.data.indexOf(0) + 3);
      const translated = c.data.indexOf(0, lang + 1);
      try { text += inflateSync(c.data.subarray(translated + 1)).toString("utf8"); } catch { /* raw text above */ }
    }
    out.push(...leaksIn(`${name} (PNG ${c.type})`, text));
  }
  return out;
}

function scanJpeg(name, buf) {
  const out = [];
  let at = 2;
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = buf.readUInt16BE(at + 2);
    const data = buf.subarray(at + 4, at + 2 + length);
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) out.push(`${name}: JPEG metadata segment ${marker.toString(16)}`);
    out.push(...leaksIn(`${name} (JPEG ${marker.toString(16)})`, data.toString("latin1")));
    at += 2 + length;
  }
  return out;
}

function scanPdf(name, buf) {
  const text = buf.toString("latin1");
  const out = leaksIn(name, text);
  // Every stream, inflated when it is compressed (content, fonts, XMP metadata).
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(text))) {
    const end = text.indexOf("endstream", m.index);
    if (end < 0) break;
    const raw = buf.subarray(m.index + m[0].length, end);
    try { out.push(...leaksIn(`${name} (PDF stream)`, inflateSync(raw).toString("latin1"))); } catch { /* not deflated */ }
  }
  if (/\/Type\s*\/Metadata/.test(text)) out.push(`${name}: PDF XMP metadata stream`);
  // The info dictionary that counts (the last one) names PatternNifty only.
  const producers = [...text.matchAll(/\/(Producer|Creator)\s*\(([^)]*)\)/g)].map((x) => `${x[1]}=${x[2]}`);
  const last = { Producer: null, Creator: null };
  for (const p of producers) { const [k, v] = p.split("="); last[k] = v; }
  if (last.Producer !== "PatternNifty" || last.Creator !== "PatternNifty") out.push(`${name}: PDF Producer/Creator ${JSON.stringify(last)}`);
  return out;
}

function scanZip(name, buf) {
  const { entries, comment } = zipEntries(buf);
  const out = leaksIn(`${name} (ZIP comment)`, comment);
  for (const e of entries) {
    out.push(...leaksIn(`${name} entry name`, e.name), ...leaksIn(`${name}/${e.name} (comment)`, e.comment),
      ...leaksIn(`${name}/${e.name} (extra)`, e.extra.toString("latin1") + e.localExtra.toString("latin1")));
    out.push(...scanFile(`${name}/${e.name}`, e.data));
  }
  return out;
}

// Text files: the whole text, and their comments on their own (SVG/HTML <!-- -->, DXF 999 groups,
// EPS/PostScript %%).
function scanText(name, buf) {
  const text = buf.toString("utf8");
  const out = leaksIn(name, text);
  const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => { if (line.trim() === "999" && i + 1 < lines.length) comments.push(lines[i + 1]); });
  comments.push(...lines.filter((l) => l.startsWith("%")));
  for (const c of comments) out.push(...leaksIn(`${name} (comment)`, c));
  return out;
}

function scanFile(name, buf) {
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return scanPng(name, buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return scanJpeg(name, buf);
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return scanPdf(name, buf);
  if (buf.readUInt32LE(0) === 0x04034b50) return scanZip(name, buf);
  return scanText(name, buf);
}

// ---- a PNG carrying the metadata a provider image can carry ----------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let c = 0xffffffff;
  for (const b of body) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}
function withProviderMetadata(png) {
  const chunks = pngChunks(png);
  const ihdr = png.subarray(chunks[0].start, chunks[0].end);
  const rest = png.subarray(chunks[0].end);
  const xmp = `<x:xmpmeta><rdf:Description xmp:CreatorTool="OpenAI ${MODEL}"/></x:xmpmeta>`;
  return Buffer.concat([PNG_SIGNATURE, ihdr,
    chunk("tEXt", Buffer.from("Software\0OpenAI image API", "latin1")),
    chunk("iTXt", Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${xmp}`, "utf8")),
    chunk("eXIf", Buffer.from(`MM\0*\0\0\0\bSoftware=GPT ${MODEL}`, "latin1")),
    chunk("caBX", Buffer.from(`jumb c2pa claim_generator OpenAI ${MODEL}; prompt: a dog`, "latin1")),
    chunk("tIME", Buffer.from([7, 234, 10, 20, 12, 0, 0])),
    rest]);
}

// ---- server ------------------------------------------------------------------------------------

async function start({ env, pipelineDeps = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), "is-leak-"));
  const config = {
    ...loadConfig(env),
    archiveDir: path.join(root, "archive"), deliveryDir: path.join(root, "delivery"),
    tmpDir: path.join(root, "tmp"), ipKeyFile: path.join(root, "ip-hash.key")
  };
  const db = openDatabase(":memory:");
  const q = createQueries(db);
  const background = createBackgroundRemover({ config: { ...config, fake: true }, log: quiet });
  const pipeline = createPipeline({ q, config, log: quiet, ...pipelineDeps });
  const app = createApp({ db, config: { ...config, dataDir: root, etsy: etsyTestConfig(config.etsy, root) }, deps: { verifyTurnstile: async () => true, background, pipeline, loadTokens: async () => null, request: noEtsy } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const problems = [];
  const seen = [];

  // Every response: status line, headers and body, scanned.
  async function call(pathname, init = {}) {
    const response = await fetch(`${url}${pathname}`, init);
    const body = Buffer.from(await response.arrayBuffer());
    const what = `${init.method || "GET"} ${pathname}`;
    seen.push({ what, type: response.headers.get("content-type"), bytes: body.length });
    problems.push(...leaksIn(`${what} headers`, JSON.stringify([...response.headers])));
    if (body.length) problems.push(...scanFile(what, body));
    return { status: response.status, headers: response.headers, body };
  }
  const json = async (pathname, init) => {
    const r = await call(pathname, init);
    return { status: r.status, body: JSON.parse(r.body.toString("utf8")) };
  };
  const post = (pathname, data) => json(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  return {
    config, url, problems, seen, call, json, post, background, pipeline,
    async upload() {
      const form = new FormData();
      form.append("consent", "1");
      form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
      const r = await json("/api/upload", { method: "POST", body: form });
      await background.idle();
      return r.body;
    },
    async design(code, settings) {
      const created = await post(`/api/attempts/${code}`, settings);
      let view = created.body;
      while (view.status === "queued" || view.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        view = (await json(`/api/attempts/${code}/${view.attempt}`)).body;
      }
      await pipeline.idle();
      return view;
    },
    async stop() {
      await pipeline.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function publicFiles(dir = PUBLIC, prefix = "") {
  return readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory()
    ? publicFiles(path.join(dir, f), `${prefix}${f}/`) : [`${prefix}${f}`]));
}

const SETTINGS = { upload: 1, mode: "colour", removeBackground: true, adjustments: {} };

// ---- tests -------------------------------------------------------------------------------------

test("the word list: spec section 12's words, the model name and every prompt's first 40 characters", () => {
  for (const w of ["openai", "gpt", "dall", "prompt", MODEL]) assert.ok(WORDS.includes(w), w);
  // The prompt variants start alike, so their first 40 characters are one entry.
  for (const options of [{ mode: "colour" }, { mode: "bw", bwStyle: "stencil" }, { mode: "bw", bwStyle: "halftone" }]) {
    assert.ok(WORDS.includes(buildPrompt(options).slice(0, 40)), JSON.stringify(options));
  }
  // The scanners find what they look for.
  assert.ok(scanFile("x.svg", Buffer.from("<svg><!-- made by OpenAI --></svg>")).length);
  assert.ok(scanFile("x.png", withProviderMetadata(FAKE_PNG)).some((p) => p.includes("caBX")));
  assert.ok(scanFile("x.png", withProviderMetadata(FAKE_PNG)).some((p) => p.includes("eXIf")));
  assert.ok(scanFile("x.png", withProviderMetadata(FAKE_PNG)).some((p) => p.includes(`"${MODEL}"`)));
});

test("AI images are archived without metadata, pixels unchanged", async () => {
  const marked = withProviderMetadata(FAKE_PNG);
  const clean = stripPngMetadata(marked);
  assert.deepEqual(pngChunks(clean).map((c) => c.type), pngChunks(FAKE_PNG).map((c) => c.type));
  assert.deepEqual(scanFile("ai.png", clean), []);
  const raw = async (png) => sharp(png).ensureAlpha().raw().toBuffer();
  assert.ok((await raw(clean)).equals(await raw(marked)));
  assert.ok((await aiImageForArchive(marked)).equals(clean));
  // A provider answer that is not a PNG is archived as a PNG without its metadata.
  const jpeg = await sharp(FAKE_PNG).flatten().jpeg().withMetadata({ exif: { IFD0: { Software: "OpenAI" } } }).toBuffer();
  assert.ok(scanFile("ai.jpg", jpeg).length > 0);
  assert.deepEqual(scanFile("ai.png", await aiImageForArchive(jpeg)), []);
});

test("a fake design end to end: no response, header, file or ZIP entry names the provider", async () => {
  const publicBefore = publicFiles().join("\n");
  const env = await start({ env: { IS_FAKE: "1" } });
  try {
    // Pages, static files and the app's settings.
    for (const f of publicFiles()) await env.call(`/${f}`);
    for (const p of ["/", "/download", "/privacy", "/terms", "/contact", "/api/config", "/health", "/no-such-file.js"]) await env.call(p);

    const { code } = await env.upload();
    for (const p of ["", "/prepare", "/working", "/done"]) await env.call(`/c/${code}${p}`);
    await env.json(`/api/codes/${code}`);

    const colour = await env.design(code, SETTINGS);
    assert.equal(colour.status, "done");
    // Black & white in both styles (Bold and Shaded, IS-07b).
    const bw = await env.design(code, { ...SETTINGS, mode: "bw", bwStyle: "stencil" });
    assert.equal(bw.status, "done");
    const shaded = await env.design(code, { ...SETTINGS, mode: "bw", bwStyle: "halftone" });
    assert.equal(shaded.status, "done");
    for (const n of [colour.attempt, bw.attempt, shaded.attempt]) {
      await env.call(`/c/${code}/result/${n}`);
      for (const p of ["tinted.png", "original.png", "original.png?source=upload"]) {
        const r = await env.call(`/api/attempts/${code}/${n}/${p}`);
        assert.equal(r.status, 200, p);
      }
    }
    await env.post(`/api/codes/${code}/select`, { attempt: colour.attempt });
    await env.json(`/api/codes/${code}`);
    await env.json(`/api/download/${code}`);
    assert.equal((await env.call(`/api/download/${code}/zip`)).status, 403);
    assert.equal((await env.post(`/api/test/payment/${code}`, { state: "paid" })).body.state, "ready");
    await env.json(`/api/download/${code}`);
    const zip = await env.call(`/api/download/${code}/zip`);
    assert.equal(zip.status, 200);
    assert.equal(zipEntries(zip.body).entries.length, 9);

    // Refusals and unknown things answer with IS error codes only.
    await env.json("/api/codes/PN-0000-0000");
    await env.json(`/api/attempts/${code}/99`);
    await env.post(`/api/attempts/${code}`, { upload: 1, mode: "sepia" });
    await env.call(`/api/attempts/${code}/99/tinted.png`);
    await env.call("/api/download/PN-0000-0000/zip");

    // The archived AI images carry no metadata either.
    for (const n of [colour.attempt, bw.attempt, shaded.attempt]) {
      env.problems.push(...scanFile(`archive ai.png ${n}`, readFileSync(path.join(env.config.archiveDir, code, `attempt-${n}`, "ai.png"))));
    }
    assert.ok(env.seen.length >= 40, `${env.seen.length} responses checked`);
    assert.ok(env.seen.some((s) => s.type?.startsWith("image/png")) && env.seen.some((s) => s.type?.includes("zip")));
    assert.deepEqual(env.problems, []);
  } finally {
    await env.stop();
  }
  // Nothing (a log, say) was written under public/.
  assert.equal(publicFiles().join("\n"), publicBefore);
});

test("a provider that names itself in its image and its errors leaves no trace", async () => {
  const draws = [
    { png: withProviderMetadata(FAKE_PNG), width: 1024, height: 1024 },
    { error: "failed", detail: `OpenAI ${MODEL} error: prompt too long (gpt)` },
    { error: "declined", detail: `OpenAI safety system rejected the prompt for ${MODEL}` }
  ];
  const env = await start({
    env: {},
    pipelineDeps: {
      provider: { redraw: async () => draws.shift() },
      layoutCall: async () => ({ layout: GOOD_LAYOUT })
    }
  });
  try {
    const { code } = await env.upload();
    const done = await env.design(code, SETTINGS);
    assert.equal(done.status, "done");
    await env.call(`/api/attempts/${code}/${done.attempt}/tinted.png`);
    const ai = readFileSync(path.join(env.config.archiveDir, code, `attempt-${done.attempt}`, "ai.png"));
    assert.deepEqual(pngChunks(ai).map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    env.problems.push(...scanFile("archive ai.png", ai));

    const failed = await env.design(code, SETTINGS);
    assert.deepEqual([failed.status, failed.error], ["failed", "failed"]);
    const declined = await env.design(code, SETTINGS);
    assert.deepEqual([declined.status, declined.error], ["declined", "declined"]);
    await env.json(`/api/codes/${code}`);
    assert.deepEqual(env.problems, []);
  } finally {
    await env.stop();
  }
});
