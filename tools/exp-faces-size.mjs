// Experiment exp-engine build 4 (docs/exp-engine.md, "Build 4"; tools only): feature designs by size
// (concept section 5, faces.js eyeDesign / mouthDesign) and bigger faces.
//
//   node tools/exp-faces-size.mjs hs [--dry] [NAME ...]   head-and-shoulders crops of the private photos
//                                                      with one face, one provider call each (IS_FAKE=0;
//                                                      --dry: the crops only, no call)
//   node tools/exp-faces-size.mjs private [NAME ...]   the private photos and their -hs crops (colour)
//   node tools/exp-faces-size.mjs public               the RS faces (rs-woman, rs-portrait, rs-einstein)
//   node tools/exp-faces-size.mjs page                 data/private-portraits/faces-size.html
//   node tools/exp-faces-size.mjs tables public|private   the results as markdown (stdout)
//
// hs: for every private photo whose prepared photo has exactly one landmark face, the prepared photo
// is made again as the app makes it (decode to work.png, background removal on the strass service,
// the default adjustments; spec 6.1-6.3), and a head-and-shoulders crop of it taken: the face (the
// Face Mesh's widest points, 234 and 454) HS_FACE_SHARE of the crop's width, centred; the top
// HS_HAIR face heights above the forehead (landmark 10); the crop HS_ASPECT times as high as wide,
// so the shoulders are in; beyond the photo transparent. The crop then goes through the production
// pipeline in colour (spec 7.1-7.5: model input, provider, layout, natural size, acceptance): one
// provider call per photo, no retry (a second call is refused before it leaves), no automatic re-run.
// A photo whose -hs AI image exists is never sent again. Files: data/private-portraits/OpenAI/
// <name>-hs-prepared.png, -hs-input.png, -hs.png (the AI image, without metadata), -hs-layout.json,
// -hs-reply.json (status, time, acceptance; no key, no prompt).
//
// Designs: per photo today and the engine with size-based faces (landmarks as exp-engine.mjs finds
// them), checks 1-5; pictures original | AI image | today | engine, then per face the eyes and the
// mouth (prepared photo | AI | today | engine). Private pictures and the page stay under
// data/private-portraits/ (faces-size/, faces-size.html); public ones in docs/exp-engine/b4/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { engineLayout, todaysDesign } from "../src/engine/index.js";
import { runChecks } from "../src/engine/checks.js";
import { eyeDesign, mouthDesign } from "../src/engine/faces.js";
import { acceptLayout, modelInput } from "../src/pipeline/design.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { callLayoutService } from "../src/pipeline/layout.js";
import { createProvider } from "../src/pipeline/provider.js";
import { DEFAULT_SETTINGS } from "../src/prep/adjust.js";
import { callRemoveBackground } from "../src/prep/background.js";
import { decodeToWork } from "../src/prep/decode.js";
import { SIGNATURE_BYTES, detectFormat } from "../src/prep/formats.js";
import { aiImageForArchive } from "../src/prep/pngmeta.js";
import { preparePng } from "../src/prep/prepare.js";
import { loadConfig } from "../src/server/config.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { strip } from "./exp-holes.mjs";
import {
  facesOf, landmarkJobs, landmarks, layoutMm, layoutOf, panels, photoReader, privateDesigns, publicDesigns, rgba, viewAround
} from "./exp-engine.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const R = (...p) => path.join(ROOT, ...p);
const PRIVATE = R("data/private-portraits");
const OPENAI = path.join(PRIVATE, "OpenAI");
const HS_FACE_SHARE = 0.45;
const HS_HAIR = 0.5;
const HS_ASPECT = 1.3;
const WHOLE_H = 460;
const CLOSE_H = 230;
const PUBLIC_FACES = Object.freeze(["rs-woman", "rs-portrait", "rs-einstein"]);
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (v, k = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** k) / 10 ** k);

// --- hs: head-and-shoulders crops through the production pipeline --------------------------------

// The photo's prepared image as the app makes it (spec 6.1-6.3, default adjustments).
async function preparedOf(original, serviceUrl) {
  const buffer = readFileSync(original);
  const format = detectFormat(buffer.subarray(0, SIGNATURE_BYTES));
  const { png: work } = await decodeToWork(buffer, format);
  const cutout = await callRemoveBackground(work, { serviceUrl, fetch: globalThis.fetch });
  return preparePng(cutout, DEFAULT_SETTINGS);
}

