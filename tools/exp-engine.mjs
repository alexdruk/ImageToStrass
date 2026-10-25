// Experiment exp-engine (docs/exp-engine.md; tools only): today's designs and the engine's
// (src/engine/, IS_ENGINE=concept) side by side, from saved AI images only (no provider calls), with
// the concept's checks 1-5 (src/engine/checks.js), time per design and stone counts.
//
//   node tools/exp-engine.mjs public              the 9 CC0 fixtures and the 12 RS images
//   node tools/exp-engine.mjs private             the private photos (colour, halftone, stencil)
//   node tools/exp-engine.mjs public NAME ...     only those designs
//   node tools/exp-engine.mjs tables public|private   the results as markdown tables (stdout)
//   node tools/exp-engine.mjs page                the private page data/private-portraits/engine.html
//
// Build 3: per design today, the engine without faces (faces keep today's stones, as build 2) and,
// where a design has landmark faces, the engine with faces (concept section 5, features.js). The
// faces' landmarks: MediaPipe Face Landmarker (services/strass/scripts/face_landmarks.py in its own
// venv, .venv-faces), found and matched as in exp-faces: the AI image blurred by BLUR_MM; with a
// prepared photo (private), the AI's faces matched to the photo's (iris centres within 0.6 eye
// distances; an AI face with no photo face is a false find, a photo face with no AI face is used as
// mapped); without one (RS), the AI's faces at STRICT_CONFIDENCE and at least STRICT_SIZE of the
// largest; CC0 photos have no human face. The landmarks cached by exp-faces are reused
// (data/exp-faces/landmarks.json, data/private-portraits/faces/landmarks.json); missing ones are
// found and added.
//
// Layouts: the saved /layout answers of exp-faces (data/exp-faces/layouts, and for the private photos
// the manifest data/private-portraits/faces/manifest.json); the three CC0 "norule" images had none,
// so the local strass service laid them out once (cached in data/exp-engine/layouts/).
//
// Pictures, per design: whole (original | AI image | today | engine without faces | engine with
// faces); per face the eyes, nose and mouth (prepared photo where there is one | AI | the three);
// for designs with strands (lines leaving the subject), the strand and the animal's face. Public:
// docs/exp-engine/b3/, maps in data/exp-engine/maps/. Private: data/private-portraits/engine/ and
// the page data/private-portraits/engine.html (never in docs/ or git).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { engineLayout, mapPicture, mapToJSON, todaysDesign } from "../src/engine/index.js";
import { HIST_BINS, emptyCircles, holeHistogram, runChecks } from "../src/engine/checks.js";
import { HOLE_LIMIT_MM } from "../src/engine/place.js";
import { boxOf } from "../src/engine/faces.js";
import { srgbToLab } from "../src/pipeline/holes.js";
import { callLayoutService } from "../src/pipeline/layout.js";
import { aiImageForArchive } from "../src/prep/pngmeta.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { aiPng, strip, tintedPng } from "./exp-holes.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const R = (...p) => path.join(ROOT, ...p);
const PY = R("services/strass/.venv-faces/bin/python");
const LANDMARKS = R("services/strass/scripts/face_landmarks.py");
const BLUR_MM = 0.6;
const STRICT_CONFIDENCE = 0.7;
const STRICT_SIZE = 0.6;
const WHOLE_H = 460;
const CLOSE_H = 230;
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const IOD = (f) => dist(f[468], f[473]);
const round = (v, k = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** k) / 10 ** k);

// The designs whose pictures build 3 shows (beside every private one): the RS faces and the cats and
// dogs (strands).
export const SHOWN = Object.freeze(["rs-woman", "rs-portrait", "rs-einstein", "rs-jesus", "cc0-cat-norule", "cc0-cat-rule", "cc0-dachshund-rule", "cc0-dog-norule", "cc0-dog-rule", "rs-cat", "rs-dog"]);

function publicDesigns() {
  const list = [];
  for (const n of ["car-rule", "cat-norule", "cat-rule", "dachshund-rule", "dog-norule", "dog-rule", "giraffe-rule", "mug-norule", "mug-rule"]) {
    const photo = n.split("-")[0];
    const saved = R("data/exp-faces/layouts", `cc0-${photo}-layout.json`);
    list.push({
      name: `cc0-${n}`, set: "CC0", style: "colour", original: R("services/strass/tests/fixtures/photos", `${photo}.jpg`), input: null,
      ai: R("tools/fixtures/is03b-ai", `${n}-output.png`), humanPhoto: false,
      layout: n.endsWith("-rule") && existsSync(saved) ? saved : R("data/exp-engine/layouts", `cc0-${n}-layout.json`)
    });
  }
  for (const n of ["cat", "dog", "einstein", "jesus", "lake", "leopard", "logo", "parrot", "portrait", "rose", "tulips", "woman"]) {
    list.push({ name: `rs-${n}`, set: "RS", style: "colour", original: null, input: null, ai: R("services/strass/prototype/img", `N2_${n}.png`), layout: R("data/exp-faces/layouts", `rs-${n}-layout.json`), markKey: `rs-${n}` });
  }
  return list;
}

