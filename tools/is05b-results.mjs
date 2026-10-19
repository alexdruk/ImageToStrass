// IS-05b images and numbers for docs/IS-05b-results.md, run by hand (no provider or strass call):
//   node tools/is05b-results.mjs <IS-03b work dir> <runs dir>
// <IS-03b work dir> holds the saved IS-03b provider outputs (<id>-output.png, see
// tools/measure-is03b.mjs); <runs dir> holds the layouts of services/strass/scripts/is05b_runs.py
// (<name>.<variant>.json, <name>.stages.json). Images go to docs/IS-05b-results/; the numbers are
// printed as JSON (docs/IS-05b-results/numbers.json) for the hand-written results document.
import { createCanvas } from "@napi-rs/canvas";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { cleanedLayout, removeCloseStones } from "../src/pipeline/cleanup.js";
import { capStoneSizes, pupilCentres, stonesOfLayout, toStoneLayout } from "../src/pipeline/tiers.js";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { getCrystalAppearance } from "../src/stones/CrystalAppearance.js";
import { drawCrystalStone } from "../src/stones/CrystalStoneRenderer.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { CAT_LAB, decodeRgba, delivered, measure, stageSummary, summary } from "./is05b-measure.mjs";
import { deltaE2000, discLab, mean } from "./colour-diff.mjs";
import { Stone } from "../src/stones/Stone.js";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = path.join(ROOT, "docs/IS-05b-results");
const RS_IMG = path.join(ROOT, "services/strass/prototype/img");
const GAP = 10;
const LABEL_H = 34;

const [WORK, RUNS] = process.argv.slice(2);
if (!WORK || !RUNS) throw new Error("usage: node tools/is05b-results.mjs <IS-03b work dir> <runs dir>");
mkdirSync(OUT, { recursive: true });

// The six diagnosis designs: the saved layout the docs showed, and the AI image it was made from.
const DESIGNS = {
  portrait: { fixture: "layouts/portrait.json", ai: path.join(RS_IMG, "N2_portrait.png") },
  woman: { fixture: "layouts/woman.json", ai: path.join(RS_IMG, "N2_woman.png") },
  leopard: { fixture: "layouts/leopard.json", ai: path.join(RS_IMG, "N2_leopard.png") },
  car: { fixture: "is03b-rejected/car-rule.json", ai: path.join(WORK, "car-rule-output.png") },
  dog: { fixture: "is03b/dog-rule.json", ai: path.join(WORK, "dog-rule-output.png") },
  cat: { fixture: "is03b/cat-rule.json", ai: path.join(WORK, "cat-rule-output.png") }
};
const fixture = (rel) => JSON.parse(readFileSync(path.join(ROOT, "tools/fixtures", rel), "utf8"));
const run = (name, variant) => JSON.parse(readFileSync(path.join(RUNS, `${name}.${variant}.json`), "utf8"));
const numbers = {};

// ---- drawing helpers ---------------------------------------------------------------------------

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

// Panels [{ png, label }] of one height side by side, each with a label above.
async function strip(panels, file) {
  const metas = await Promise.all(panels.map((p) => sharp(p.png).metadata()));
  const height = Math.max(...metas.map((m) => m.height)) + LABEL_H;
  const width = metas.reduce((a, m) => a + m.width, 0) + GAP * (panels.length - 1);
  const composite = [];
  let left = 0;
  panels.forEach((p, i) => {
    composite.push({ input: label(p.label, metas[i].width), left, top: 0 });
    composite.push({ input: p.png, left, top: LABEL_H });
    left += metas[i].width + GAP;
  });
  await sharp({ create: { width, height, channels: 3, background: "#e6e9ef" } }).composite(composite)
    .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(OUT, file));
  return file;
}

