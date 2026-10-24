// Experiment exp-faces (docs/exp-faces.md; tools only, never used by the app). Better eyes, lips
// and teeth on human faces with one face-feature module (src/pipeline/faces.js) for the three
// styles. No provider calls: saved AI images only.
//
//   node tools/exp-faces.mjs private   data/private-portraits  (Alex's photos; output stays there)
//   node tools/exp-faces.mjs public    data/exp-faces          (CC0 and RS images, colour only;
//                                                              pictures copied to docs/exp-faces/)
//
// Steps, each cached in WORK (a step already done is not repeated):
//   1. layouts    the strass /layout of every saved AI image that has no layout with discsAtMm
//                 (STRASS_SERVICE_URL; no provider call).
//   2. landmarks  MediaPipe Face Landmarker (services/strass/scripts/face_landmarks.py, its own
//                 venv) on the original photo, the prepared photo (the model input) and the AI
//                 image composited on white and blurred by BLUR_MM, so the stones merge.
//   3. faces      per design: the AI's faces matched to the prepared photo's, mapped into the AI
//                 image's frame (the model input has the AI image's shape); which works, and how
//                 far apart they are; how the AI drew each feature (its stone discs).
//   4. designs    today (cleanedLayout with the hole fill, black & white mapping) and each variant
//                 (E1 E2 E3, L1 L2, T1 T2, one feature at a time): designFaceFeatures, then the
//                 hole fill, finishFaceFeatures and the gap check, as for any design.
//   5. likeness   landmarks on each tinted design (face view, blurred as the AI image) against the
//                 original photo's: aligned by a similarity transform, mean distance over eyes,
//                 mouth and all points, normalised by the photo's eye distance.
//   6. page       WORK/../faces.html (private) or the pictures and results.json (public).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_BW_THRESHOLD, mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { EYE_VARIANTS, LIP_VARIANTS, MESH, TEETH_VARIANTS, designFaceFeatures, faceRegions, finishFaceFeatures, insidePolygon } from "../src/pipeline/faces.js";
import { fillHoles, lightnessOnWhite, sampleLab, snapColour, srgbToLab } from "../src/pipeline/holes.js";
import { checkGaps } from "../src/pipeline/tiers.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { aiPng, rgba, strip, tintedPng } from "./exp-holes.mjs";

const REPO = new URL("../", import.meta.url).pathname;
createRequire(path.join(REPO, "package.json"))("dotenv").config({ path: path.join(REPO, ".env"), quiet: true });
const PY = path.join(REPO, "services/strass/.venv-faces/bin/python");
const LANDMARKS = path.join(REPO, "services/strass/scripts/face_landmarks.py");
export const BLUR_MM = 0.6;
const LIKENESS_PPMM = 14;
const STYLES = ["colour", "stencil", "halftone"];
const VARIANTS = [
  { id: "today" },
  ...EYE_VARIANTS.map((v) => ({ id: v, eyes: v })),
  ...LIP_VARIANTS.map((v) => ({ id: v, lips: v })),
  ...TEETH_VARIANTS.map((v) => ({ id: v, teeth: v }))
];
const CC0 = ["car", "cat", "dachshund", "dog", "giraffe", "mug"];
const RS = ["cat", "dog", "einstein", "jesus", "lake", "leopard", "logo", "parrot", "portrait", "rose", "tulips", "woman"];

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
const round = (v, k = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** k) / 10 ** k);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// --- 0. Manifest --------------------------------------------------------------------------------

// The private portraits: every NAME with a saved model input (OpenAI/NAME-input.png), its colour,
// halftone (NAME-bw.png) and stencil (NAME-bw-stencil2.png) AI images and its original photo.
function privateManifest(root) {
  const ai = path.join(root, "OpenAI");
  const files = readdirSync(root);
  const names = readdirSync(ai).filter((f) => f.endsWith("-input.png")).map((f) => f.slice(0, -"-input.png".length)).sort();
  const items = [];
  for (const name of names) {
    const original = files.find((f) => f.replace(/\.[^.]+$/, "") === name && /\.(jpe?g|png)$/i.test(f));
    const base = { name, original: path.join(root, original), input: path.join(ai, `${name}-input.png`) };
    items.push({ ...base, style: "colour", ai: path.join(ai, `${name}.png`), layout: path.join(root, "faces/layouts", `${name}-colour-layout.json`) });
    items.push({ ...base, style: "halftone", ai: path.join(ai, `${name}-bw.png`), layout: path.join(ai, `${name}-bw-relayout-layout.json`) });
    items.push({ ...base, style: "stencil", ai: path.join(ai, `${name}-bw-stencil2.png`), layout: path.join(ai, `${name}-bw-stencil2-layout.json`) });
  }
  return items;
}