// The crop box (px of the prepared image) around a face's 478 landmarks.
function hsBox(face) {
  const a = face[234], b = face[454];
  const faceW = dist(a, b), faceH = dist(face[10], face[152]);
  const w = faceW / HS_FACE_SHARE, h = HS_ASPECT * w;
  const cx = (a[0] + b[0]) / 2;
  const top = face[10][1] - HS_HAIR * faceH;
  return { left: Math.round(cx - w / 2), top: Math.round(top), width: Math.round(w), height: Math.round(h), faceW: round(faceW, 1) };
}

async function cropWithPadding(png, box) {
  const { width, height } = await sharp(png).metadata();
  const inside = { left: Math.max(0, box.left), top: Math.max(0, box.top) };
  inside.width = Math.min(width, box.left + box.width) - inside.left;
  inside.height = Math.min(height, box.top + box.height) - inside.top;
  return sharp(png).ensureAlpha().extract(inside).extend({
    left: inside.left - box.left, top: inside.top - box.top,
    right: box.left + box.width - inside.left - inside.width, bottom: box.top + box.height - inside.top - inside.height,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }).png().toBuffer();
}

// The private photos with one main face: one landmark face in the prepared photo (the model input
// of the earlier runs, exp-faces' cached landmarks).
function oneFacePhotos() {
  const marks = readJson(R("data/private-portraits/faces/landmarks.json"));
  const seen = new Set();
  return privateDesigns().filter((d) => {
    if (d.style !== "colour" || seen.has(d.base)) return false;
    seen.add(d.base);
    return marks[`${d.base}:input`]?.faces.length === 1;
  });
}

// dry: the crops and model inputs only, no provider call.
async function hs(only, dry = false) {
  const config = loadConfig(process.env);
  if (!dry && config.fake) throw new Error("hs makes provider calls: run with IS_FAKE=0.");
  if (!dry && !config.provider.apiKey) throw new Error("No provider key in the environment.");
  const photos = oneFacePhotos().filter((d) => !only.length || only.includes(d.base));
  const marksFile = path.join(PRIVATE, "faces-size", "landmarks.json");
  mkdirSync(path.dirname(marksFile), { recursive: true });
  let calls = 0;
  for (const photo of photos) {
    const name = `${photo.base}-hs`;
    const file = (suffix) => path.join(OPENAI, `${name}${suffix}`);
    if (existsSync(file(".png"))) { console.log(`${name}: AI image exists, no call`); continue; }
    // 1. The prepared photo and its face.
    const prepared = existsSync(path.join(PRIVATE, "faces-size", `${photo.base}-prepared.png`))
      ? readFileSync(path.join(PRIVATE, "faces-size", `${photo.base}-prepared.png`))
      : await preparedOf(photo.original, config.strassServiceUrl);
    writeFileSync(path.join(PRIVATE, "faces-size", `${photo.base}-prepared.png`), prepared);
    const id = `${photo.base}:prepared`;
    const marks = landmarks(marksFile, [{ id, path: path.join(PRIVATE, "faces-size", `${photo.base}-prepared.png`), blurPx: 0 }]);
    const faces = marks[id].faces;
    if (faces.length !== 1) { console.log(`${name}: ${faces.length} faces in the prepared photo, skipped`); continue; }
    // 2. The crop and the model input (7.1, background removal on).
    const box = hsBox(faces[0]);
    const crop = await cropWithPadding(prepared, box);
    writeFileSync(file("-prepared.png"), crop);
    const input = await modelInput(crop, { cropToSubject: true });
    writeFileSync(file("-input.png"), input);
    if (dry) { console.log(`${name}: face ${box.faceW} px wide, crop ${box.width} x ${box.height} (dry run, no call)`); continue; }
    // 3. One provider call, no retry.
    let sent = 0;
    const once = (url, init) => {
      if (sent++) return Promise.reject(new Error("no retries in this experiment"));
      calls++;
      return globalThis.fetch(url, init);
    };
    const provider = createProvider({ settings: config.provider, fetch: once });
    const t0 = Date.now();
    const drawn = await provider.redraw(input, { mode: "colour", bwStyle: config.bwStyle });
    const reply = { name, box, calls: Math.min(sent, 1), ms: Date.now() - t0, outcome: drawn?.error ? { ok: false, error: drawn.error, detail: drawn.detail } : { ok: true, width: drawn.width, height: drawn.height } };
    if (drawn?.error) { writeJson(file("-reply.json"), reply); console.log(`${name}: provider ${drawn.error} (${drawn.detail})`); continue; }
    const ai = await aiImageForArchive(drawn.png);
    writeFileSync(file(".png"), ai);
    // 4. Layout (7.4), natural size and acceptance (7.5); no automatic re-run.
    const placed = await callLayoutService({
      fetch: globalThis.fetch, timers: { setTimeout, clearTimeout }, url: config.strassServiceUrl, timeoutMs: config.layoutTimeoutMs,
      pngBuffer: ai, colorIds: Object.keys(STONE_COLORS), signal: new AbortController().signal
    });
    if (!placed.layout) { reply.layout = { error: placed.error?.code ?? "failed" }; writeJson(file("-reply.json"), reply); console.log(`${name}: layout failed`); continue; }
    writeFileSync(file("-layout.json"), `${JSON.stringify(placed.layout)}\n`);
    const natural = cleanedLayout(placed.layout, { fillHolesIn: await rgba(file(".png")) });
    const check = acceptLayout(natural);
    reply.accepted = { ok: check.ok, stones: natural.stoneLayout.stones.length, removedShare: round(natural.removedShare, 4), coverage: round(check.coverage, 3) };
    writeJson(file("-reply.json"), reply);
    console.log(`${name}: face ${box.faceW} px wide, crop ${box.width} x ${box.height}; AI ${drawn.width} x ${drawn.height}; ${reply.accepted.stones} stones, accepted ${check.ok}`);
  }
  console.log(`provider calls: ${calls}`);
}