function privateDesigns() {
  return readJson(R("data/private-portraits/faces/manifest.json")).map((e) => ({
    name: `${e.name}-${e.style}`, base: e.name, set: "private", style: e.style, original: e.original, input: e.input, ai: e.ai, layout: e.layout
  }));
}

async function rgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function layoutOf(design) {
  if (existsSync(design.layout)) return readJson(design.layout);
  const png = await aiImageForArchive(readFileSync(design.ai));
  const answer = await callLayoutService({
    fetch: globalThis.fetch, timers: { setTimeout, clearTimeout }, url: process.env.STRASS_SERVICE_URL || "http://127.0.0.1:8000",
    timeoutMs: 600000, pngBuffer: png, colorIds: Object.keys(STONE_COLORS), signal: new AbortController().signal
  });
  if (!answer.layout) throw new Error(`Layout for ${design.name} failed: ${JSON.stringify(answer.error)}`);
  mkdirSync(path.dirname(design.layout), { recursive: true });
  writeFileSync(design.layout, `${JSON.stringify(answer.layout)}\n`);
  return answer.layout;
}

// --- Landmarks -----------------------------------------------------------------------------------

// The landmark jobs a design needs: [{ id, path, blurPx, confidence? }].
function landmarkJobs(design, report) {
  if (design.humanPhoto === false) return [];
  const blurPx = BLUR_MM / (report.mmPerPx ?? 0.15);
  if (design.set === "private") {
    return [
      { id: `${design.base}:${design.style}:ai`, path: design.ai, blurPx },
      { id: `${design.base}:input`, path: design.input, blurPx: 0 },
      { id: `${design.base}:original`, path: design.original, blurPx: 0 }
    ];
  }
  return [{ id: `${design.markKey}:colour:ai-strict`, path: design.ai, blurPx, confidence: STRICT_CONFIDENCE }];
}

// Cached landmarks (exp-faces' file), with the missing jobs run and added.
function landmarks(file, jobs) {
  const have = existsSync(file) ? readJson(file) : {};
  const todo = [...new Map(jobs.filter((j) => !(j.id in have)).map((j) => [j.id, j])).values()];
  if (!todo.length) return have;
  if (!existsSync(PY)) throw new Error(`Landmarks needed for ${todo.map((j) => j.id).join(", ")}, but ${PY} is missing (exp-faces setup)`);
  const jobsFile = `${file}.jobs.json`, tmp = `${file}.new.json`;
  writeJson(jobsFile, todo);
  const r = spawnSync(PY, [LANDMARKS, jobsFile, tmp], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`landmarks failed: ${r.stderr.split("\n").filter((l) => !/^(W|I)0000|absl|WARNING/.test(l)).join("\n")}`);
  const all = { ...have, ...readJson(tmp) };
  writeJson(file, all);
  return all;
}

// The design's faces in layout mm (as exp-faces matchFaces): { faces: [points], info }.
function facesOf(design, report, marks) {
  const toMm = ([x, y]) => [(x - 0.5) * report.mmPerPx - report.offsetMm[0], (y - 0.5) * report.mmPerPx - report.offsetMm[1]];
  if (design.humanPhoto === false) return { faces: [], info: { why: "the photo has no human face" } };
  if (design.set !== "private") {
    const strict = marks[`${design.markKey}:colour:ai-strict`];
    const top = Math.max(0, ...(strict?.faces ?? []).map(IOD));
    const faces = (strict?.faces ?? []).filter((f) => IOD(f) >= STRICT_SIZE * top);
    return { faces: faces.map((f) => f.map(toMm)), info: { ai: faces.length, why: faces.length ? null : "no landmark face found in the AI image" } };
  }
  const ai = marks[`${design.base}:${design.style}:ai`], input = marks[`${design.base}:input`];
  const sx = ai.w / input.w, sy = ai.h / input.h;
  const photo = input.faces.map((f) => f.map(([x, y]) => [x * sx, y * sy]));
  const used = new Set();
  const out = [];
  let falseFinds = 0, fromPhoto = 0;
  for (const f of ai.faces) {
    let best = -1, bd = Infinity;
    photo.forEach((p, k) => {
      const d = (dist(f[468], p[468]) + dist(f[473], p[473])) / 2;
      if (!used.has(k) && d < bd) { bd = d; best = k; }
    });
    if (best < 0 || bd >= 0.6 * IOD(photo[best])) { falseFinds++; continue; }
    used.add(best);
    out.push(f.map(toMm));
  }
  photo.forEach((p, k) => { if (!used.has(k)) { out.push(p.map(toMm)); fromPhoto++; } });
  return { faces: out, info: { ai: ai.faces.length, photo: photo.length, falseFinds, fromPhoto, why: out.length ? null : "no landmark face" } };
}