function publicManifest(work) {
  return [
    ...CC0.map((n) => ({ name: `cc0-${n}`, set: "CC0", style: "colour", original: path.join(REPO, `services/strass/tests/fixtures/photos/${n}.jpg`), input: null, ai: path.join(REPO, `tools/fixtures/is03b-ai/${n}-rule-output.png`), layout: path.join(work, "layouts", `cc0-${n}-layout.json`) })),
    ...RS.map((n) => ({ name: `rs-${n}`, set: "RS", style: "colour", original: null, input: null, ai: path.join(REPO, `services/strass/prototype/img/N2_${n}.png`), layout: path.join(work, "layouts", `rs-${n}-layout.json`) }))
  ];
}

// --- 1. Layouts ---------------------------------------------------------------------------------

async function layouts(items) {
  const { loadConfig } = await import("../src/server/config.js");
  const { aiImageForArchive } = await import("../src/prep/pngmeta.js");
  const { DEFAULT_TIMERS } = await import("../src/pipeline/provider.js");
  const { callLayoutService } = await import("../src/pipeline/layout.js");
  const config = loadConfig(process.env);
  for (const item of items) {
    if (existsSync(item.layout)) {
      const j = readJson(item.layout);
      if (j.error || "discsAtMm" in (j.report ?? {})) continue;
    }
    mkdirSync(path.dirname(item.layout), { recursive: true });
    const png = await aiImageForArchive(readFileSync(item.ai));
    const placed = await callLayoutService({ fetch: globalThis.fetch, timers: DEFAULT_TIMERS, url: config.strassServiceUrl, timeoutMs: 600_000, pngBuffer: png, colorIds: Object.keys(STONE_COLORS), signal: new AbortController().signal });
    writeJson(item.layout, placed.error ? { error: placed.error } : placed.layout);
    console.log("layout", item.name, item.style, placed.error ? placed.error.message : `${placed.layout.stones.length} stones`);
  }
}

// --- 2. Landmarks -------------------------------------------------------------------------------

function runLandmarks(jobs, outFile) {
  const todo = jobs.filter((j) => !(existsSync(outFile) && j.id in readJson(outFile)));
  if (!todo.length) return readJson(outFile);
  const jobsFile = `${outFile}.jobs.json`;
  writeJson(jobsFile, todo);
  const tmp = `${outFile}.new.json`;
  const r = spawnSync(PY, [LANDMARKS, jobsFile, tmp], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`landmarks failed: ${r.stderr.split("\n").filter((l) => !/^(W|I)0000|absl|WARNING/.test(l)).join("\n")}`);
  const all = { ...(existsSync(outFile) ? readJson(outFile) : {}), ...readJson(tmp) };
  writeJson(outFile, all);
  return all;
}

// --- 3. Faces -----------------------------------------------------------------------------------

const toMm = (report) => ([x, y]) => [(x - 0.5) * report.mmPerPx - report.offsetMm[0], (y - 0.5) * report.mmPerPx - report.offsetMm[1]];

// Mean point distance between two meshes over the given indices (all when null).
function meshDistance(a, b, ids = null) {
  const use = ids ?? a.map((_, i) => i);
  return use.reduce((s, i) => s + dist(a[i], b[i]), 0) / use.length;
}

const IOD = (f) => dist(f[468], f[473]);
const EYE_IDS = [...MESH.eyes.flatMap((e) => [...e.contour, e.iris, ...e.rim])];
const MOUTH_IDS = [...new Set([...MESH.upperOuter, ...MESH.lowerOuter, ...MESH.upperInner, ...MESH.lowerInner])];