// A window { minXmm, minYmm, widthMm, heightMm } of a StoneLayout, rendered plain and tinted at
// pxPerMm from the stones near it only (exact: a pixel's tint depends on stones within 3 mm).
async function windowRenders(stoneLayout, win, pxPerMm) {
  const reach = 8;
  const near = stoneLayout.stones.filter((s) => s.xMm > win.minXmm - reach && s.xMm < win.minXmm + win.widthMm + reach &&
    s.yMm > win.minYmm - reach && s.yMm < win.minYmm + win.heightMm + reach);
  const sub = new StoneLayout({ layerId: "win", stones: near });
  const box = tintCanvasMm(sub);
  const tinted = renderTinted(sub, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
  const plain = renderPlain(sub, box, tinted.scale);
  const extract = {
    left: Math.max(0, Math.round((win.minXmm - box.minXmm) * tinted.scale)), top: Math.max(0, Math.round((win.minYmm - box.minYmm) * tinted.scale)),
    width: Math.round(win.widthMm * tinted.scale), height: Math.round(win.heightMm * tinted.scale)
  };
  extract.width = Math.min(extract.width, tinted.widthPx - extract.left);
  extract.height = Math.min(extract.height, tinted.heightPx - extract.top);
  const [p, t] = await Promise.all([plain, tinted.png].map((png) => sharp(png).extract(extract).png().toBuffer()));
  return { plain: p, tinted: t };
}

// Whole design, plain and tinted, long side px.
async function wholeRenders(stoneLayout, longSidePx) {
  const tinted = renderTinted(stoneLayout, { longSidePx, background: "white" });
  return { plain: renderPlain(stoneLayout, tintCanvasMm(stoneLayout), tinted.scale), tinted: tinted.png, height: tinted.heightPx };
}

// The stone list of a layout at natural size, with a size cap: "none", "ss16" (today) or
// "pupils-ss20" (IS-05b: the reported pupils of a face may stay SS20).
function cappedLayout(layout, cap) {
  const measured = stonesOfLayout(layout);
  let stones = measured;
  if (cap === "ss16") stones = capStoneSizes(measured).stones;
  if (cap === "pupils-ss20") stones = capStoneSizes(measured, pupilCentres(layout)).stones;
  const { stones: kept, removed } = removeCloseStones(stones);
  return { stoneLayout: toStoneLayout(kept, 1).stoneLayout, removed: removed.length, offset: offsetOf(stones) };
}
function offsetOf(stones) {
  let minX = Infinity, minY = Infinity;
  for (const s of stones) { minX = Math.min(minX, s.x - s.d / 2); minY = Math.min(minY, s.y - s.d / 2); }
  return { minX, minY };
}

// ---- 3. eyes ----------------------------------------------------------------------------------

async function eyes() {
  const out = [];
  for (const name of ["woman", "portrait", "dog"]) {
    const layout = run(name, "default");
    const big = stonesOfLayout(layout).filter((s) => s.d > 2.0).sort((a, b) => b.d - a.d).slice(0, 2);
    const pad = 6;
    const panels = [];
    const sizes = {};
    let win;
    for (const cap of ["none", "pupils-ss20", "ss16"]) {
      const { stoneLayout, removed, offset } = cappedLayout(layout, cap);
      const [a, b] = big.map((s) => ({ x: s.x - offset.minX, y: s.y - offset.minY }));
      win = { minXmm: Math.min(a.x, b.x) - pad - 2, minYmm: Math.min(a.y, b.y) - pad, widthMm: Math.abs(a.x - b.x) + 2 * pad + 4, heightMm: Math.abs(a.y - b.y) + 2 * pad };
      const r = await windowRenders(stoneLayout, win, 30);
      const pupilSize = stoneLayout.stones.filter((s) => s.sizeMm > 2.0).map((s) => s.sizeMm);
      sizes[cap] = { pupilsMm: pupilSize, removed };
      const tag = { none: "(a) no cap", "pupils-ss20": "pupils SS20", ss16: "(b) SS16 cap" }[cap];
      panels.push({ png: r.plain, label: `${tag} · plain` }, { png: r.tinted, label: `${tag} · tinted` });
    }
    const file = await strip(panels.slice(0, 2).concat(panels.slice(4, 6)), `eyes-${name}.jpg`);
    const file20 = await strip(panels.slice(2, 4), `eyes-${name}-ss20.jpg`);
    out.push({ name, file, file20, sizes, pupilsMm: layout.report.pupilsMm, win });
  }
  numbers.eyes = out;
}

// Panels [{ png, label }] in a grid of `cols` columns, every cell scaled to cellH px high.
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
    .jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, file));
  return file;
}