// --- Designs -------------------------------------------------------------------------------------

function designsOf(which) {
  if (which === "public") return publicDesigns().filter((d) => PUBLIC_FACES.includes(d.name));
  const list = privateDesigns().filter((d) => d.style === "colour");
  for (const d of oneFacePhotos()) {
    const name = `${d.base}-hs`, file = (suffix) => path.join(OPENAI, `${name}${suffix}`);
    if (!existsSync(file("-layout.json"))) continue;
    list.splice(list.indexOf(list.find((x) => x.base === d.base)) + 1, 0, {
      name: `${name}-colour`, base: name, set: "private", style: "colour", original: d.original, crop: file("-prepared.png"), input: file("-input.png"), ai: file(".png"), layout: file("-layout.json")
    });
  }
  return list;
}

function eyeViews(face) {
  const m = face.ipd;
  return {
    eyes: viewAround(face.eyes.flatMap((e) => e.opening), 0.3 * m, 2.6),
    mouth: viewAround(face.lips.outer, 0.28 * m, 1.8)
  };
}

// What each face's features got: per eye its width and design, the mouth's width and design (and the
// hair share over the lips), and what was built.
function facesReport(engine) {
  return engine.map.faces.map((face, fi) => {
    const f = engine.stats.faces[fi];
    return {
      ipdMm: round(face.ipd, 1),
      eyes: face.eyes.map((e, k) => ({ widthMm: round(e.widthMm, 1), heightMm: round(e.heightMm, 1), design: eyeDesign(face), built: f.eyes[k] })),
      mouth: { widthMm: round(face.lips.widthMm, 1), design: mouthDesign(face), open: face.lips.open, hair: face.lips.hair, built: f.mouth },
      kept: f.kept
    };
  });
}

