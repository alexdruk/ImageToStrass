// IS-05c eyes and skin diagnosis, images and numbers for docs/IS-05c-results.md, run by hand (no
// provider or strass call):
//   node tools/is05c-results.mjs <runs dir>
// <runs dir> holds services/strass/scripts/is05c_runs.py's layouts: <name>.<variant>.json and
// <name>.<variant>.stages.json. Images go to docs/IS-05c-results/, numbers to
// docs/IS-05c-results/numbers.json. IS05C_PARTS picks the parts (comma-separated):
//   eyes   per design and eye variant: AI image, plain and tinted eye close-ups (same window), and
//          stones per colour inside the eye area;
//   skin   rs-woman: the catalogue colours of the stones on the AI's mid-brown skin, the colour step
//          that makes them darker, and per skin variant the face and neck (AI, tinted, ΔE map);
//   rs     Rhinestone Studio's own outputs (prototype/expected and the RS 38cd831 service layouts
//          in tools/fixtures/layouts): eye close-ups next to the AI image.
//   after  section 5 (Alex's decisions): <runs dir> holds the "before" (the IS-05b DEFAULT) and
//          "default" (today's) layouts of the 21 designs under the run names of is05b-measure.mjs;
//          before = "before" layout + the renderer before IS-05c, after = "default" + today's.
//          Eye close-ups and eye-area numbers for the six designs, the woman's face and neck,
//          per-stone ΔE of the 21 designs, and what changed on each design.
import { createCanvas } from "@napi-rs/canvas";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { stonesOfLayout, toStoneLayout } from "../src/pipeline/tiers.js";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { getCrystalAppearance } from "../src/stones/CrystalAppearance.js";
import { drawCrystalStone } from "../src/stones/CrystalStoneRenderer.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { deltaE2000, discLab, mean, srgbToLab } from "./colour-diff.mjs";
import { ALL_DESIGNS, CAT_LAB, SAMPLE_SHARE, decodeRgba, delivered, measure, nearestCatalogue, summary } from "./is05b-measure.mjs";
import { renderTintedBefore } from "./is05b-tint.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = path.join(ROOT, "docs/IS-05c-results");
const RUNS = process.argv[2];
if (!RUNS) throw new Error("usage: node tools/is05c-results.mjs <runs dir>");
const PARTS = (process.env.IS05C_PARTS || "eyes,skin,rs").split(",");
// The renderer before IS-05c (spec section 8 steps 4 and 5 as of IS-05b).
const renderBefore = (sl, o) => renderTinted(sl, { ...o, fillReach: 1.6, ss6Rim: false });
const GAP = 10, LABEL_H = 34, PX_PER_MM = 30;
mkdirSync(OUT, { recursive: true });

const RS_IMG = path.join(ROOT, "services/strass/prototype/img");
const DESIGNS = [
  { id: "rs-woman", run: "woman", ai: path.join(RS_IMG, "N2_woman.png"), rs: "woman" },
  { id: "rs-portrait", run: "portrait", ai: path.join(RS_IMG, "N2_portrait.png"), rs: "portrait" },
  { id: "rs-einstein", run: "einstein", ai: path.join(RS_IMG, "N2_einstein.png"), rs: "einstein" },
  { id: "rs-jesus", run: "jesus", ai: path.join(RS_IMG, "N2_jesus.png"), rs: "jesus" },
  { id: "rs-dog", run: "dog", ai: path.join(RS_IMG, "N2_dog.png"), rs: "dog" },
  { id: "cat-rule", run: "cat", ai: path.join(ROOT, "tools/fixtures/is03b-ai/cat-rule-output.png") }
];
export const EYE_VARIANTS = ["default", "eye-no-pupil-core-only", "eye-no-pupil-inscribed", "eye-no-human-iris", "eye-no-eye-keep",
  "eye-no-lively-eyes", "eye-no-plausible-eyes", "eye-no-lashes", "eye-rules-off", "eye-skip"];