// The AI image cropped to the stones' box (frame mm = stone mm + offsetMm), for side-by-side panels.
async function aiCrop(layout, ai) {
  const s = layout.report.mmPerPx;
  const [ox, oy] = layout.report.offsetMm;
  const meta = await sharp(ai).metadata();
  const left = Math.max(0, Math.round(ox / s)), top = Math.max(0, Math.round(oy / s));
  const width = Math.min(meta.width - left, Math.round(layout.widthMm / s)), height = Math.min(meta.height - top, Math.round(layout.heightMm / s));
  return sharp(ai).extract({ left, top, width, height }).flatten({ background: "#ffffff" }).png().toBuffer();
}

const keyOf = (st) => `${st[0]},${st[1]}`;
function colourChanges(a, b) {
  const map = new Map(a.stones.map((st) => [keyOf(st), st[3]]));
  let same = 0, changed = 0;
  for (const st of b.stones) {
    if (!map.has(keyOf(st))) continue;
    same++;
    if (map.get(keyOf(st)) !== st[3]) changed++;
  }
  return { matched: same, changed, stones: b.stones.length };
}

// ---- 2. colours -------------------------------------------------------------------------------

const RULE_VARIANTS = ["rs-no-extra-colours", "rs-no-mean-colour", "rs-no-real-colours", "rs-no-more-colours",
  "rs-no-skin-no-wine", "rs-no-soft-outlines", "rs-no-calm-skin", "rs-no-skin-nearest", "rs-no-colour-rules"];
const EXTRA_VARIANTS = (process.env.IS05B_PICKS || "").split(",").filter(Boolean);

async function colours() {
  const out = {};
  for (const [name, d] of Object.entries(DESIGNS)) {
    const img = await decodeRgba(d.ai);
    const base = run(name, "rs");
    const stages = JSON.parse(readFileSync(path.join(RUNS, `${name}.stages.json`), "utf8"));
    const recs = await measure(base, img);
    const entry = { summary: summary(recs), stages: stageSummary(recs, stages), variants: {} };
    const panels = [{ png: await aiCrop(base, d.ai), label: "AI image" }];
    const whole = await wholeRenders(delivered(base).stoneLayout, 900);
    panels.push({ png: whole.tinted, label: "RS rules (today)" });
    for (const v of [...RULE_VARIANTS, ...EXTRA_VARIANTS]) {
      if (!existsSync(path.join(RUNS, `${name}.${v}.json`))) continue;
      const layout = run(name, v);
      const ch = colourChanges(base, layout);
      const same = ch.changed === 0 && ch.matched === base.stones.length && layout.stones.length === base.stones.length;
      const s = same ? entry.summary : summary(await measure(layout, img));
      entry.variants[v] = { ...ch, same, b: s.b, c: s.c, n: s.n };
      if (!same) panels.push({ png: (await wholeRenders(delivered(layout).stoneLayout, 900)).tinted, label: v.replace(/^rs-/, "") });
    }
    entry.file = await grid(panels, 4, 520, `colours-${name}.jpg`);
    out[name] = entry;
    console.log(name, JSON.stringify(entry.summary.b), Object.entries(entry.variants).map(([v, x]) => `${v} ${x.same ? "same" : x.b.mean.toFixed(2) + "/" + x.c.mean.toFixed(2)}`).join("; "));
  }
  numbers.colours = out;
}

// ---- 4. car wheels and the face rule ----------------------------------------------------------

// Groups of reported pupils split where the x gap exceeds 40 mm (one group per wheel).
function clusters(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const groups = [[sorted[0]]];
  for (const p of sorted.slice(1)) {
    if (p[0] - groups.at(-1).at(-1)[0] > 40) groups.push([p]);
    else groups.at(-1).push(p);
  }
  return groups;
}