async function runOne(design, out, marksFile) {
  const ai = await rgba(design.ai);
  const layout = await layoutOf(design);
  const report = layout.report;
  const marks = landmarks(marksFile, landmarkJobs(design, report));
  const { faces, info } = facesOf(design, report, marks);
  const photoLab = design.input ? photoReader(await rgba(design.input), ai, report) : null;
  const today = todaysDesign(layout, ai, { mode: "colour" });
  const t0 = performance.now();
  const engine = engineLayout(layout, ai, { mode: "colour", today: today.stones, faces, photoLab });
  const ms = Math.round(performance.now() - t0);
  const checks = { today: runChecks(today.stones, engine.map), engine: runChecks(engine.stones, engine.map, { chains: engine.chains }) };
  for (const c of Object.values(checks)) c.holes.at = c.holes.at.length;
  const result = {
    name: design.name, base: design.base ?? design.name, hs: /-hs$/.test(design.base ?? ""), faces: { count: faces.length, ...info },
    today: { stones: today.stones.length, checks: checks.today }, engine: { stones: engine.stones.length, ms, checks: checks.engine },
    features: facesReport(engine)
  };
  if (design.base && /-hs$/.test(design.base)) {
    const reply = path.join(OPENAI, `${design.base}-reply.json`);
    if (existsSync(reply)) result.provider = readJson(reply);
  }
  // Pictures.
  const views = [["today", today.stones], ["engine, faces by size", engine.stones]];
  const all = layoutMm(today.stones).getBoundingBox();
  const wholeView = { x0: all.minXmm - 2, y0: all.minYmm - 2, w: all.widthMm + 4, h: all.heightMm + 4 };
  const wholePanels = [];
  const first = design.crop ?? design.original;
  if (first) wholePanels.push({ label: design.crop ? "head-and-shoulders crop" : "original", png: await sharp(first).rotate().flatten({ background: "#ffffff" }).png().toBuffer() });
  wholePanels.push(...(await panels({ ...design, input: null }, ai, report, wholeView, WHOLE_H, views)).map((p, i) => (i ? { ...p, label: `${p.label}: ${[today, engine][i - 1].stones.length} stones` } : p)));
  const rows = [await strip(null, wholePanels, WHOLE_H)];
  for (const [fi, face] of engine.map.faces.entries()) {
    const fr = result.features[fi];
    for (const [tag, view] of Object.entries(eyeViews(face))) {
      const ps = await panels(design, ai, report, view, CLOSE_H, views);
      const what = tag === "eyes" ? `eyes ${fr.eyes.map((e) => e.widthMm).join(" + ")} mm: ${fr.eyes[0].design}` : `mouth ${fr.mouth.widthMm} mm: ${fr.mouth.design}`;
      ps[0].label = `face ${fi + 1} ${what}: ${ps[0].label}`;
      rows.push(await strip(null, ps, CLOSE_H));
    }
  }
  const metas = await Promise.all(rows.map((r) => sharp(r).metadata()));
  const W = Math.max(...metas.map((m) => m.width)), H = metas.reduce((s, m) => s + m.height, 0);
  let y = 0;
  const comp = rows.map((r, i) => { const c = { input: r, left: 0, top: y }; y += metas[i].height; return c; });
  await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(comp).jpeg({ quality: 80 }).toFile(path.join(out.pics, `${design.name}.jpg`));
  result.picture = `${design.name}.jpg`;
  return result;
}

// --- Tables --------------------------------------------------------------------------------------

const yes = (v) => (v ? "yes" : "no");
const eyeCell = (e) => `${e.design}: ${e.design === "kept" ? "" : `outline ${yes(e.outline)} (${e.upper}/${e.lower}) · white ${e.whites} · `}pupil ${e.pupil ? e.pupilD : "no"}${e.design === "full" ? ` · catch-light ${yes(e.catchLight)}` : ""} → ${e.pass ? "ok" : "**fail**"}`;
const lipCell = (l) => `${l.design}: outline ${yes(l.outline)} (${l.outlineShare}) · mouth line ${yes(l.mouthLine)} (${l.mouthLineShare}) → ${l.pass ? "ok" : "**fail**"}`;

// Per face: each eye's and the mouth's width and design, and check 5 for today and the engine.
export function faceTable(results) {
  const lines = [
    "| Design | Face | Eyes: width mm (design) | Mouth: width mm (design; hair over the lips) | Who | Check 5 | Eyes (left — right) | Lips |",
    "| --- | ---: | --- | --- | --- | --- | --- | --- |"
  ];
  for (const r of results) {
    r.features.forEach((f, fi) => {
      for (const [n, who] of ["today", "engine"].entries()) {
        const c = r[who].checks.faces?.[fi];
        if (!c) continue;
        const head = n ? "| | | | |" : `| ${fi ? "" : r.name} | ${fi + 1} | ${f.eyes.map((e) => e.widthMm).join(" · ")} (${f.eyes[0].design}) | ${f.mouth.widthMm} (${f.mouth.design}${f.mouth.hair?.share != null ? `; ${f.mouth.hair.share}` : ""}) |`;
        lines.push(`${head} ${who} | ${c.pass ? "**pass**" : "fail"} | ${c.eyes.map(eyeCell).join(" — ")} | ${lipCell(c.lips)} |`);
      }
    });
  }
  return lines.join("\n");
}