export const SKIN_VARIANTS = ["default", "skin-no-skin-nearest", "skin-no-calm-skin", "skin-no-skin-no-wine", "skin-soft-outlines-on",
  "skin-no-family-fix", "skin-no-distinct", "skin-no-darkdots", "skin-rules-off", "skin-nearest-inner",
  "skin-nearest-inner-kl2"];

const numbersFile = path.join(OUT, "numbers.json");
const numbers = existsSync(numbersFile) ? JSON.parse(readFileSync(numbersFile, "utf8")) : {};
const runFile = (d, v, ext = "json") => path.join(RUNS, `${d.run}.${v}.${ext}`);
const hasRun = (d, v) => existsSync(runFile(d, v));
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const sameStones = (a, b) => JSON.stringify(a.stones) === JSON.stringify(b.stones);

// ---- the delivered design in AI-image (frame) mm ------------------------------------------------

// A layout's delivered stones (SS16/SS20 cap and overlap cleanup) and the shift from their
// StoneLayout mm to the AI image's frame mm (frame = layout + offsetMm; StoneLayout = layout − box).
function design(layout) {
  const { stoneLayout, kept } = delivered(layout);
  const [ox, oy] = layout.report.offsetMm;
  const shift = [kept[0].x - stoneLayout.stones[0].xMm + ox, kept[0].y - stoneLayout.stones[0].yMm + oy];
  return { stoneLayout, kept, shift, s: layout.report.mmPerPx };
}

// RS prototype output (stones in frame mm, as dicts) as a design, uncapped (RS caps nothing).
function rsExpected(name) {
  const e = load(path.join(ROOT, `services/strass/prototype/expected/N2_${name}_final_rs.json`));
  const stones = e.stones.map((q) => ({ x: q.x, y: q.y, d: q.d, color: q.color }));
  const { stoneLayout } = toStoneLayout(stones, 1);
  return { stoneLayout, kept: stones, shift: [stones[0].x - stoneLayout.stones[0].xMm, stones[0].y - stoneLayout.stones[0].yMm], s: e.report.mm_per_px };
}

// RS 38cd831 service layout (tools/fixtures/layouts), uncapped.
function rsService(name) {
  const layout = load(path.join(ROOT, `tools/fixtures/layouts/${name}.json`));
  const stones = stonesOfLayout(layout);
  const { stoneLayout } = toStoneLayout(stones, 1);
  const [ox, oy] = layout.report.offsetMm;
  return { stoneLayout, kept: stones, shift: [stones[0].x - stoneLayout.stones[0].xMm + ox, stones[0].y - stoneLayout.stones[0].yMm + oy], s: layout.report.mmPerPx };
}

// ---- drawing -------------------------------------------------------------------------------------

function label(text, width) {
  const canvas = createCanvas(width, LABEL_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, LABEL_H);
  ctx.fillStyle = "#0b1f4d";
  ctx.font = "bold 20px Helvetica, Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, LABEL_H / 2);
  return canvas.toBuffer("image/png");
}

// Panels [{ png, label }] in a grid of `cols` columns, each scaled to cellH px high.
async function grid(panels, cols, cellH, file) {
  const scaled = await Promise.all(panels.map(async (p) => {
    const { data, info } = await sharp(p.png).flatten({ background: "#ffffff" }).resize({ height: cellH }).png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, label: p.label };
  }));
  const cellW = Math.max(...scaled.map((s) => s.width));
  const rows = Math.ceil(scaled.length / cols);
  const width = cols * cellW + (cols - 1) * GAP, height = rows * (cellH + LABEL_H) + (rows - 1) * GAP;
  const composite = [];
  scaled.forEach((s, i) => {
    const left = (i % cols) * (cellW + GAP), top = Math.floor(i / cols) * (cellH + LABEL_H + GAP);
    composite.push({ input: label(s.label, cellW), left, top }, { input: s.png, left: left + Math.round((cellW - s.width) / 2), top: top + LABEL_H });
  });
  await sharp({ create: { width, height, channels: 3, background: "#e6e9ef" } }).composite(composite)
    .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(OUT, file));
  return file;
}