async function car() {
  const before = run("car", "rs");
  const after = run("car", "default");
  const cb = cleanedLayout(before), ca = cleanedLayout(after);
  // The wheels: the pupils in the lower half (the others sit on the windows and the roof).
  const groups = clusters(before.report.pupilsAtMm.filter((p) => p[1] > before.heightMm / 2));
  const wheels = [];
  for (const [k, g] of groups.entries()) {
    const xs = g.map((p) => p[0]), ys = g.map((p) => p[1]);
    const pad = 7;
    const panels = [];
    for (const [tag, layout] of [["before", before], ["after", after]]) {
      const { stoneLayout, offset } = cappedLayout(layout, "pupils-ss20");
      const win = { minXmm: Math.min(...xs) - pad - offset.minX, minYmm: Math.min(...ys) - pad - offset.minY,
        widthMm: Math.max(...xs) - Math.min(...xs) + 2 * pad, heightMm: Math.max(...ys) - Math.min(...ys) + 2 * pad };
      const r = await windowRenders(stoneLayout, win, 14);
      panels.push({ png: r.plain, label: `${tag} · plain` }, { png: r.tinted, label: `${tag} · tinted` });
    }
    wheels.push(await strip(panels, `car-wheel-${k + 1}.jpg`));
  }
  const img = await decodeRgba(DESIGNS.car.ai);
  const whole = [{ png: await aiCrop(before, DESIGNS.car.ai), label: "AI image" }];
  for (const [tag, layout] of [["before", before], ["after", after]]) {
    whole.push({ png: (await wholeRenders(delivered(layout).stoneLayout, 1100)).tinted, label: `${tag} · tinted` });
  }
  const pick = (c) => ({ stones: c.stoneLayout.count, removed: c.removed, removedShare: c.removedShare, coverage: c.coverage, gapsOk: c.gaps.ok, capped: c.capped });
  numbers.car = {
    wheels, whole: await grid(whole, 1, 300, "car-whole.jpg"),
    before: { report: { stones: before.report.stones, violations: before.report.violations, face: before.report.face, pupils: before.report.pupilsMm.length, coverage: before.report.coverage }, ...pick(cb), colour: summary(await measure(before, img)) },
    after: { report: { stones: after.report.stones, violations: after.report.violations, face: after.report.face, pupils: after.report.pupilsMm.length, coverage: after.report.coverage }, ...pick(ca), colour: summary(await measure(after, img)) }
  };
  console.log("car", JSON.stringify({ before: pick(cb), after: pick(ca) }));
}

// Is the "default" layout (with plausible_eyes) identical, stone for stone, to the RS rules' one:
// the "rs" run when there is one, else the saved fixture (a re-run of the RS rules reproduces it
// exactly). Names: the diagnosis designs, "rs-<image>" for the RS test layouts and the IS-03b ids.
const FIXTURE_OF = (name) => (name.startsWith("rs-") ? `layouts/${name.slice(3)}.json` : name === "car-rule" ? "is03b-rejected/car-rule.json" : `is03b/${name}.json`);
function faceRuleCheck() {
  const rows = [];
  const names = [...Object.keys(DESIGNS), ...(process.env.IS05B_CHECK || "").split(",").filter(Boolean)];
  for (const name of names) {
    if (!existsSync(path.join(RUNS, `${name}.default.json`))) continue;
    const a = run(name, "default");
    const ref = existsSync(path.join(RUNS, `${name}.rs.json`)) ? run(name, "rs") : fixture(FIXTURE_OF(name));
    rows.push({ name, identical: JSON.stringify(a.stones) === JSON.stringify(ref.stones), stones: a.stones.length, refStones: ref.stones.length,
      face: a.report.face, refFace: ref.report.face, pupils: a.report.pupilsMm, refPupils: ref.report.pupilsMm });
  }
  numbers.faceRule = rows;
  for (const r of rows) console.log("face rule", JSON.stringify(r));
}