// Per design: checks 1-4 for today and the engine.
export function checkTable(results) {
  const lines = [
    "| Design | Who | Stones | 1 Gaps: viol. / min | 2 Lines clean · other colour · breaks | 3 Patches <4 | 4 Holes ≥1.4 mm | Faces passing check 5 |",
    "| --- | --- | ---: | --- | --- | ---: | ---: | --- |"
  ];
  for (const r of results) {
    for (const [n, who] of ["today", "engine"].entries()) {
      const c = r[who].checks;
      const f = c.faces ?? [];
      lines.push(`| ${n ? "" : r.name} | ${who} | ${r[who].stones} | ${c.gaps.violations} / ${c.gaps.minGapMm} | ${c.lines.clean}/${c.lines.lines} · ${c.lines.offColour} · ${c.lines.breaks} | ${c.areas.smallPatches} | ${c.holes.holes} | ${f.length ? `${f.filter((x) => x.pass).length}/${f.length}` : "–"} |`);
    }
  }
  return lines.join("\n");
}

// Design counts: eyes and mouths per design, faces passing check 5.
export function summaryTable(results) {
  const groups = [["photos", results.filter((r) => !r.hs)], ["-hs crops", results.filter((r) => r.hs)]].filter(([, l]) => l.length);
  const lines = [
    "| Set | Designs | Faces | Eyes: full · simple · kept | Mouths: full · simple · line · kept | Check 5 today | Check 5 engine |",
    "| --- | ---: | ---: | --- | --- | ---: | ---: |"
  ];
  for (const [label, list] of groups) {
    const faces = list.flatMap((r) => r.features);
    const eyes = faces.flatMap((f) => f.eyes);
    const n = (arr, v) => arr.filter((x) => x.design === v).length;
    const pass = (who) => list.flatMap((r) => r[who].checks.faces ?? []).filter((f) => f.pass).length;
    lines.push(`| ${label} | ${list.length} | ${faces.length} | ${n(eyes, "full")} · ${n(eyes, "simple")} · ${n(eyes, "kept")} | ${["full", "simple", "line", "kept"].map((v) => n(faces.map((f) => f.mouth), v)).join(" · ")} | ${pass("today")}/${faces.length} | ${pass("engine")}/${faces.length} |`);
  }
  return lines.join("\n");
}