// The prepared photo (the model input, the AI image's shape) as Lab at layout mm.
function photoReader(input, ai, report) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const fx = input.width / ai.width, fy = input.height / ai.height;
  return (x, y) => {
    const ax = (x + ox) / s, ay = (y + oy) / s;
    const ix = Math.round((ax + 0.5) * fx - 0.5), iy = Math.round((ay + 0.5) * fy - 0.5);
    if (ix < 0 || iy < 0 || ix >= input.width || iy >= input.height) return null;
    const p = (iy * input.width + ix) * 4;
    return input.data[p + 3] >= 128 ? srgbToLab(input.data[p], input.data[p + 1], input.data[p + 2]) : null;
  };
}

// --- Pictures ------------------------------------------------------------------------------------

const layoutMm = (stones) => new StoneLayout({
  layerId: "design", sourceMode: "is",
  stones: stones.map((s, index) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color, layerId: "design", index }))
});

async function photoPng(inputFile, ai, report, view, ppmm) {
  const meta = await sharp(inputFile).metadata();
  const fx = meta.width / ai.width, fy = meta.height / ai.height;
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const left = Math.round(((view.x0 + ox) / s) * fx), top = Math.round(((view.y0 + oy) / s) * fy);
  const W = Math.max(1, Math.round((view.w / s) * fx)), H = Math.max(1, Math.round((view.h / s) * fy));
  const padded = await sharp(inputFile).ensureAlpha().extend({ left: Math.max(0, -left), top: Math.max(0, -top), right: Math.max(0, left + W - meta.width), bottom: Math.max(0, top + H - meta.height), background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp(padded).extract({ left: Math.max(0, left), top: Math.max(0, top), width: W, height: H })
    .resize(Math.round(view.w * ppmm), Math.round(view.h * ppmm)).flatten({ background: "#ffffff" }).png().toBuffer();
}

function viewAround(pts, margin, aspect) {
  let { x0, x1, y0, y1 } = boxOf(pts, margin);
  const w = x1 - x0, h = y1 - y0;
  if (w / h < aspect) { const add = (h * aspect - w) / 2; x0 -= add; x1 += add; } else { const add = (w / aspect - h) / 2; y0 -= add; y1 += add; }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

function faceViews(face) {
  const m = face.ipd;
  return {
    eyes: viewAround(face.eyes.flatMap((e) => e.opening), 0.3 * m, 2.6),
    nose: viewAround([face.nose.bridge, face.nose.base, ...face.nose.alae], 0.22 * m, 1.1),
    mouth: viewAround(face.lips.outer, 0.28 * m, 1.8)
  };
}

// Panels of one view: photo (if any) | AI | each design.
async function panels(design, ai, report, view, height, designs) {
  const ppmm = height / view.h;
  const out = [];
  if (design.input) out.push({ label: "prepared photo", png: await photoPng(design.input, ai, report, view, ppmm) });
  out.push({ label: "AI image", png: await aiPng(design.ai, report, view, ppmm) });
  for (const [label, stones] of designs) out.push({ label, png: await tintedPng(layoutMm(stones), view, Math.max(14, ppmm), { bwGap: design.style === "colour" ? null : "crystal" }) });
  return out;
}

// The strand to show: the line chain with most stones in strands, at its stone nearest the body.
function strandView(engine) {
  const { map } = engine;
  let best = null;
  for (const ch of engine.chains) {
    if (ch.kind !== "line") continue;
    const inStrand = ch.stones.filter((i) => { const k = map.grid.at(engine.stones[i].x, engine.stones[i].y); return k >= 0 && map.protrusion[k]; });
    if (!inStrand.length || (best && inStrand.length <= best.n)) continue;
    const edge = ch.stones.map((i) => engine.stones[i]).sort((a, b) => {
      const da = map.bodyDist[map.grid.at(a.x, a.y)] ?? 9, db = map.bodyDist[map.grid.at(b.x, b.y)] ?? 9;
      return (da || 9) - (db || 9);
    })[0];
    best = { n: inStrand.length, x: edge.x, y: edge.y };
  }
  return best ? { x0: best.x - 14, y0: best.y - 10, w: 28, h: 20 } : null;
}

// --- One design ----------------------------------------------------------------------------------

const countBy = (stones, key) => stones.reduce((m, s) => { m[key(s)] = (m[key(s)] || 0) + 1; return m; }, {});

// Every face feature that could not be built, and why.
function notBuilt(engine) {
  const out = [];
  (engine.stats.faces ?? []).forEach((f, fi) => {
    f.eyes.forEach((e, k) => {
      const eye = `face ${fi + 1} ${k ? "right" : "left"} eye`;
      if (e.skipped) out.push(`${eye}: ${e.skipped}`);
      if (e.pupilMissing) out.push(`${eye} pupil: ${e.pupilMissing}`);
      if (!e.skipped && !e.upperLid) out.push(`${eye} upper lid: no room`);
      if (!e.skipped && !e.lowerLid) out.push(`${eye} lower lid: no room`);
      if (e.catchLightMissing) out.push(`${eye} catch-light: ${e.catchLightMissing}`);
      if (e.ringSkipped) out.push(`${eye} iris ring: ${e.ringSkipped}`);
      if (!e.skipped && e.white < 2) out.push(`${eye} white: room for ${e.white} stone${e.white === 1 ? "" : "s"} only (${e.widthMm} x ${e.heightMm} mm)`);
      if (e.lashes?.drawn && !e.lashes.stones) out.push(`${eye} lashes: ${e.lashes.why}`);
    });
    for (const n of f.nose.nostrils) if (!n.placed) out.push(`face ${fi + 1} ${n.side} nostril: ${n.why}`);
    if (!f.nose.shadow) out.push(`face ${fi + 1} nose shadow: ${f.nose.shadowWhy}`);
    if (!f.mouth.outline) out.push(`face ${fi + 1} lip outline: no room`);
    if (!f.mouth.line) out.push(`face ${fi + 1} mouth line: no room`);
    if (!f.mouth.upper) out.push(`face ${fi + 1} upper lip fill: no room (thin lip)`);
    if (!f.mouth.lower) out.push(`face ${fi + 1} lower lip fill: no room (thin lip)`);
  });
  for (const b of engine.map.browNotes ?? []) out.push(`face ${b.face + 1} ${b.eye ? "right" : "left"} brow: ${b.why}`);
  return out;
}

async function runOne(design, out, marksFile) {
  const ai = await rgba(design.ai);
  const layout = await layoutOf(design);
  const report = layout.report;
  const mode = design.style === "colour" ? "colour" : "bw";
  const style = design.style === "stencil" ? "stencil" : "halftone";
  const marks = landmarks(marksFile, landmarkJobs(design, report));
  const { faces, info: faceInfo } = facesOf(design, report, marks);
  const photoLab = design.input ? photoReader(await rgba(design.input), ai, report) : null;
  const t0 = performance.now();
  const today = todaysDesign(layout, ai, { mode });
  const t1 = performance.now();
  const noFaces = engineLayout(layout, ai, { mode, style, today: today.stones });
  const t2 = performance.now();
  const withFaces = faces.length ? engineLayout(layout, ai, { mode, style, today: today.stones, faces, photoLab }) : null;
  const t3 = performance.now();
  const engine = withFaces ?? noFaces;
  const map = engine.map;
  const checks = {
    today: runChecks(today.stones, map),
    noFaces: runChecks(noFaces.stones, map, { chains: noFaces.chains }),
    ...(withFaces ? { withFaces: runChecks(withFaces.stones, map, { chains: withFaces.chains }) } : {})
  };
  for (const c of Object.values(checks)) c.holes.at = c.holes.at.length;
  const box = (sl) => ({ widthMm: round(sl.widthMm, 1), heightMm: round(sl.heightMm, 1) });
  const entry = (e, ms) => ({
    stones: e.stones.length, ms: Math.round(ms), msParts: e.ms, size: box(e.stoneLayout), byRole: countBy(e.stones, (s) => s.role),
    holeStep: e.stats.holes, beforeHoleStep: holeHistogram(e.beforeHoles, map)
  });
  // The holes of check 4 left: how many have only stones that may not move on their rim (lines,
  // outline, brows, features), which the hole step cannot reach.
  const left = emptyCircles(engine.stones, map, HOLE_LIMIT_MM);
  const fixedOnly = left.filter(([x, y, d]) => !engine.stones.some((s) => ["area", "hex", "seam"].includes(s.role) && Math.hypot(s.x - x, s.y - y) - s.d / 2 < d / 2 + 0.15)).length;
  const result = {
    name: design.name, set: design.set, style: design.style,
    faces: { count: faces.length, ...faceInfo },
    holesLeft: { count: left.length, fixedOnly },
    map: { lines: map.lines.length, strands: map.strands, strandLines: engine.chains.filter((ch) => ch.kind === "line" && ch.stones.some((i) => { const k = map.grid.at(engine.stones[i].x, engine.stones[i].y); return k >= 0 && map.protrusion[k]; })).length, brows: map.brows.length, areas: map.areas.length, regions: map.regions.length },
    today: { stones: today.stones.length, ms: Math.round(t1 - t0), size: box(today.stoneLayout), checks: checks.today },
    noFaces: { ...entry(noFaces, t2 - t1), checks: checks.noFaces },
    ...(withFaces ? { withFaces: { ...entry(withFaces, t3 - t2), checks: checks.withFaces, features: withFaces.stats.faces, notBuilt: notBuilt(withFaces) } } : {})
  };

  writeFileSync(path.join(out.maps, `${design.name}-map.json`), `${JSON.stringify(mapToJSON(map))}\n`);
  writeFileSync(path.join(out.maps, `${design.name}-map.png`), mapPicture(map));
  if (!out.pictures(design)) return result;

  // Pictures.
  const views = [["today", today.stones], ["engine without faces", noFaces.stones], ...(withFaces ? [["engine with faces", withFaces.stones]] : [])];
  const all = layoutMm(today.stones).getBoundingBox();
  const wholeView = { x0: all.minXmm - 2, y0: all.minYmm - 2, w: all.widthMm + 4, h: all.heightMm + 4 };
  const wholePanels = [];
  if (design.original) wholePanels.push({ label: "original", png: await sharp(design.original).rotate().flatten({ background: "#ffffff" }).png().toBuffer() });
  wholePanels.push(...(await panels({ ...design, input: null }, ai, report, wholeView, WHOLE_H, views)).map((p, i) => (i ? { ...p, label: `${p.label}: ${[today, noFaces, withFaces][i - 1]?.stones.length} stones` } : p)));
  const rows = [await strip(null, wholePanels, WHOLE_H)];
  for (const [fi, face] of (withFaces ? withFaces.map.faces : []).entries()) {
    for (const [tag, view] of Object.entries(faceViews(face))) {
      const ps = await panels(design, ai, report, view, CLOSE_H, views);
      ps[0].label = `face ${fi + 1} ${tag}: ${ps[0].label}`;
      rows.push(await strip(null, ps, CLOSE_H));
    }
  }
  const strand = strandView(engine);
  if (strand) {
    const ps = await panels(design, ai, report, strand, CLOSE_H, views);
    ps[0].label = `strand: ${ps[0].label}`;
    rows.push(await strip(null, ps, CLOSE_H));
  }
  // An animal's face (the service's pupils): the cats' whiskers.
  const pupils = report.pupilsAtMm ?? [];
  if (!faces.length && pupils.length === 2) {
    const ipd = dist(pupils[0], pupils[1]);
    const cx = (pupils[0][0] + pupils[1][0]) / 2, cy = (pupils[0][1] + pupils[1][1]) / 2 + 0.6 * ipd;
    const view = { x0: cx - 1.6 * ipd, y0: cy - 1.25 * ipd, w: 3.2 * ipd, h: 2.5 * ipd };
    const ps = await panels(design, ai, report, view, 2 * CLOSE_H, views);
    ps[0].label = `face: ${ps[0].label}`;
    rows.push(await strip(null, ps, 2 * CLOSE_H));
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

const WHO = [["today", "today"], ["noFaces", "engine, no faces"], ["withFaces", "engine, faces"]];
const fmt = (c) => [
  `${c.gaps.violations} / ${c.gaps.minGapMm}`,
  `${c.lines.clean}/${c.lines.lines} · ${c.lines.offColour} · ${c.lines.offSize} · ${c.lines.breaks} · ${c.lines.missing}`,
  `${c.areas.overTones} (${c.areas.maxTones}) · ${c.areas.smallPatches}${c.areas.halftonePatches ? ` (+${c.areas.halftonePatches} ht)` : ""}`,
  `${c.holes.holes} / ${c.holes.largestMm}`,
  c.holes.histogram.join(" · ")
];

export function tableRows(results) {
  const lines = [
    "| Design | | Stones | ms | Size mm | 1 Gaps: viol. / min | 2 Lines: clean · other colour · other size · breaks · missing | 3 Areas: >3 tones (max) · patches <4 | 4 Holes ≥1.4 mm / largest | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm | Before the hole step: 0.6 · … · 1.4+ |",
    "| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const r of results) {
    WHO.forEach(([key, who], n) => {
      const d = r[key];
      if (!d) return;
      lines.push(`| ${n ? "" : r.name} | ${who} | ${d.stones} | ${d.ms} | ${d.size.widthMm} × ${d.size.heightMm} | ${fmt(d.checks).join(" | ")} | ${d.beforeHoleStep ? d.beforeHoleStep.join(" · ") : ""} |`);
    });
  }
  return lines.join("\n");
}

const yes = (v) => (v ? "yes" : "no");
// Check 5 per face: one row per face and design.
export function faceRows(results) {
  const lines = [
    "| Design | Face | Who | Pass | Eyes (left · right): outline (upper/lower cover) · white · pupil (SS mm, share of iris width) · catch-light | Same side | Lips: outline · mouth line |",
    "| --- | ---: | --- | --- | --- | --- | --- |"
  ];
  for (const r of results) {
    if (!r.withFaces) continue;
    r.withFaces.checks.faces.forEach((_, fi) => {
      WHO.forEach(([key, who], n) => {
        const f = r[key].checks.faces?.[fi];
        if (!f) return;
        const eyes = f.eyes.map((e) => `${yes(e.outline)} (${e.upper}/${e.lower}) · ${yes(e.white)} · ${e.pupil ? `${e.pupilD} (${e.pupilShare})` : "no"} · ${yes(e.catchLight)}`).join(" — ");
        lines.push(`| ${n || fi ? "" : r.name} | ${n ? "" : fi + 1} | ${who} | ${f.pass ? "**pass**" : "fail"} | ${eyes} | ${f.sameSide == null ? "–" : yes(f.sameSide)} | ${yes(f.lips.outline)} (${f.lips.outlineShare}) · ${yes(f.lips.mouthLine)} (${f.lips.mouthLineShare}) |`);
      });
    });
  }
  return lines.join("\n");
}

export function summary(results) {
  const out = {};
  for (const [key] of WHO) {
    const list = results.map((r) => r[key] ?? (key === "withFaces" ? r.noFaces : null)).filter(Boolean);
    const sum = (f) => list.reduce((s, d) => s + f(d), 0);
    const faces = results.flatMap((r) => (r.withFaces ? r[key]?.checks.faces ?? [] : []));
    out[key] = {
      designs: list.length,
      gapPass: list.filter((d) => d.checks.gaps.pass).length,
      lines: sum((d) => d.checks.lines.lines), cleanLines: sum((d) => d.checks.lines.clean), offColour: sum((d) => d.checks.lines.offColour),
      breaks: sum((d) => d.checks.lines.breaks), missing: sum((d) => d.checks.lines.missing),
      overTones: sum((d) => d.checks.areas.overTones), smallPatches: sum((d) => d.checks.areas.smallPatches),
      holes: sum((d) => d.checks.holes.holes), holePass: list.filter((d) => d.checks.holes.pass).length,
      largestHole: Math.max(...list.map((d) => d.checks.holes.largestMm)),
      histogram: HIST_BINS.map((_, i) => sum((d) => d.checks.holes.histogram[i])),
      ...(key !== "today" ? { beforeHoleStep: HIST_BINS.map((_, i) => sum((d) => d.beforeHoleStep[i])) } : {}),
      faces: faces.length, facePass: faces.filter((f) => f.pass).length,
      eyes: faces.reduce((s, f) => s + f.eyes.length, 0),
      eyeOutline: faces.reduce((s, f) => s + f.eyes.filter((e) => e.outline).length, 0),
      eyeWhite: faces.reduce((s, f) => s + f.eyes.filter((e) => e.white).length, 0),
      eyePupil: faces.reduce((s, f) => s + f.eyes.filter((e) => e.pupil).length, 0),
      eyeCatch: faces.reduce((s, f) => s + f.eyes.filter((e) => e.catchLight).length, 0),
      sameSide: faces.filter((f) => f.sameSide).length,
      lipOutline: faces.filter((f) => f.lips.outline).length, mouthLine: faces.filter((f) => f.lips.mouthLine).length,
      stones: sum((d) => d.stones), ms: sum((d) => d.ms), maxMs: Math.max(...list.map((d) => d.ms))
    };
  }
  return out;
}

function bySet(results) {
  const groups = new Map();
  for (const r of results) {
    const key = r.set === "private" ? r.style : r.set;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

export function summaryTable(results) {
  const lines = [
    "| Set | Designs | Who | Gap pass | Clean lines | Other colour | Breaks | Missing | Patches <4 | Holes ≥1.4 mm (designs passing) | Holes 0.6 · 0.8 · 1.0 · 1.2 · 1.4+ mm | Before the hole step | Faces passing check 5 | Eyes: outline · white · pupil · catch-light (of) | Same side | Lips: outline · mouth line | ms mean / max |",
    "| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | ---: | --- | --- |"
  ];
  for (const [key, list] of bySet(results)) {
    const s = summary(list);
    WHO.forEach(([k, who], n) => {
      const v = s[k];
      lines.push(`| ${n ? "" : key} | ${n ? "" : v.designs} | ${who} | ${v.gapPass}/${v.designs} | ${v.cleanLines}/${v.lines} | ${v.offColour} | ${v.breaks} | ${v.missing} | ${v.smallPatches} | ${v.holes} (${v.holePass}) | ${v.histogram.join(" · ")} | ${v.beforeHoleStep ? v.beforeHoleStep.join(" · ") : ""} | ${v.faces ? `${v.facePass}/${v.faces}` : "–"} | ${v.eyes ? `${v.eyeOutline} · ${v.eyeWhite} · ${v.eyePupil} · ${v.eyeCatch} (${v.eyes})` : "–"} | ${v.faces ? v.sameSide : "–"} | ${v.faces ? `${v.lipOutline} · ${v.mouthLine}` : "–"} | ${Math.round(v.ms / v.designs)} / ${v.maxMs} |`);
    });
  }
  return lines.join("\n");
}

// The not-built list of a result, with the eye-white note derived from its features (results
// written before that note existed).
function notBuiltOf(r) {
  const list = [...r.withFaces.notBuilt];
  r.withFaces.features.forEach((f, fi) => f.eyes.forEach((e, k) => {
    const eye = `face ${fi + 1} ${k ? "right" : "left"} eye`;
    if (!e.skipped && e.white < 2 && !list.some((l) => l.startsWith(`${eye} white`))) list.push(`${eye} white: room for ${e.white} stone${e.white === 1 ? "" : "s"} only (${e.widthMm} x ${e.heightMm} mm)`);
  }));
  return list.filter((l) => !/white: no room$/.test(l) || !list.some((m) => m !== l && m.startsWith(l.replace(/: no room$/, ": room"))));
}

export function notBuiltList(results) {
  const lines = [];
  for (const r of results) {
    if (r.faces.count === 0 && SHOWN.includes(r.name) && r.faces.why && r.set !== "CC0") lines.push(`- **${r.name}**: no features built: ${r.faces.why}.`);
    if (!r.withFaces) continue;
    const list = notBuiltOf(r);
    lines.push(`- **${r.name}** (${r.faces.count} face${r.faces.count === 1 ? "" : "s"}): ${list.length ? list.join("; ") : "every feature built"}.`);
  }
  return lines.join("\n");
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function page(results) {
  const md = (t) => esc(t).split("\n").filter((l) => !/^\| ---/.test(l)).map((l, i) => `<tr>${l.split("|").slice(1, -1).map((c) => (i ? `<td>${c.trim().replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</td>` : `<th>${c.trim()}</th>`)).join("")}</tr>`).join("\n");
  const designs = results.map((r) => `<section><h3>${esc(r.name)}</h3>
<p>faces: ${r.faces.count} (${esc(JSON.stringify(r.faces))}) · strands ${r.map.strands}, strand lines ${r.map.strandLines} · today ${r.today.stones} stones · without faces ${r.noFaces.stones}, ${r.noFaces.ms} ms${r.withFaces ? ` · with faces ${r.withFaces.stones}, ${r.withFaces.ms} ms` : ""} · hole step ${esc(JSON.stringify((r.withFaces ?? r.noFaces).holeStep))}</p>
${r.withFaces ? `<p>Not built: ${esc(notBuiltOf(r).join("; ") || "none")}</p><details><summary>features</summary><pre>${esc(JSON.stringify(r.withFaces.features, null, 1))}</pre></details>` : ""}
${r.picture ? `<img src="engine/${esc(r.picture)}" alt="${esc(r.name)}">` : ""}</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Engine build 3 (private)</title>
<style>body{font-family:Helvetica,Arial,sans-serif;margin:16px;color:#1d3557;background:#fff}table{border-collapse:collapse;font-size:12px;margin:8px 0 20px}td,th{border:1px solid #ccd;padding:3px 6px;text-align:right}th{background:#eef2fa}td:first-child,th:first-child{text-align:left}img{max-width:100%;display:block;margin:6px 0}section{border-top:1px solid #ccd;margin-top:18px}pre{font-size:11px;white-space:pre-wrap}</style></head><body>
<h1>Engine build 3: faces, holes, strands (private photos)</h1>
<p>Private: images, numbers and this page stay under data/private-portraits/. Method and the public results: docs/exp-engine.md (build 3). Each design: original | AI image | today | engine without faces (today's eye and mouth stones kept, as build 2) | engine with faces (concept section 5 from landmarks); then per face the eyes, nose and mouth (prepared photo | AI | the three). Check 4 counts holes of 1.4 mm or more.</p>
<h2>Summary by style</h2><table>${md(summaryTable(results))}</table>
<h2>Check 5 per face</h2><table>${md(faceRows(results))}</table>
<h2>Features that could not be built</h2><ul>${notBuiltList(results).split("\n").filter(Boolean).map((l) => `<li>${esc(l.slice(2)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</li>`).join("")}</ul>
<h2>Checks 1-4 per design</h2><table>${md(tableRows(results))}</table>
<h2>Designs</h2>${designs}</body></html>\n`;
}

async function main() {
  const [which, ...only] = process.argv.slice(2);
  if (which === "tables") {
    const file = only[0] === "private" ? R("data/private-portraits/engine/results.json") : R("docs/exp-engine/results.json");
    const { results } = readJson(file);
    console.log(`${summaryTable(results)}\n\n${faceRows(results)}\n\n${notBuiltList(results)}\n\n${tableRows(results)}`);
    return;
  }
  if (which === "page") {
    const { results } = readJson(R("data/private-portraits/engine/results.json"));
    writeFileSync(R("data/private-portraits/engine.html"), page(results));
    return;
  }
  if (which !== "public" && which !== "private") throw new Error("Usage: node tools/exp-engine.mjs public|private [NAME ...] | tables public|private | page");
  const out = which === "public"
    ? { pics: R("docs/exp-engine/b3"), maps: R("data/exp-engine/maps"), results: R("docs/exp-engine/results.json"), marks: R("data/exp-faces/landmarks.json"), pictures: (d) => SHOWN.includes(d.name) }
    : { pics: R("data/private-portraits/engine"), maps: R("data/private-portraits/engine/maps"), results: R("data/private-portraits/engine/results.json"), marks: R("data/private-portraits/faces/landmarks.json"), pictures: () => true };
  for (const d of [out.pics, out.maps]) mkdirSync(d, { recursive: true });
  let designs = which === "public" ? publicDesigns() : privateDesigns();
  if (only.length) designs = designs.filter((d) => only.includes(d.name));
  const previous = existsSync(out.results) ? readJson(out.results).results.filter((r) => r.noFaces) : [];
  const results = previous.filter((r) => !designs.some((d) => d.name === r.name));
  for (const design of designs) {
    const t = Date.now();
    const r = await runOne(design, out, out.marks);
    results.push(r);
    const e = (r.withFaces ?? r.noFaces).checks, d = r.today.checks;
    const f = r.withFaces ? r.withFaces.checks.faces.map((x) => (x.pass ? "pass" : "fail")).join(",") : "-";
    console.log(`${design.name}: faces ${r.faces.count} [${f}] | today holes ${d.holes.holes} | engine ${(r.withFaces ?? r.noFaces).stones} gaps ${e.gaps.violations} holes ${e.holes.holes} (before step ${(r.withFaces ?? r.noFaces).beforeHoleStep[4]}) lines ${e.lines.clean}/${e.lines.lines} strands ${r.map.strands}/${r.map.strandLines} [${Date.now() - t} ms]`);
  }
  const order = (which === "public" ? publicDesigns() : privateDesigns()).map((d) => d.name);
  results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  writeFileSync(out.results, `${JSON.stringify({ summary: summary(results), results }, null, 1)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
