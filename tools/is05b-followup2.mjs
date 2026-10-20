// IS-05b second follow-up (Alex's decisions of 20 Oct 2026), images and numbers for
// docs/IS-05b-results.md section 7, run by hand (no provider or strass call):
//   node tools/is05b-followup2.mjs <runs dir>
// <runs dir> holds services/strass/scripts/is05b_runs.py's "default-no-sample" (colours read at the
// detections, the rules before this round) and "default" (colours read at the delivered stones)
// layouts of the 21 designs. Images go to docs/IS-05b-results/, numbers to
// docs/IS-05b-results/numbers-2.json. IS05B_PARTS picks the parts (comma-separated):
//   unchanged  geometry, faces and pupils of the two layouts, and how many colours changed;
//   colour     per-stone and downsampled ΔE of the 21 designs: before (no-sample layout, the
//              renderer before this round), sampling only (new layout, same renderer), after (new
//              layout, today's renderer);
//   images     car, dog, portrait, woman: AI image, plain and tinted before and after the sampling
//              change (both tinted with today's renderer);
//   eyes       portrait and woman eye close-ups, the stone lightness step before and after;
//   mug        the mug, the near-white gap step before and after (whole and close-up);
//   renderer   per catalogue colour: inner 60 % and whole-stone L*, facet spread, before and after.
import { createCanvas } from "@napi-rs/canvas";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { GAP_RULE, renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { getCrystalAppearance } from "../src/stones/CrystalAppearance.js";
import { drawCrystalStone } from "../src/stones/CrystalStoneRenderer.js";
import { Stone } from "../src/stones/Stone.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { srgbToLab } from "./colour-diff.mjs";
import { ALL_DESIGNS, decodeRgba, delivered, layoutOf, measure, summary } from "./is05b-measure.mjs";
import { prepareDesign, scoreRender } from "./is05b-tint.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = path.join(ROOT, "docs/IS-05b-results");
const RUNS = process.argv[2];
if (!RUNS) throw new Error("usage: node tools/is05b-followup2.mjs <runs dir>");
const BEFORE = "default-no-sample", AFTER = "default";
const GAP = 10, LABEL_H = 34;

// The renderer before this round: gaps 4 L* (+0.05 above L* 80) only, the whole stone's mean L*
// only. And the two halves of today's change, for the close-ups.
const GAP_BEFORE = { minStep: 4, slope: 0.05, fromL: 80, darkBelow: 0 };
const WHOLE_ONLY = { whole: 2, inner: null };
const renderBefore = (sl, o) => renderTinted(sl, { ...o, rule: GAP_BEFORE, stoneLightness: WHOLE_ONLY });
const renderOldStones = (sl, o) => renderTinted(sl, { ...o, stoneLightness: WHOLE_ONLY });
const renderOldGaps = (sl, o) => renderTinted(sl, { ...o, rule: GAP_BEFORE });

const numbersFile = path.join(OUT, "numbers-2.json");
const numbers = existsSync(numbersFile) ? JSON.parse(readFileSync(numbersFile, "utf8")) : {};
const design = (id) => ALL_DESIGNS.find((d) => d.id === id);
const run = (d, variant) => layoutOf(d, RUNS, variant);

// ---- drawing ---------------------------------------------------------------------------------

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

async function aiCrop(layout, ai) {
  const s = layout.report.mmPerPx;
  const [ox, oy] = layout.report.offsetMm;
  const meta = await sharp(ai).metadata();
  const left = Math.max(0, Math.round(ox / s)), top = Math.max(0, Math.round(oy / s));
  const width = Math.min(meta.width - left, Math.round(layout.widthMm / s)), height = Math.min(meta.height - top, Math.round(layout.heightMm / s));
  return sharp(ai).extract({ left, top, width, height }).flatten({ background: "#ffffff" }).png().toBuffer();
}

// A window of a StoneLayout, plain and tinted at pxPerMm, from the stones near it (exact).
async function windowRenders(stoneLayout, win, pxPerMm, render) {
  const reach = 8;
  const near = stoneLayout.stones.filter((s) => s.xMm > win.minXmm - reach && s.xMm < win.minXmm + win.widthMm + reach &&
    s.yMm > win.minYmm - reach && s.yMm < win.minYmm + win.heightMm + reach);
  const sub = new StoneLayout({ layerId: "win", stones: near });
  const box = tintCanvasMm(sub);
  const tinted = render(sub, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
  const extract = {
    left: Math.max(0, Math.round((win.minXmm - box.minXmm) * tinted.scale)), top: Math.max(0, Math.round((win.minYmm - box.minYmm) * tinted.scale)),
    width: Math.round(win.widthMm * tinted.scale), height: Math.round(win.heightMm * tinted.scale)
  };
  extract.width = Math.min(extract.width, tinted.widthPx - extract.left);
  extract.height = Math.min(extract.height, tinted.heightPx - extract.top);
  const [p, t] = await Promise.all([renderPlain(sub, box, tinted.scale), tinted.png].map((png) => sharp(png).extract(extract).png().toBuffer()));
  return { plain: p, tinted: t };
}

// ---- parts -------------------------------------------------------------------------------------

function unchanged() {
  const rows = [];
  for (const d of ALL_DESIGNS) {
    const a = run(d, BEFORE), b = run(d, AFTER);
    const geo = (l) => JSON.stringify(l.stones.map((q) => q.slice(0, 3)));
    const same = (k) => JSON.stringify(a.report[k]) === JSON.stringify(b.report[k]);
    const row = {
      id: d.id, stones: b.stones.length, geometry: geo(a) === geo(b), face: same("face"), pupils: same("pupilsMm") && same("pupilsAtMm"),
      report: ["bySize", "violations", "coverage", "minGapMm", "largestEmptyCircleMm"].every(same),
      colourChanges: b.stones.filter((q, i) => a.stones[i] && q[3] !== a.stones[i][3]).length
    };
    rows.push(row);
    console.log("unchanged", JSON.stringify(row));
  }
  numbers.unchanged = rows;
}

async function colour() {
  const rows = [];
  for (const d of ALL_DESIGNS) {
    const img = await decodeRgba(d.ai);
    const lb = run(d, BEFORE), la = run(d, AFTER);
    const sb = summary(await measure(lb, img, renderBefore));
    const ss = summary(await measure(la, img, renderBefore));
    const sa = summary(await measure(la, img));
    const pb = await prepareDesign(d, RUNS, BEFORE), pa = await prepareDesign(d, RUNS, AFTER);
    const row = {
      id: d.id, n: sa.n,
      stones: { a: sa.a.mean, b: [sb.b.mean, sa.b.mean], c: [sb.c.mean, ss.c.mean, sa.c.mean], cP90: [sb.c.p90, ss.c.p90, sa.c.p90], changed: [sb.changed, sa.changed] },
      cells: { before: await scoreRender(pb, renderBefore), sampling: await scoreRender(pa, renderBefore), after: await scoreRender(pa, renderTinted) }
    };
    rows.push(row);
    console.log("colour", d.id, JSON.stringify({ b: row.stones.b.map((x) => +x.toFixed(2)), c: row.stones.c.map((x) => +x.toFixed(2)),
      cells: [row.cells.before.stones, row.cells.sampling.stones, row.cells.after.stones].map((x) => +x.toFixed(2)) }));
  }
  numbers.colour = rows;
}

async function images() {
  const out = {};
  for (const id of ["car-rule", "dog-rule", "rs-portrait", "rs-woman"]) {
    const d = design(id);
    const lb = run(d, BEFORE), la = run(d, AFTER);
    // Two rows, before above after: AI image, plain, tinted.
    const ai = await aiCrop(la, d.ai);
    const panels = [];
    for (const [tag, layout] of [["before", lb], ["after", la]]) {
      const { stoneLayout } = delivered(layout);
      const tinted = renderTinted(stoneLayout, { longSidePx: 900, background: "white" });
      panels.push({ png: ai, label: "AI image" }, { png: renderPlain(stoneLayout, tintCanvasMm(stoneLayout), tinted.scale), label: `${tag} · plain` },
        { png: tinted.png, label: `${tag} · tinted` });
    }
    out[id] = await grid(panels, 3, 520, `sample-${id.replace(/^rs-|-rule$/g, "")}.jpg`);
  }
  numbers.images = out;
}

// The eye window: the two pupils (the two largest stones) plus 6 mm.
function eyeWindow(stoneLayout) {
  const [a, b] = [...stoneLayout.stones].sort((s, t) => t.sizeMm - s.sizeMm);
  const pad = 6;
  return { minXmm: Math.min(a.xMm, b.xMm) - pad - 2, minYmm: Math.min(a.yMm, b.yMm) - pad, widthMm: Math.abs(a.xMm - b.xMm) + 2 * pad + 4, heightMm: Math.abs(a.yMm - b.yMm) + 2 * pad };
}

async function eyes() {
  const out = {};
  for (const id of ["rs-portrait", "rs-woman"]) {
    const { stoneLayout } = delivered(run(design(id), AFTER));
    const win = eyeWindow(stoneLayout);
    const before = await windowRenders(stoneLayout, win, 30, renderOldStones);
    const after = await windowRenders(stoneLayout, win, 30, renderTinted);
    out[id] = { file: await grid([{ png: before.plain, label: "plain" }, { png: before.tinted, label: "tinted, before" }, { png: after.tinted, label: "tinted, after" }],
      3, 420, `eyes2-${id.slice(3)}.jpg`), win };
  }
  numbers.eyes = out;
}

async function mug() {
  const d = design("mug-rule");
  const { stoneLayout } = delivered(run(d, AFTER));
  const whole = [{ png: await aiCrop(run(d, AFTER), d.ai), label: "AI image" }];
  for (const [tag, render] of [["before", renderOldGaps], ["after", renderTinted]]) {
    whole.push({ png: render(stoneLayout, { longSidePx: 900, background: "white" }).png, label: `${tag} · tinted` });
  }
  // A close-up where crystal / silver stones are most common: the 16 mm square around the stone with
  // the most near-white neighbours.
  const light = new Set(Object.keys(STONE_COLORS).filter((k) => srgbToLab(hexRgb(STONE_COLORS[k].fill))[0] > 85));
  let best = null, bestN = -1;
  for (const s of stoneLayout.stones) {
    if (!light.has(s.color)) continue;
    const n = stoneLayout.stones.filter((t) => light.has(t.color) && Math.abs(t.xMm - s.xMm) < 8 && Math.abs(t.yMm - s.yMm) < 8).length;
    if (n > bestN) { best = s; bestN = n; }
  }
  const win = { minXmm: best.xMm - 8, minYmm: best.yMm - 8, widthMm: 16, heightMm: 16 };
  const zb = await windowRenders(stoneLayout, win, 30, renderOldGaps), za = await windowRenders(stoneLayout, win, 30, renderTinted);
  numbers.mug = {
    whole: await grid(whole, 3, 560, "mug-gaps.jpg"),
    close: await grid([{ png: zb.plain, label: "plain" }, { png: zb.tinted, label: "tinted, before" }, { png: za.tinted, label: "tinted, after" }], 3, 480, "mug-gaps-close.jpg"),
    lightStones: stoneLayout.stones.filter((s) => light.has(s.color)).length, stones: stoneLayout.count, win
  };
}
const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16));