// The -hs crops: the crop, the provider call and acceptance.
export function hsTable(results) {
  const lines = ["| Crop | Face px (crop px) | Provider calls | AI image px | Stones | Accepted (removed · coverage) |", "| --- | --- | ---: | --- | ---: | --- |"];
  for (const r of results.filter((x) => x.provider)) {
    const p = r.provider;
    lines.push(`| ${r.base} | ${p.box.faceW} (${p.box.width} × ${p.box.height}) | ${p.calls} | ${p.outcome.ok ? `${p.outcome.width} × ${p.outcome.height}` : p.outcome.error} | ${p.accepted?.stones ?? "–"} | ${p.accepted ? `${yes(p.accepted.ok)} (${p.accepted.removedShare} · ${p.accepted.coverage})` : "–"} |`);
  }
  return lines.join("\n");
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function page(results) {
  const md = (t) => esc(t).split("\n").filter((l) => !/^\| ---/.test(l)).map((l, i) => `<tr>${l.split("|").slice(1, -1).map((c) => (i ? `<td>${c.trim().replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</td>` : `<th>${c.trim()}</th>`)).join("")}</tr>`).join("\n");
  const designs = results.map((r) => `<section><h3>${esc(r.name)}</h3>
<p>${r.features.map((f, fi) => `face ${fi + 1}: eyes ${f.eyes.map((e) => `${e.widthMm} × ${e.heightMm} mm`).join(", ")} → ${f.eyes[0].design}; mouth ${f.mouth.widthMm} mm${f.mouth.open ? " (open)" : ""} → ${f.mouth.design}${f.mouth.hair?.share != null ? ` (hair over the lips ${f.mouth.hair.share})` : ""}`).join("<br>") || esc(JSON.stringify(r.faces))}</p>
<details><summary>features</summary><pre>${esc(JSON.stringify(r.features, null, 1))}</pre></details>
<img src="faces-size/${esc(r.picture)}" alt="${esc(r.name)}"></section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Faces by size (private)</title>
<style>body{font-family:Helvetica,Arial,sans-serif;margin:16px;color:#1d3557;background:#fff}table{border-collapse:collapse;font-size:12px;margin:8px 0 20px}td,th{border:1px solid #ccd;padding:3px 6px;text-align:left;vertical-align:top}th{background:#eef2fa}img{max-width:100%;display:block;margin:6px 0}section{border-top:1px solid #ccd;margin-top:18px}pre{font-size:11px;white-space:pre-wrap}</style></head><body>
<h1>Engine build 4: faces by size (private photos)</h1>
<p>Private: images, numbers and this page stay under data/private-portraits/. Method and the public faces: docs/exp-engine.md (build 4). Colour only. Each design: original (or the head-and-shoulders crop) | AI image | today | engine with size-based faces; then per face the eyes and the mouth (prepared photo | AI | today | engine). Eyes: full from 10 mm wide, simple from 6 mm, else the AI's stones kept (both eyes the smaller one's design); mouths: full from 14 mm, simple from 7 mm, else kept; the mouth line only where hair or a beard covers the lips.</p>
<h2>Summary</h2><table>${md(summaryTable(results))}</table>
<h2>Head-and-shoulders crops</h2><table>${md(hsTable(results))}</table>
<h2>Each face: sizes, designs and check 5</h2><table>${md(faceTable(results))}</table>
<h2>Checks 1-4</h2><table>${md(checkTable(results))}</table>
<h2>Designs</h2>${designs}</body></html>\n`;
}

async function main() {
  const [which, ...only] = process.argv.slice(2);
  if (which === "hs") return hs(only.filter((n) => n !== "--dry"), only.includes("--dry"));
  if (which === "tables") {
    const { results } = readJson(only[0] === "private" ? path.join(PRIVATE, "faces-size", "results.json") : R("docs/exp-engine/b4/results.json"));
    console.log(`${summaryTable(results)}\n\n${hsTable(results)}\n\n${faceTable(results)}\n\n${checkTable(results)}`);
    return;
  }
  if (which === "page") {
    writeFileSync(path.join(PRIVATE, "faces-size.html"), page(readJson(path.join(PRIVATE, "faces-size", "results.json")).results));
    return;
  }
  if (which !== "public" && which !== "private") throw new Error("Usage: node tools/exp-faces-size.mjs hs|private|public [NAME ...] | tables public|private | page");
  const out = which === "public"
    ? { pics: R("docs/exp-engine/b4"), results: R("docs/exp-engine/b4/results.json"), marks: R("data/exp-faces/landmarks.json") }
    : { pics: path.join(PRIVATE, "faces-size"), results: path.join(PRIVATE, "faces-size", "results.json"), marks: R("data/private-portraits/faces/landmarks.json") };
  mkdirSync(out.pics, { recursive: true });
  let designs = designsOf(which);
  if (only.length) designs = designs.filter((d) => only.includes(d.name) || only.includes(d.base));
  const previous = existsSync(out.results) ? readJson(out.results).results : [];
  const results = previous.filter((r) => !designs.some((d) => d.name === r.name));
  for (const design of designs) {
    const t = Date.now();
    const r = await runOne(design, out, out.marks);
    results.push(r);
    const f = (who) => (r[who].checks.faces ?? []).map((x) => (x.pass ? "pass" : "fail")).join(",");
    console.log(`${design.name}: ${r.features.map((x) => `eyes ${x.eyes.map((e) => e.widthMm).join("/")} ${x.eyes[0].design}, mouth ${x.mouth.widthMm} ${x.mouth.design}`).join(" | ")} | check 5 today [${f("today")}] engine [${f("engine")}] gaps ${r.engine.checks.gaps.violations} [${Date.now() - t} ms]`);
  }
  const order = designsOf(which).map((d) => d.name);
  results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  writeJson(out.results, { results });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