// The AI image inside a frame-mm window, at PX_PER_MM.
async function aiWindow(aiFile, s, win, pxPerMm = PX_PER_MM) {
  const meta = await sharp(aiFile).metadata();
  const left = Math.max(0, Math.round(win.x / s)), top = Math.max(0, Math.round(win.y / s));
  const width = Math.min(meta.width - left, Math.round(win.w / s)), height = Math.min(meta.height - top, Math.round(win.h / s));
  return sharp(aiFile).extract({ left, top, width, height }).flatten({ background: "#ffffff" })
    .resize({ width: Math.round(win.w * pxPerMm), height: Math.round(win.h * pxPerMm), fit: "fill", kernel: "nearest" }).png().toBuffer();
}

function renderPlain(stoneLayout, box, scale) {
  const w = Math.round(box.widthMm * scale), h = Math.round(box.heightMm * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  for (const s of stoneLayout.stones) {
    drawCrystalStone(ctx, (s.xMm - box.minXmm) * scale, (s.yMm - box.minYmm) * scale, (s.sizeMm / 2) * scale, s.color, getCrystalAppearance(s));
  }
  return canvas.toBuffer("image/png");
}

// Plain and tinted renders of a design inside a frame-mm window (rendered from the stones near it,
// which is exact: a pixel takes its colour from stones within 1.6 radii).
async function windowRenders(des, win, render = renderTinted, pxPerMm = PX_PER_MM) {
  const w = { minXmm: win.x - des.shift[0], minYmm: win.y - des.shift[1], widthMm: win.w, heightMm: win.h };
  const reach = 8;
  const near = des.stoneLayout.stones.filter((s) => s.xMm > w.minXmm - reach && s.xMm < w.minXmm + w.widthMm + reach &&
    s.yMm > w.minYmm - reach && s.yMm < w.minYmm + w.heightMm + reach);
  const sub = new StoneLayout({ layerId: "win", stones: near });
  const box = tintCanvasMm(sub);
  const tinted = render(sub, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
  const extract = {
    left: Math.max(0, Math.round((w.minXmm - box.minXmm) * tinted.scale)), top: Math.max(0, Math.round((w.minYmm - box.minYmm) * tinted.scale)),
    width: Math.round(w.widthMm * tinted.scale), height: Math.round(w.heightMm * tinted.scale)
  };
  extract.width = Math.min(extract.width, tinted.widthPx - extract.left);
  extract.height = Math.min(extract.height, tinted.heightPx - extract.top);
  const [plain, tint] = await Promise.all([renderPlain(sub, box, tinted.scale), tinted.png].map((png) => sharp(png).extract(extract).png().toBuffer()));
  return { plain, tinted: tint };
}

// Per-stone ΔE map of a window: each delivered stone filled with its ΔE2000 class (AI colour under
// the stone vs its catalogue fill), on white.
const DE_CLASSES = [[5, "#2e9e4f"], [10, "#c9d62f"], [15, "#f0a020"], [20, "#e0502a"], [Infinity, "#8e1020"]];
function deMap(des, win, deOf, pxPerMm = PX_PER_MM) {
  const w = Math.round(win.w * pxPerMm), h = Math.round(win.h * pxPerMm);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  des.stoneLayout.stones.forEach((st, i) => {
    const de = deOf(i);
    if (de == null) return;
    const x = (st.xMm + des.shift[0] - win.x) * pxPerMm, y = (st.yMm + des.shift[1] - win.y) * pxPerMm;
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
    ctx.fillStyle = DE_CLASSES.find(([lim]) => de < lim)[1];
    ctx.beginPath();
    ctx.arc(x, y, (st.sizeMm / 2) * pxPerMm, 0, 2 * Math.PI);
    ctx.fill();
  });
  return canvas.toBuffer("image/png");
}

// ---- per-stone colours ---------------------------------------------------------------------------

// For every delivered stone: frame-mm centre, diameter, colour, the AI colour under it (mean Lab of
// the inner 60 % of its disc) and ΔE2000 to its catalogue fill.
function stoneRecords(des, img) {
  return des.stoneLayout.stones.map((st, i) => {
    const x = st.xMm + des.shift[0], y = st.yMm + des.shift[1];
    const ai = discLab(img, x / des.s, y / des.s, SAMPLE_SHARE * st.sizeMm / 2 / des.s);
    return { i, x, y, d: st.sizeMm, color: st.color, layoutIndex: des.kept[i]?.layoutIndex, ai, de: ai ? deltaE2000(ai, CAT_LAB[st.color]) : null };
  });
}

const L = (id) => CAT_LAB[id][0];
const tally = (xs) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

// Stone classes for the eye counts, by the catalogue fill's Lab: dark (L* < 30), white (neutral,
// L* ≥ 80: crystal, white opal), grey (neutral, 30–80: silver, hematite-like greys), other.
function classOf(lab) {
  const [l, a, b] = lab;
  const c = Math.hypot(a, b);
  if (l < 30) return "dark";
  if (c < 10) return l >= 80 ? "white" : "grey";
  return "colour";
}

// ---- eyes ----------------------------------------------------------------------------------------

// The eye area: a circle around each pupil of the default layout (frame mm), radius the pupil's
// radius plus 4 mm (two rings of SS6 around a pupil). The window: both circles plus 3 mm.
function eyeArea(layout) {
  const r = layout.report;
  if (!r.pupilsAtMm || r.pupilsAtMm.length < 1) return null;
  const eyes = r.pupilsAtMm.map(([x, y], k) => ({ x: x + r.offsetMm[0], y: y + r.offsetMm[1], r: r.pupilsMm[k] / 2 + 4 }));
  const x0 = Math.min(...eyes.map((e) => e.x - e.r)) - 3, x1 = Math.max(...eyes.map((e) => e.x + e.r)) + 3;
  const y0 = Math.min(...eyes.map((e) => e.y - e.r)) - 3, y1 = Math.max(...eyes.map((e) => e.y + e.r)) + 3;
  return { eyes, win: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}
const inEyes = (eyes, x, y) => eyes.some((e) => Math.hypot(x - e.x, y - e.y) <= e.r);

async function eyesPart() {
  const out = {};
  for (const d of DESIGNS) {
    if (!hasRun(d, "default")) continue;
    const base = load(runFile(d, "default"));
    const area = eyeArea(base);
    const img = await decodeRgba(d.ai);
    const rows = [];
    const panels = [];
    const aiPng = area && await aiWindow(d.ai, base.report.mmPerPx, area.win);
    for (const v of EYE_VARIANTS) {
      if (!hasRun(d, v)) continue;
      const layout = load(runFile(d, v));
      const same = v !== "default" && sameStones(layout, base);
      const rec = { variant: v, stones: layout.report.stones, face: layout.report.face, pupilsMm: layout.report.pupilsMm, sameAsDefault: same };
      if (area) {
        const des = design(layout);
        const recs = stoneRecords(des, img).filter((q) => inEyes(area.eyes, q.x, q.y));
        rec.eyeStones = recs.length;
        rec.bySize = tally(recs.map((q) => q.d));
        rec.byColour = tally(recs.map((q) => q.color));
        rec.byClass = tally(recs.map((q) => classOf(CAT_LAB[q.color])));
        rec.aiByClass = tally(recs.filter((q) => q.ai).map((q) => classOf(q.ai)));
        rec.meanDe = r2(mean(recs.filter((q) => q.de != null).map((q) => q.de)));
        if (!same) {
          const { plain, tinted } = await windowRenders(des, area.win);
          panels.push({ png: aiPng, label: `AI image · ${v}` }, { png: plain, label: "plain" }, { png: tinted, label: "tinted" });
        }
      }
      rows.push(rec);
      console.log("eyes", d.id, v, JSON.stringify({ stones: rec.stones, face: rec.face, eye: rec.eyeStones, cls: rec.byClass, de: rec.meanDe, same }));
    }
    const file = panels.length ? await grid(panels, 3, 300, `eyes-${d.run}.jpg`) : null;
    out[d.id] = { area, rows, file };
  }
  numbers.eyes = out;
}

// ---- skin ----------------------------------------------------------------------------------------

// rs-woman's AI skin: warm hue (30–78°), chroma 12–60. "Mid-brown": AI L* 40–60.
const isSkinAi = (lab) => {
  const c = Math.hypot(lab[1], lab[2]), h = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
  return c >= 12 && c <= 60 && h >= 30 && h <= 78 && lab[0] >= 25;
};
const isMidBrown = (lab) => isSkinAi(lab) && lab[0] >= 40 && lab[0] < 60;
// Face and neck of rs-woman, frame mm (AI image px 380–1010 × 120–1130 at 0.1221 mm/px), without
// the hair: only skin stones are scored.
const WOMAN_FACE = { x: 46, y: 15, w: 77, h: 123 };

async function skinPart() {
  const d = DESIGNS[0];
  const img = await decodeRgba(d.ai);
  const base = load(runFile(d, "default"));
  const des = design(base);
  const stages = load(runFile(d, "default", "stages.json"));
  const recs = stoneRecords(des, img).filter((q) => q.ai);

  // 1. What the mid-brown stones get, and which step made the darker ones.
  const mid = recs.filter((q) => isMidBrown(q.ai));
  const nearest = mid.map((q) => nearestCatalogue(q.ai).id);
  const darker = mid.filter((q, k) => L(q.color) < L(nearest[k]) - 3);
  const stepOf = (q) => {
    const row = stages.colours[q.layoutIndex];
    if (!row) return "unknown";
    let k = row.length - 1;
    while (k > 0 && row[k - 1] === row[k]) k--;
    return stages.stages[k];
  };
  const firstOf = (q) => stages.colours[q.layoutIndex]?.[0];
  const firstDarker = mid.filter((q, k) => firstOf(q) && L(firstOf(q)) < L(nearest[k]) - 3).length;
  const byL = (o) => Object.fromEntries(Object.entries(o).map(([k, n]) => [`${k} (L* ${L(k).toFixed(0)})`, n]));
  const aiL = mean(mid.map((q) => q.ai[0]));
  const skin = {
    midBrown: mid.length, meanAiL: r2(aiL), meanStoneL: r2(mean(mid.map((q) => L(q.color)))),
    meanNearestL: r2(mean(nearest.map(L))), meanDe: r2(mean(mid.map((q) => q.de))),
    assigned: byL(tally(mid.map((q) => q.color))), nearest: byL(tally(nearest)),
    darker: darker.length, darkerAssigned: byL(tally(darker.map((q) => q.color))), darkerStep: tally(darker.map(stepOf)),
    firstPickDarker: firstDarker,
    darkerFill: darker.filter((q) => stages.fill[q.layoutIndex]).length,
    darkerMeanAiL: r2(mean(darker.map((q) => q.ai[0]))),
    // the first pick's colour for the darker stones vs the plain nearest
    darkerFirst: byL(tally(darker.map(firstOf))),
    darkerNearest: byL(tally(darker.map((q) => nearestCatalogue(q.ai).id)))
  };
  // AI L* bands: assigned fill L* minus AI L* per band (the systematic shift)
  skin.bands = [[25, 40], [40, 50], [50, 60], [60, 70], [70, 90]].map(([a, b]) => {
    const xs = recs.filter((q) => isSkinAi(q.ai) && q.ai[0] >= a && q.ai[0] < b);
    return { band: `${a}–${b}`, n: xs.length, dL: r2(mean(xs.map((q) => L(q.color) - q.ai[0]))), dLnearest: r2(mean(xs.map((q) => L(nearestCatalogue(q.ai).id) - q.ai[0]))), de: r2(mean(xs.map((q) => q.de))) };
  });
  console.log("skin", JSON.stringify(skin, null, 1));

  // 2. Variants: face and neck, AI | tinted | ΔE map, with skin ΔE numbers.
  const aiPng = await aiWindow(d.ai, des.s, WOMAN_FACE, 8);
  const panels = [];
  const variants = [];
  for (const v of SKIN_VARIANTS) {
    if (!hasRun(d, v)) continue;
    const layout = load(runFile(d, v));
    const dv = design(layout);
    const rv = stoneRecords(dv, img);
    const sk = rv.filter((q) => q.ai && isSkinAi(q.ai) && q.x >= WOMAN_FACE.x && q.x <= WOMAN_FACE.x + WOMAN_FACE.w && q.y >= WOMAN_FACE.y && q.y <= WOMAN_FACE.y + WOMAN_FACE.h);
    const md = sk.filter((q) => isMidBrown(q.ai));
    const changed = layout.stones.filter((q, k) => base.stones[k] && q[3] !== base.stones[k][3]).length;
    const row = {
      variant: v, changed, sameGeometry: JSON.stringify(layout.stones.map((q) => q.slice(0, 3))) === JSON.stringify(base.stones.map((q) => q.slice(0, 3))),
      skin: sk.length, skinDe: r2(mean(sk.map((q) => q.de))), skinDL: r2(mean(sk.map((q) => L(q.color) - q.ai[0]))),
      mid: md.length, midDe: r2(mean(md.map((q) => q.de))), midDL: r2(mean(md.map((q) => L(q.color) - q.ai[0]))),
      midDarker: md.filter((q) => L(q.color) < L(nearestCatalogue(q.ai).id) - 3).length
    };
    variants.push(row);
    console.log("skin", v, JSON.stringify(row));
    if (v === "default" || changed) {
      const { tinted } = await windowRenders(dv, WOMAN_FACE, renderTinted, 8);
      const map = deMap(dv, WOMAN_FACE, (i) => (rv[i].ai && isSkinAi(rv[i].ai) ? rv[i].de : null), 8);
      panels.push({ png: aiPng, label: "AI image" }, { png: tinted, label: `tinted · ${v}` }, { png: map, label: `ΔE · skin ${row.skinDe} · mid ${row.midDe}` });
    }
  }
  skin.variants = variants;
  skin.file = await grid(panels, 3, 620, "skin-woman.jpg");
  // The default design's mid-brown stones that are darker than nearest, marked on the AI image.
  const mark = createCanvas(Math.round(WOMAN_FACE.w * 8), Math.round(WOMAN_FACE.h * 8));
  const ctx = mark.getContext("2d");
  const { loadImage } = await import("@napi-rs/canvas");
  ctx.drawImage(await loadImage(aiPng), 0, 0);
  ctx.lineWidth = 2;
  for (const q of darker) {
    ctx.strokeStyle = "#00e0ff";
    ctx.beginPath();
    ctx.arc((q.x - WOMAN_FACE.x) * 8, (q.y - WOMAN_FACE.y) * 8, (q.d / 2) * 8, 0, 2 * Math.PI);
    ctx.stroke();
  }
  const { tinted: tintDefault } = await windowRenders(des, WOMAN_FACE, renderTinted, 8);
  skin.markFile = await grid([{ png: mark.toBuffer("image/png"), label: "AI image · darker than nearest marked" }, { png: tintDefault, label: "tinted · default" }], 2, 620, "skin-woman-darker.jpg");
  numbers.skin = skin;

  // 3. Every design: skin and fur stones (warm AI colour) per variant, ΔE and ΔL* (stone − AI).
  const all = {};
  for (const dd of DESIGNS) {
    if (!hasRun(dd, "default")) continue;
    const im = await decodeRgba(dd.ai);
    const b = load(runFile(dd, "default"));
    all[dd.id] = [];
    for (const v of SKIN_VARIANTS) {
      if (!hasRun(dd, v)) continue;
      const lay = load(runFile(dd, v));
      const sk = stoneRecords(design(lay), im).filter((q) => q.ai && isSkinAi(q.ai));
      const row = {
        variant: v, changed: lay.stones.filter((q, k) => b.stones[k] && q[3] !== b.stones[k][3]).length, n: sk.length,
        de: r2(mean(sk.map((q) => q.de))), dL: r2(mean(sk.map((q) => L(q.color) - q.ai[0]))),
        smokedTopaz: sk.filter((q) => q.color === "smoked-topaz").length
      };
      all[dd.id].push(row);
      console.log("skin-all", dd.id, JSON.stringify(row));
    }
  }
  numbers.skinAll = all;
}

// ---- Rhinestone Studio's own outputs ---------------------------------------------------------

async function rsPart() {
  const out = {};
  for (const d of DESIGNS.filter((x) => x.rs)) {
    if (!hasRun(d, "default")) continue;
    const base = load(runFile(d, "default"));
    const area = eyeArea(base);
    if (!area) continue;
    const img = await decodeRgba(d.ai);
    const aiPng = await aiWindow(d.ai, base.report.mmPerPx, area.win);
    const panels = [];
    const rows = {};
    for (const [tag, des, render] of [
      ["RS prototype (expected)", rsExpected(d.rs), renderTintedBefore],
      ["RS 38cd831 service", rsService(d.rs), renderTintedBefore],
      ["IS default", design(base), renderTinted]
    ]) {
      const { plain, tinted } = await windowRenders(des, area.win, render);
      panels.push({ png: aiPng, label: `AI image · ${tag}` }, { png: plain, label: "plain" }, { png: tinted, label: tag.startsWith("RS") ? "RS tinted (85 %)" : "tinted" });
      const recs = stoneRecords(des, img).filter((q) => inEyes(area.eyes, q.x, q.y));
      rows[tag] = { eyeStones: recs.length, bySize: tally(recs.map((q) => q.d)), byClass: tally(recs.map((q) => classOf(CAT_LAB[q.color]))), byColour: tally(recs.map((q) => q.color)) };
      console.log("rs", d.id, tag, JSON.stringify(rows[tag]));
    }
    out[d.id] = { rows, file: await grid(panels, 3, 300, `rs-eyes-${d.run}.jpg`) };
  }
  numbers.rs = out;
}

// ---- section 5: the decisions applied ------------------------------------------------------------

const AFTER_IDS = ["rs-woman", "rs-portrait", "rs-einstein", "rs-jesus", "rs-dog", "cat-rule"];
const FACES = new Set(["rs-woman", "rs-portrait", "rs-einstein"]);

// Share of an eye area's pixels (inside the eye circles) darker than L* 20, on an RGBA image whose
// pixel (0, 0) is at frame mm (x0, y0) and `scale` px per mm; transparent pixels count as white.
function darkShare(img, x0, y0, scale, eyes) {
  let dark = 0, n = 0;
  for (const e of eyes) {
    for (let y = Math.floor((e.y - e.r - y0) * scale); y <= (e.y + e.r - y0) * scale; y++) {
      for (let x = Math.floor((e.x - e.r - x0) * scale); x <= (e.x + e.r - x0) * scale; x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        if (Math.hypot((x + 0.5) / scale + x0 - e.x, (y + 0.5) / scale + y0 - e.y) > e.r) continue;
        const p = (y * img.width + x) * 4, a = img.data[p + 3] / 255;
        const rgb = [0, 1, 2].map((k) => img.data[p + k] * a + 255 * (1 - a));
        dark += srgbToLab(rgb)[0] < 20;
        n++;
      }
    }
  }
  return n ? dark / n : null;
}

async function afterPart() {
  const byId = Object.fromEntries(ALL_DESIGNS.map((d) => [d.id, d]));
  const runOf = (d, v) => load(path.join(RUNS, `${d.run}.${v}.json`));
  const out = { eyes: {}, designs: [] };

  // Eyes: before and after, AI image | plain | tinted, and the eye-area numbers.
  for (const id of AFTER_IDS) {
    const d = byId[id];
    const lb = runOf(d, "before"), la = runOf(d, "default");
    const area = eyeArea(la);
    const img = await decodeRgba(d.ai);
    const aiPng = await aiWindow(d.ai, la.report.mmPerPx, area.win);
    const aiImg = await decodeRgba(aiPng);
    const panels = [];
    const rows = {};
    for (const [tag, layout, render] of [["before", lb, renderBefore], ["after", la, renderTinted]]) {
      const des = design(layout);
      const { plain, tinted } = await windowRenders(des, area.win, render);
      panels.push({ png: aiPng, label: `AI image · ${tag}` }, { png: plain, label: "plain" }, { png: tinted, label: `tinted · ${tag}` });
      const recs = stoneRecords(des, img).filter((q) => q.ai && inEyes(area.eyes, q.x, q.y));
      const m = await measure(layout, img, render);
      const off = layout.report.offsetMm;
      const inArea = m.filter((r) => inEyes(area.eyes, r.x + off[0], r.y + off[1]));
      rows[tag] = {
        eyeStones: recs.length, byClass: tally(recs.map((q) => classOf(CAT_LAB[q.color]))), byColour: tally(recs.map((q) => q.color)),
        deStone: r2(mean(inArea.map((r) => r.deB))), deRendered: r2(mean(inArea.map((r) => r.deC))),
        darkShare: r2(100 * darkShare(await decodeRgba(tinted), area.win.x, area.win.y, PX_PER_MM, area.eyes))
      };
    }
    rows.ai = { darkShare: r2(100 * darkShare(aiImg, area.win.x, area.win.y, PX_PER_MM, area.eyes)) };
    out.eyes[id] = { rows, file: await grid(panels, 3, 300, `after-eyes-${id}.jpg`) };
    console.log("after eyes", id, JSON.stringify(rows));
  }

  // The woman's face and neck: AI image, tinted before, tinted after.
  {
    const d = byId["rs-woman"];
    const ai = await aiWindow(d.ai, runOf(d, "default").report.mmPerPx, WOMAN_FACE, 8);
    const panels = [{ png: ai, label: "AI image" }];
    for (const [tag, v, render] of [["before", "before", renderBefore], ["after", "default", renderTinted]]) {
      const { tinted } = await windowRenders(design(runOf(d, v)), WOMAN_FACE, render, 8);
      panels.push({ png: tinted, label: `tinted · ${tag}` });
    }
    out.womanFile = await grid(panels, 3, 620, "after-skin-woman.jpg");
  }

  // Every design: what changed in the layout, and per-stone ΔE before and after.
  for (const d of ALL_DESIGNS) {
    const lb = runOf(d, "before"), la = runOf(d, "default");
    const geo = (l) => JSON.stringify(l.stones.map((q) => q.slice(0, 3)));
    const same = (k) => JSON.stringify(lb.report[k]) === JSON.stringify(la.report[k]);
    const img = await decodeRgba(d.ai);
    const sb = summary(await measure(lb, img, renderBefore));
    const sa = summary(await measure(la, img, renderTinted));
    // The renderer alone: the "default" layout drawn by both renderers, share of changed pixels.
    const { stoneLayout } = delivered(la);
    const [pb, pa] = await Promise.all([renderBefore, renderTinted].map(async (r) => decodeRgba(r(stoneLayout, { longSidePx: 900, background: "white" }).png)));
    let changedPx = 0;
    for (let p = 0; p < pa.data.length; p += 4) changedPx += pa.data[p] !== pb.data[p] || pa.data[p + 1] !== pb.data[p + 1] || pa.data[p + 2] !== pb.data[p + 2];
    const sizes = tally(stonesOfLayout(la).map((s) => s.d));
    const row = {
      id: d.id, face: la.report.face, stones: la.stones.length, geometry: geo(lb) === geo(la),
      facePupils: same("face") && same("pupilsMm") && same("pupilsAtMm"),
      colourChanges: la.stones.filter((q, i) => lb.stones[i] && q[3] !== lb.stones[i][3]).length,
      deStone: [r2(sb.b.mean), r2(sa.b.mean)], deRendered: [r2(sb.c.mean), r2(sa.c.mean)],
      rendererPx: r2((100 * changedPx) / (pa.data.length / 4)), ss4: sizes[1.5] || 0, aboveSs6: Object.entries(sizes).filter(([k]) => +k > 2).reduce((a, [, n]) => a + n, 0)
    };
    out.designs.push(row);
    console.log("after design", JSON.stringify(row));
  }
  numbers.after = out;
}

if (PARTS.includes("eyes")) await eyesPart();
if (PARTS.includes("skin")) await skinPart();
if (PARTS.includes("rs")) await rsPart();
if (PARTS.includes("after")) await afterPart();
writeFileSync(numbersFile, JSON.stringify(numbers, null, 1));