// Renderer fidelity: a hex patch of 36 SS6 stones per catalogue colour, rendered tinted at 24 px per
// mm; ΔE2000 from the fill to the mean of the stones' inner 60 % discs (as (c) samples) and to the
// whole cell around the middle stone (stone + tint, radius 1.05 mm).
async function renderer() {
  const rows = [];
  for (const k of Object.keys(CAT_LAB)) {
    const stones = [];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) stones.push(new Stone({ xMm: c * 2.1 + (r % 2) * 1.05, yMm: r * 1.82, sizeMm: 2, color: k, layerId: "x", index: stones.length }));
    const sl = new StoneLayout({ layerId: "x", stones });
    const box = tintCanvasMm(sl);
    const rr = renderTinted(sl, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * 24), background: "white" });
    const img = await decodeRgba(rr.png);
    const at = (s, rad) => discLab(img, (s.xMm - box.minXmm) * rr.scale, (s.yMm - box.minYmm) * rr.scale, rad * rr.scale);
    const labs = stones.map((s) => at(s, 0.6));
    const stone = [0, 1, 2].map((j) => mean(labs.map((l) => l[j])));
    const cell = at(stones[14], 1.05);
    rows.push({ id: k, fillL: CAT_LAB[k][0], stoneL: stone[0], cellL: cell[0], deStone: deltaE2000(CAT_LAB[k], stone), deCell: deltaE2000(CAT_LAB[k], cell) });
  }
  numbers.renderer = rows;
}

// The 10 most frequent changes from the nearest catalogue colour (a) to the service's first pick
// (stage "start"), per design.
async function firstPick() {
  const out = {};
  for (const [name, d] of Object.entries(DESIGNS)) {
    const base = run(name, "rs");
    const stages = JSON.parse(readFileSync(path.join(RUNS, `${name}.stages.json`), "utf8"));
    const recs = await measure(base, d.ai);
    const m = new Map();
    for (const r of recs) {
      const start = stages.colours[r.layoutIndex][0];
      if (start !== r.nearest) m.set(`${r.nearest} → ${start}`, (m.get(`${r.nearest} → ${start}`) || 0) + 1);
    }
    out[name] = { changed: [...m.values()].reduce((a, b) => a + b, 0), n: recs.length, top: [...m].sort((a, b) => b[1] - a[1]).slice(0, 10) };
  }
  numbers.firstPick = out;
}

// The giraffe (IS-03b, four pupils): before (saved layout) and after (default) around its head.
async function giraffe() {
  const before = fixture("is03b/giraffe-rule.json");
  const after = run("giraffe-rule", "default");
  const big = stonesOfLayout(before).filter((s) => s.d > 2.0);
  const xs = big.map((s) => s.x), ys = big.map((s) => s.y);
  const panels = [];
  for (const [tag, layout] of [["before", before], ["after", after]]) {
    const { stoneLayout, offset } = cappedLayout(layout, "pupils-ss20");
    const win = { minXmm: Math.min(...xs) - 8 - offset.minX, minYmm: Math.min(...ys) - 8 - offset.minY,
      widthMm: Math.max(...xs) - Math.min(...xs) + 16, heightMm: Math.max(...ys) - Math.min(...ys) + 16 };
    const r = await windowRenders(stoneLayout, win, 14);
    panels.push({ png: r.plain, label: `${tag} · plain` }, { png: r.tinted, label: `${tag} · tinted` });
  }
  numbers.giraffe = { file: await strip(panels, "giraffe-head.jpg"), pupilsBefore: before.report.pupilsMm, bigStones: big.map((s) => [s.x, s.y, s.d]) };
}

const parts = (process.env.IS05B_PARTS || "eyes,colours,car,check").split(",");
const numbersFile = path.join(OUT, "numbers.json");
if (existsSync(numbersFile)) Object.assign(numbers, JSON.parse(readFileSync(numbersFile, "utf8")));
if (parts.includes("eyes")) await eyes();
if (parts.includes("colours")) await colours();
if (parts.includes("car")) await car();
if (parts.includes("check")) faceRuleCheck();
if (parts.includes("renderer")) await renderer();
if (parts.includes("giraffe")) await giraffe();
if (parts.includes("firstpick")) await firstPick();
writeFileSync(numbersFile, `${JSON.stringify(numbers, null, 1)}\n`);