// Per catalogue colour, a patch of 36 SS6 stones at 16 px per mm: mean L* of the inner 60 % and of
// the whole disc (pixels whose centre lies inside), the largest stone's deviation of each, and
// the facet spread (5th to 95th percentile L* inside a stone, mean over the stones).
async function renderer() {
  const rows = [];
  for (const [id, c] of Object.entries(STONE_COLORS)) {
    const stones = [];
    for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) stones.push(new Stone({ xMm: k * 2.1 + (r % 2) * 1.05, yMm: r * 1.82, sizeMm: 2, color: id, layerId: "x", index: stones.length }));
    const sl = new StoneLayout({ layerId: "x", stones });
    const box = tintCanvasMm(sl);
    const fill = srgbToLab(hexRgb(c.fill))[0];
    const row = { id, fill };
    for (const [tag, render] of [["before", renderOldStones], ["after", renderTinted]]) {
      const rr = render(sl, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * 16), background: "white" });
      const img = await decodeRgba(rr.png);
      const acc = { inner: 0, whole: 0, maxInner: 0, maxWhole: 0, spread: 0 };
      for (const s of stones) {
        const cx = (s.xMm - box.minXmm) * rr.scale, cy = (s.yMm - box.minYmm) * rr.scale, R = rr.scale;
        const all = [], inner = [];
        for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
          const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
          if (d2 > R * R) continue;
          const p = (y * img.width + x) * 4;
          all.push(srgbToLab([img.data[p], img.data[p + 1], img.data[p + 2]])[0]);
          if (d2 <= (0.6 * R) ** 2) inner.push(all.at(-1));
        }
        const m = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
        acc.inner += m(inner) / stones.length;
        acc.whole += m(all) / stones.length;
        acc.maxInner = Math.max(acc.maxInner, Math.abs(m(inner) - fill));
        acc.maxWhole = Math.max(acc.maxWhole, Math.abs(m(all) - fill));
        all.sort((a, b) => a - b);
        acc.spread += (all[Math.floor(all.length * 0.95)] - all[Math.floor(all.length * 0.05)]) / stones.length;
      }
      row[tag] = acc;
    }
    rows.push(row);
  }
  numbers.renderer = rows.sort((a, b) => a.fill - b.fill);
  numbers.gapRule = { before: GAP_BEFORE, after: GAP_RULE };
}

const parts = (process.env.IS05B_PARTS || "unchanged,colour,images,eyes,mug,renderer").split(",");
if (parts.includes("unchanged")) unchanged();
if (parts.includes("colour")) await colour();
if (parts.includes("images")) await images();
if (parts.includes("eyes")) await eyes();
if (parts.includes("mug")) await mug();
if (parts.includes("renderer")) await renderer();
writeFileSync(numbersFile, `${JSON.stringify(numbers, null, 1)}\n`);