// Without a prepared photo to confirm them (CC0, RS): the AI image's faces at STRICT_CONFIDENCE, and
// of those only the ones at least STRICT_SIZE of the largest's eye distance (MediaPipe meshes hair,
// ears and animal faces at the default confidence; checked by eye on the RS portraits). A design
// whose original photo has no human face has none.
export const STRICT_CONFIDENCE = 0.7;
export const STRICT_SIZE = 0.6;

// The design's faces (layout mm): the AI image's faces matched to the prepared photo's (iris
// centres within 0.6 eye distances); an AI face with no photo face is a false find when there is
// a photo; a photo face with no AI face is used as it is mapped.
function matchFaces(item, report, marks) {
  let ai = marks[`${item.name}:${item.style}:ai`];
  if (!item.input) {
    const strict = marks[`${item.name}:${item.style}:ai-strict`];
    const none = item.original && !marks[`${item.name}:original`]?.faces.length;
    const top = Math.max(0, ...(strict?.faces ?? []).map(IOD));
    ai = { ...strict, faces: none ? [] : (strict?.faces ?? []).filter((f) => IOD(f) >= STRICT_SIZE * top) };
  }
  const input = item.input ? marks[`${item.name}:input`] : null;
  const toLayout = toMm(report);
  let photo = [];
  if (input && ai) {
    const sx = ai.w / input.w, sy = ai.h / input.h;
    photo = input.faces.map((f) => f.map(([x, y]) => [x * sx, y * sy]));
  }
  const used = new Set();
  const faces = [];
  for (const f of ai?.faces ?? []) {
    let best = -1, bd = Infinity;
    photo.forEach((p, k) => {
      const d = (dist(f[468], p[468]) + dist(f[473], p[473])) / 2;
      if (!used.has(k) && d < bd) { bd = d; best = k; }
    });
    const matched = best >= 0 && bd < 0.6 * IOD(photo[best]);
    if (!matched && item.input) { faces.push({ source: "ai", falseFind: true }); continue; }
    if (matched) used.add(best);
    const p = matched ? photo[best] : null;
    faces.push({
      source: "ai",
      points: f.map(toLayout),
      photoPoints: p ? p.map(toLayout) : null,
      apart: p ? { meanIod: round(meshDistance(f, p) / IOD(p)), eyesIod: round(meshDistance(f, p, EYE_IDS) / IOD(p)), mouthIod: round(meshDistance(f, p, MOUTH_IDS) / IOD(p)), irisMm: round((dist(f[468], p[468]) + dist(f[473], p[473])) / 2 * report.mmPerPx, 2) } : null
    });
  }
  photo.forEach((p, k) => { if (!used.has(k)) faces.push({ source: "photo", points: p.map(toLayout), photoPoints: p.map(toLayout), apart: null }); });
  return { aiFaces: ai?.faces.length ?? 0, aiPixels: ai?.faces ?? [], photoFaces: photo.length, faces: faces.filter((f) => !f.falseFind), falseFinds: faces.filter((f) => f.falseFind).length };
}

// How the AI drew each feature: its stone discs (report.discsAtMm) per zone, read as the style reads.
function featureDiscs(points, discs, readStone) {
  const r = faceRegions(points);
  const zones = {};
  const add = (zone, disc) => {
    zones[zone] ??= { n: 0, colours: {}, dMax: 0, dSum: 0 };
    const z = zones[zone];
    const c = readStone(...disc);
    z.n++; z.colours[c] = (z.colours[c] || 0) + 1; z.dMax = Math.max(z.dMax, disc[2]); z.dSum += disc[2];
  };
  for (const disc of discs) {
    const p = [disc[0], disc[1]];
    r.eyes.forEach((e) => {
      const d = dist(p, e.iris.c);
      if (!insidePolygon(p, e.opening)) return;
      add(d <= 0.45 * e.iris.r ? "pupil" : d <= e.iris.r ? "iris" : "eye white", disc);
    });
    if (r.lips.opening && insidePolygon(p, r.lips.opening)) add("mouth opening", disc);
    else if (insidePolygon(p, r.lips.upper)) add("upper lip", disc);
    else if (insidePolygon(p, r.lips.lower)) add("lower lip", disc);
  }
  for (const z of Object.values(zones)) {
    z.dMean = round(z.dSum / z.n, 2); delete z.dSum;
    z.colours = Object.entries(z.colours).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c} ${n}`).join(", ");
  }
  return { irisRMm: r.eyes.map((e) => round(e.iris.r, 2)), eyeWidthMm: r.eyes.map((e) => round(e.widthMm, 2)), eyeDistanceMm: round(r.eyeDistanceMm, 2), mouthOpen: r.lips.open, zones };
}

// --- 4. Designs ---------------------------------------------------------------------------------

const shifted = (stones) => new StoneLayout({
  layerId: "design", sourceMode: "is",
  stones: stones.map((s, index) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color, layerId: "design", index }))
});

function readers(item, ai, input, report) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const px = (x, y) => [(x + ox) / s, (y + oy) / s];
  const bwStyle = item.style !== "colour";
  const readStone = (x, y, d) => {
    const [cx, cy] = px(x, y);
    return bwStyle ? (lightnessOnWhite(ai, cx, cy, d, s) < DEFAULT_BW_THRESHOLD ? "jet" : "crystal-clear") : snapColour(sampleLab(ai, cx, cy, d, s));
  };
  const aiLightness = (x, y) => { const [cx, cy] = px(x, y); return lightnessOnWhite(ai, cx, cy, 1.0, s); };
  const aiLabMean = (inside, box) => {
    const labs = [];
    for (let y = box.y0; y <= box.y1; y += 0.3) for (let x = box.x0; x <= box.x1; x += 0.3) {
      if (!inside([x, y])) continue;
      const [cx, cy] = px(x, y).map(Math.round);
      if (cx < 0 || cy < 0 || cx >= ai.width || cy >= ai.height) continue;
      const p = (cy * ai.width + cx) * 4;
      if (ai.data[p + 3] >= 128) labs.push(srgbToLab(ai.data[p], ai.data[p + 1], ai.data[p + 2]));
    }
    return labs.length ? [0, 1, 2].map((k) => labs.reduce((t, v) => t + v[k], 0) / labs.length) : null;
  };
  let photoLab = null;
  if (input) {
    const fx = input.width / ai.width, fy = input.height / ai.height;
    photoLab = (x, y) => {
      const [ax, ay] = px(x, y);
      const ix = Math.round((ax + 0.5) * fx - 0.5), iy = Math.round((ay + 0.5) * fy - 0.5);
      if (ix < 0 || iy < 0 || ix >= input.width || iy >= input.height) return null;
      const p = (iy * input.width + ix) * 4;
      return input.data[p + 3] >= 128 ? srgbToLab(input.data[p], input.data[p + 1], input.data[p + 2]) : null;
    };
  }
  return { readStone, aiLightness, aiLabMean, photoLab, discs: report.discsAtMm ?? [], pupils: report.pupilsAtMm ?? [] };
}

function makeDesigns(item, layout, ai, faces, ctx) {
  const natural = cleanedLayout(layout, { fillHolesIn: ai });
  const mapped = item.style === "colour" ? natural.stoneLayout
    : mapBlackAndWhiteFromImage(natural.stoneLayout, ai, { ...layout.report, originMm: natural.originMm }, DEFAULT_BW_THRESHOLD, natural.voted);
  const [gx, gy] = natural.originMm;
  const today = mapped.stones.map((s) => ({ x: s.xMm + gx, y: s.yMm + gy, d: s.sizeMm, color: s.color }));
  const points = faces.map((f) => f.points);
  const out = {};
  for (const v of VARIANTS) {
    if (v.id === "today") { out.today = { stones: today, gaps: checkGaps(shifted(today).stones), faces: null }; continue; }
    const designed = designFaceFeatures(today, points, { style: item.style, eyes: v.eyes ?? null, lips: v.lips ?? null, teeth: v.teeth ?? null, ...ctx });
    const filled = fillHoles(designed.stones, ai, layout.report);
    const finished = finishFaceFeatures(filled.stones, points, { style: item.style, eyes: v.eyes ?? null, pupils: ctx.pupils });
    const layoutOut = shifted(finished.stones);
    out[v.id] = {
      stones: finished.stones,
      gaps: checkGaps(layoutOut.stones),
      faces: designed.faces,
      filled: filled.added.length,
      bandCrystal: finished.crystal,
      designedStones: finished.stones.filter((s) => s.designed).length,
      changed: diffCount(today, finished.stones)
    };
  }
  return out;
}

// Stones of b not in a at the same place, size and colour, plus stones of a gone from b.
function diffCount(a, b) {
  const key = (s) => `${Math.round(s.x * 100)},${Math.round(s.y * 100)},${s.d},${s.color}`;
  const A = new Set(a.map(key)), B = new Set(b.map(key));
  return [...B].filter((k) => !A.has(k)).length + [...A].filter((k) => !B.has(k)).length;
}

// --- Views --------------------------------------------------------------------------------------

function boxAround(pts, margin, aspect = null) {
  let x0 = Math.min(...pts.map((p) => p[0])) - margin, x1 = Math.max(...pts.map((p) => p[0])) + margin;
  let y0 = Math.min(...pts.map((p) => p[1])) - margin, y1 = Math.max(...pts.map((p) => p[1])) + margin;
  if (aspect) {
    const w = x1 - x0, h = y1 - y0;
    if (w / h < aspect) { const add = (h * aspect - w) / 2; x0 -= add; x1 += add; } else { const add = (w / aspect - h) / 2; y0 -= add; y1 += add; }
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

function faceViews(points) {
  const r = faceRegions(points);
  const iod = r.eyeDistanceMm;
  return {
    face: boxAround([...points], 0.25 * iod, 0.8),
    eyes: boxAround(r.eyes.flatMap((e) => e.opening), 0.35 * iod, 2.6),
    mouth: boxAround(r.lips.outer, 0.3 * iod, 1.8)
  };
}

// The prepared photo (model input) cropped to a view in the layout's mm.
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

// --- 5. Likeness --------------------------------------------------------------------------------

// Similarity Procrustes: b aligned onto a (least squares), -> b's points in a's frame.
function align(a, b) {
  const n = a.length;
  const ca = a.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  const cb = b.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  let sxx = 0, sxy = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[i][0] - ca[0], ay = a[i][1] - ca[1], bx = b[i][0] - cb[0], by = b[i][1] - cb[1];
    sxx += ax * bx + ay * by; sxy += ay * bx - ax * by; nb += bx * bx + by * by;
  }
  const scale = Math.hypot(sxx, sxy) / nb, th = Math.atan2(sxy, sxx);
  const c = Math.cos(th) * scale, s = Math.sin(th) * scale;
  return b.map(([x, y]) => [ca[0] + c * (x - cb[0]) - s * (y - cb[1]), ca[1] + s * (x - cb[0]) + c * (y - cb[1])]);
}

// Landmarks of the original photo (a face) against a design's (aligned): { all, eyes, mouth } in eye
// distances of the photo; null if either is missing. Of several photo faces, the closest after
// alignment.
function likeness(photoFaces, designFace) {
  if (!designFace || !photoFaces?.length) return null;
  let best = null;
  for (const p of photoFaces) {
    const al = align(p, designFace);
    const iod = IOD(p);
    const m = { all: meshDistance(p, al) / iod, eyes: meshDistance(p, al, EYE_IDS) / iod, mouth: meshDistance(p, al, MOUTH_IDS) / iod };
    if (!best || m.all < best.all) best = m;
  }
  return { all: round(best.all), eyes: round(best.eyes), mouth: round(best.mouth) };
}

// --- Run ----------------------------------------------------------------------------------------

async function run(kind, root) {
  const isPrivate = kind === "private";
  const work = isPrivate ? path.join(root, "faces") : root;
  const pics = isPrivate ? path.join(work, "pics") : path.join(REPO, "docs/exp-faces");
  for (const d of [work, path.join(work, "likeness"), pics]) mkdirSync(d, { recursive: true });
  // FACES_ONLY=name1,name2 runs those designs only (trials).
  const only = (process.env.FACES_ONLY || "").split(",").filter(Boolean);
  const items = (isPrivate ? privateManifest(root) : publicManifest(work)).filter((i) => !only.length || only.includes(i.name));
  writeJson(path.join(work, "manifest.json"), items);

  // 1.
  await layouts(items);

  // 2.
  const marksFile = path.join(work, "landmarks.json");
  const jobs = [];
  for (const item of items) {
    const layout = readJson(item.layout);
    const mmPerPx = layout.report?.mmPerPx ?? 0.15;
    jobs.push({ id: `${item.name}:${item.style}:ai`, path: item.ai, blurPx: BLUR_MM / mmPerPx });
    if (!item.input) jobs.push({ id: `${item.name}:${item.style}:ai-strict`, path: item.ai, blurPx: BLUR_MM / mmPerPx, confidence: STRICT_CONFIDENCE });
    if (item.original) jobs.push({ id: `${item.name}:original`, path: item.original, blurPx: 0 });
    if (item.input) jobs.push({ id: `${item.name}:input`, path: item.input, blurPx: 0 });
  }
  const marks = runLandmarks([...new Map(jobs.map((j) => [j.id, j])).values()], marksFile);

  // 3. and 4.
  const results = [];
  // The likeness reference of each design: the original photo's faces; without a photo (RS), the
  // AI image's confirmed faces.
  const refs = new Map();
  const likenessJobs = [];
  const renders = [];
  for (const item of items) {
    const layout = readJson(item.layout);
    const res = { name: item.name, set: item.set ?? "private", style: item.style };
    results.push(res);
    if (layout.error) { res.error = layout.error.message ?? String(layout.error); continue; }
    const ai = await rgba(item.ai);
    const input = item.input ? await rgba(item.input) : null;
    const matched = matchFaces(item, layout.report, marks);
    refs.set(`${item.name}:${item.style}`, item.original ? marks[`${item.name}:original`]?.faces : matched.aiPixels);
    res.landmarks = {
      original: item.original ? marks[`${item.name}:original`]?.faces.length ?? 0 : null,
      prepared: item.input ? marks[`${item.name}:input`]?.faces.length ?? 0 : null,
      ai: matched.aiFaces, aiFalseFinds: matched.falseFinds,
      used: matched.faces.map((f) => f.source),
      apart: matched.faces.map((f) => f.apart)
    };
    res.serviceFace = layout.report.face;
    if (!matched.faces.length) { res.skipped = "no human face"; continue; }
    const ctx = readers(item, ai, input, layout.report);
    res.aiDrew = matched.faces.map((f) => featureDiscs(f.points, ctx.discs, ctx.readStone));
    const designs = makeDesigns(item, layout, ai, matched.faces, ctx);
    res.designs = Object.fromEntries(Object.entries(designs).map(([id, d]) => [id, { stones: d.stones.length, gapsOk: d.gaps.ok, belowMinGap: d.gaps.belowMinGap, overlaps: d.gaps.overlaps, filled: d.filled, designedStones: d.designedStones, changed: d.changed, bandCrystal: d.bandCrystal, faces: d.faces }]));
    const bwGap = item.style === "colour" ? null : "crystal";
    const ppmm = 14;
    for (const [fi, face] of matched.faces.entries()) {
      const views = faceViews(face.points);
      // Likeness renders: the face view of each design, blurred as the AI image.
      for (const [id, d] of Object.entries(designs)) {
        const file = path.join(work, "likeness", `${item.name}-${item.style}-f${fi}-${id}.png`);
        if (!existsSync(file)) writeFileSync(file, await tintedPng(shifted(d.stones), views.face, LIKENESS_PPMM, { bwGap }));
        likenessJobs.push({ id: `${item.name}:${item.style}:f${fi}:${id}`, path: file, blurPx: BLUR_MM * LIKENESS_PPMM });
      }
      // Pictures: face, eyes and mouth views.
      for (const [tag, view, ids] of [["face", views.face, VARIANTS.map((v) => v.id)], ["eyes", views.eyes, ["today", ...EYE_VARIANTS]], ["mouth", views.mouth, ["today", ...LIP_VARIANTS, ...TEETH_VARIANTS]]]) {
        const file = `${item.name}-${item.style}-f${fi}-${tag}.jpg`;
        renders.push({ name: item.name, style: item.style, face: fi, tag, file });
        if (existsSync(path.join(pics, file))) continue;
        const height = tag === "face" ? 300 : 220;
        const scale = height / view.h;
        const panels = [];
        if (input) panels.push({ label: "photo", png: await photoPng(item.input, ai, layout.report, view, scale) });
        panels.push({ label: "AI image", png: await aiPng(item.ai, layout.report, view, scale) });
        for (const id of ids) panels.push({ label: id, png: await tintedPng(shifted(designs[id].stones), view, Math.max(ppmm, scale), { bwGap }) });
        writeFileSync(path.join(pics, file), await strip(null, panels, height));
      }
    }
    // Whole design, today.
    const whole = `${item.name}-${item.style}-whole.jpg`;
    renders.push({ name: item.name, style: item.style, tag: "whole", file: whole });
    if (!existsSync(path.join(pics, whole))) {
      const b = shifted(designs.today.stones).getBoundingBox();
      const view = { x0: b.minXmm - 1, y0: b.minYmm - 1, w: b.widthMm + 2, h: b.heightMm + 2 };
      const scale = 420 / view.h;
      const panels = [];
      if (input) panels.push({ label: "photo", png: await photoPng(item.input, ai, layout.report, view, scale) });
      panels.push({ label: "AI image", png: await aiPng(item.ai, layout.report, view, scale) });
      panels.push({ label: "today", png: await tintedPng(shifted(designs.today.stones), view, scale * 1.5, { bwGap }) });
      writeFileSync(path.join(pics, whole), await strip(null, panels, 420));
    }
    console.log(item.name, item.style, `faces ${matched.faces.length}`, Object.entries(res.designs).map(([id, d]) => `${id}${d.gapsOk ? "" : "!"}`).join(" "));
  }

  // 5.
  const likeMarks = runLandmarks(likenessJobs, path.join(work, "likeness-landmarks.json"));
  for (const res of results) {
    if (!res.designs) continue;
    const item = items.find((i) => i.name === res.name && i.style === res.style);
    // The reference: the original photo's faces; without a photo (RS), the AI image's.
    const ref = refs.get(`${item.name}:${item.style}`);
    res.likenessReference = item.original ? "original photo" : "AI image";
    res.likeness = {};
    res.likeness.ai = likeness(ref, marks[`${item.name}:${item.style}:ai`]?.faces?.[0] ? bestOf(ref, marks[`${item.name}:${item.style}:ai`].faces) : null);
    for (const id of Object.keys(res.designs)) {
      res.likeness[id] = res.landmarks.used.map((_, fi) => {
        const found = likeMarks[`${res.name}:${res.style}:f${fi}:${id}`]?.faces;
        return found?.length ? likeness(ref, largest(found)) : null;
      });
    }
  }
  writeJson(path.join(work, "results.json"), results);
  writeJson(path.join(work, "renders.json"), renders);
  if (isPrivate) writeFileSync(path.join(root, "faces.html"), page(results, renders, "faces/pics"));
  return results;
}

// The design face nearest a reference face (for the AI image: of its faces, the one with the best
// likeness), and the largest face of a render (the face view holds one face, sometimes a neighbour).
function bestOf(ref, faces) {
  return faces.map((f) => [f, likeness(ref, f)?.all ?? Infinity]).sort((a, b) => a[1] - b[1])[0][0];
}
const largest = (faces) => faces.slice().sort((a, b) => IOD(b) - IOD(a))[0];

// --- 6. Page ------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function likenessTable(res) {
  if (!res.likeness) return "";
  const ids = Object.keys(res.designs);
  const rows = res.landmarks.used.map((_, fi) => `<tr><td>face ${fi + 1}</td>${ids.map((id) => {
    const l = res.likeness[id]?.[fi];
    return `<td>${l ? `${l.all} / ${l.eyes} / ${l.mouth}` : "–"}</td>`;
  }).join("")}</tr>`).join("");
  const ai = res.likeness.ai ? `${res.likeness.ai.all} / ${res.likeness.ai.eyes} / ${res.likeness.ai.mouth}` : "–";
  return `<table><tr><th>likeness (all / eyes / mouth, eye distances; lower is closer)</th>${ids.map((id) => `<th>${id}</th>`).join("")}</tr>${rows}<tr><td>AI image</td><td colspan="${ids.length}">${ai}</td></tr></table>`;
}

function facts(res) {
  if (res.error) return `<p class="note">Layout failed: ${esc(res.error)}</p>`;
  const l = res.landmarks;
  const apart = l.apart.map((a, i) => (a ? `face ${i + 1}: AI vs prepared photo ${a.meanIod} eye distances (eyes ${a.eyesIod}, mouth ${a.mouthIod}), iris centres ${a.irisMm} mm apart` : `face ${i + 1}: AI only`)).join("; ");
  let s = `<p class="note">Landmarks: original ${l.original ?? "–"} face(s), prepared ${l.prepared ?? "–"}, AI ${l.ai} (${l.aiFalseFinds} false); used: ${l.used.join(", ") || "none"}. ${apart}</p>`;
  if (res.skipped) return `${s}<p class="note">${esc(res.skipped)}</p>`;
  for (const [fi, drew] of (res.aiDrew ?? []).entries()) {
    s += `<p class="note">Face ${fi + 1}: eye distance ${drew.eyeDistanceMm} mm, eye widths ${drew.eyeWidthMm.join(" / ")} mm, iris radii ${drew.irisRMm.join(" / ")} mm, mouth ${drew.mouthOpen ? "open" : "closed"}. AI discs: ${Object.entries(drew.zones).map(([z, v]) => `${z} ${v.n} (${esc(v.colours)}; largest ${v.dMax} mm)`).join("; ")}</p>`;
  }
  const bad = Object.entries(res.designs).filter(([, d]) => !d.gapsOk).map(([id]) => id);
  s += `<p class="note">Stones: ${Object.entries(res.designs).map(([id, d]) => `${id} ${d.stones}${d.changed ? ` (${d.changed} changed)` : ""}`).join(", ")}. Gap check: ${bad.length ? `fails for ${bad.join(", ")}` : "0 violations in every design"}.</p>`;
  return s + likenessTable(res);
}

function page(results, renders, picsRel) {
  const sections = STYLES.map((style) => {
    const rows = results.filter((r) => r.style === style).map((res) => {
      const imgs = renders.filter((r) => r.name === res.name && r.style === style)
        .map((r) => `<figure><img loading="lazy" src="${picsRel}/${r.file}" alt=""><figcaption>${r.tag}${r.face != null ? `, face ${r.face + 1}` : ""}</figcaption></figure>`).join("");
      return `<article><h3>${esc(res.name)}</h3>${facts(res)}${imgs}</article>`;
    }).join("");
    return `<section><h2>${style}</h2>${rows}</section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>exp-faces</title><style>
body{font-family:Helvetica,Arial,sans-serif;margin:16px;color:#122;background:#fff}h2{color:#1d3a8a;border-bottom:2px solid #1d3a8a}
article{margin:0 0 40px}figure{margin:6px 0}img{max-width:100%;display:block}figcaption{font-size:12px;color:#556}
.note{font-size:13px;margin:4px 0}table{border-collapse:collapse;font-size:12px;margin:6px 0}td,th{border:1px solid #ccd;padding:2px 6px;text-align:left}
</style></head><body><h1>exp-faces: eyes, lips and teeth</h1>
<p>Panels: photo (the prepared photo) | AI image | today | variants. Variants change one feature each: E1 the AI's eye stones cleaned, E2 designed eye (SS16 pupil), E3 designed eye (SS6 pupil cluster); L1 one tone, L2 two tones; T1 Crystal teeth, T2 with a line between the rows. Black &amp; white views use BW_GAP crystal.</p>
${sections}</body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, root] = process.argv.slice(2);
  if (!["private", "public"].includes(kind) || !root) {
    console.error("usage: node tools/exp-faces.mjs private|public ROOT");
    process.exit(2);
  }
  await run(kind, path.resolve(root));
}
