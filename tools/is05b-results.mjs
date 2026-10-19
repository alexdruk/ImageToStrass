// IS-05b images and numbers for docs/IS-05b-results.md, run by hand (no provider or strass call):
//   node tools/is05b-results.mjs <runs dir> [<earlier runs dir>]
// The IS-03b AI images are the fixtures in tools/fixtures/is03b-ai. <runs dir> holds the layouts of
// services/strass/scripts/is05b_runs.py (<name>.<variant>.json, <name>.stages.json);
// <earlier runs dir> the "default" layouts of the first IS-05b service (soft outlines on, no pupil
// pair kept of more than two), for the giraffe and the unchanged-design check. Images go to
// docs/IS-05b-results/; the numbers to docs/IS-05b-results/numbers.json for the hand-written
// results document. IS05B_PARTS picks the parts (comma-separated).
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
import { AI_DIR, ALL_DESIGNS, CAT_LAB, decodeRgba, delivered, layoutOf, measure, stageSummary, summary } from "./is05b-measure.mjs";
import { prepareDesign, renderTintedBefore, scoreRender } from "./is05b-tint.mjs";
import { deltaE2000, discLab, mean } from "./colour-diff.mjs";
import { Stone } from "../src/stones/Stone.js";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = path.join(ROOT, "docs/IS-05b-results");
const RS_IMG = path.join(ROOT, "services/strass/prototype/img");
const GAP = 10;
const LABEL_H = 34;

const [RUNS, EARLIER] = process.argv.slice(2);
if (!RUNS) throw new Error("usage: node tools/is05b-results.mjs <runs dir> [<earlier runs dir>]");
mkdirSync(OUT, { recursive: true });

// The six diagnosis designs: the saved layout the docs showed, and the AI image it was made from.
const DESIGNS = {
  portrait: { fixture: "layouts/portrait.json", ai: path.join(RS_IMG, "N2_portrait.png") },
  woman: { fixture: "layouts/woman.json", ai: path.join(RS_IMG, "N2_woman.png") },
  leopard: { fixture: "layouts/leopard.json", ai: path.join(RS_IMG, "N2_leopard.png") },
  car: { fixture: "is03b-rejected/car-rule.json", ai: path.join(AI_DIR, "car-rule-output.png") },
  dog: { fixture: "is03b/dog-rule.json", ai: path.join(AI_DIR, "dog-rule-output.png") },
  cat: { fixture: "is03b/cat-rule.json", ai: path.join(AI_DIR, "cat-rule-output.png") }
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
async function windowRenders(stoneLayout, win, pxPerMm, render = renderTinted) {
  const reach = 8;
  const near = stoneLayout.stones.filter((s) => s.xMm > win.minXmm - reach && s.xMm < win.minXmm + win.widthMm + reach &&
    s.yMm > win.minYmm - reach && s.yMm < win.minYmm + win.heightMm + reach);
  const sub = new StoneLayout({ layerId: "win", stones: near });
  const box = tintCanvasMm(sub);
  const tinted = render(sub, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
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
async function wholeRenders(stoneLayout, longSidePx, render = renderTinted) {
  const tinted = render(stoneLayout, { longSidePx, background: "white" });
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
async function renderer(render = renderTinted, key = "renderer") {
  const rows = [];
  for (const k of Object.keys(CAT_LAB)) {
    const stones = [];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) stones.push(new Stone({ xMm: c * 2.1 + (r % 2) * 1.05, yMm: r * 1.82, sizeMm: 2, color: k, layerId: "x", index: stones.length }));
    const sl = new StoneLayout({ layerId: "x", stones });
    const box = tintCanvasMm(sl);
    const rr = render(sl, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * 24), background: "white" });
    const img = await decodeRgba(rr.png);
    const at = (s, rad) => discLab(img, (s.xMm - box.minXmm) * rr.scale, (s.yMm - box.minYmm) * rr.scale, rad * rr.scale);
    const labs = stones.map((s) => at(s, 0.6));
    const stone = [0, 1, 2].map((j) => mean(labs.map((l) => l[j])));
    const cell = at(stones[14], 1.05);
    rows.push({ id: k, fillL: CAT_LAB[k][0], stoneL: stone[0], cellL: cell[0], deStone: deltaE2000(CAT_LAB[k], stone), deCell: deltaE2000(CAT_LAB[k], cell) });
  }
  numbers[key] = rows;
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

// ---- IS-05b follow-up (Alex's decisions of 19 Oct) ---------------------------------------------

// Item 3: the first-pick experiments of is05b_runs.py (rs with the first pick changed). Mean ΔE
// from the AI colour after the first pick and as assigned (b), and the first pick of the stones
// the service filled in (their colour is the nearest detection's) against the detected ones.
async function picks() {
  const out = {};
  for (const [name, d] of Object.entries(DESIGNS)) {
    const img = await decodeRgba(d.ai);
    const row = {};
    for (const v of ["rs", "rs-pick-nearest", "rs-pick-sample", "rs-pick-both"]) {
      const layout = run(name, v);
      const stages = JSON.parse(readFileSync(path.join(RUNS, v === "rs" ? `${name}.stages.json` : `${name}.${v}.stages.json`), "utf8"));
      const recs = await measure(layout, img);
      const first = stageSummary(recs, stages)[0];
      const de = (r) => deltaE2000(r.aiLab, CAT_LAB[stages.colours[r.layoutIndex][0]]);
      const filled = recs.filter((r) => stages.fill[r.layoutIndex]), detected = recs.filter((r) => !stages.fill[r.layoutIndex]);
      const m = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      row[v] = { a: summary(recs).a.mean, first: first.mean, b: summary(recs).b.mean, filled: filled.length, firstFilled: m(filled.map(de)), firstDetected: m(detected.map(de)) };
    }
    out[name] = row;
    console.log("picks", name, JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, x]) => [k, [x.first.toFixed(2), x.b.toFixed(2)]]))));
  }
  numbers.picks = out;
}

// Item 5: the giraffe's eyes with the RS rules (four pupils), the first IS-05b rule (no face) and
// now (the one plausible pair kept), all with today's renderer.
async function giraffeEyes() {
  const rs = fixture("is03b/giraffe-rule.json");
  const states = [["RS rules", rs], ["IS-05b, no face", JSON.parse(readFileSync(path.join(EARLIER, "giraffe-rule.default.json"), "utf8"))], ["now", run("giraffe-rule", "default")]];
  const eyes = run("giraffe-rule", "default").report.pupilsAtMm;
  const all = run("giraffe-rule", "rs").report.pupilsAtMm;
  const panels = [];
  for (const [tag, layout] of states) {
    const { stoneLayout, offset } = cappedLayout(layout, "pupils-ss20");
    const xs = eyes.map((p) => p[0]), ys = eyes.map((p) => p[1]);
    // Window around the two eyes (the stone coordinates of every run share the same crop).
    const win = { minXmm: Math.min(...xs) - 7 - offset.minX, minYmm: Math.min(...ys) - 7 - offset.minY, widthMm: Math.max(...xs) - Math.min(...xs) + 14, heightMm: Math.max(...ys) - Math.min(...ys) + 14 };
    const r = await windowRenders(stoneLayout, win, 20);
    panels.push({ png: r.plain, label: `${tag} · plain` }, { png: r.tinted, label: `${tag} · tinted` });
  }
  const now = run("giraffe-rule", "default");
  numbers.giraffeEyes = {
    file: await strip(panels, "giraffe-eyes.jpg"), candidates: all, candidateMm: run("giraffe-rule", "rs").report.pupilsMm,
    now: { face: now.report.face, pupilsMm: now.report.pupilsMm, pupilsAtMm: now.report.pupilsAtMm, stones: now.report.stones, violations: now.report.violations },
    capped: cleanedLayout(now).capped, removed: cleanedLayout(now).removed
  };
}

// Item 5: every design's new "default" layout against the first IS-05b service's (EARLIER, soft
// outlines on): stone positions and sizes, face and pupils must be identical except the giraffe;
// colours may differ only where soft_outlines acted (checked stone for stone on the six diagnosis
// designs against "rs-no-soft-outlines" of the RS rules, which differ from today's DEFAULT only by
// the eye rule; the car is left out because the eye rule changes it).
function unchanged() {
  const rows = [];
  for (const d of ALL_DESIGNS) {
    const now = run(d.run, "default");
    const before = JSON.parse(readFileSync(path.join(EARLIER, `${d.run}.default.json`), "utf8"));
    const geo = (l) => JSON.stringify(l.stones.map((q) => q.slice(0, 3)));
    const colours = now.stones.filter((q, i) => before.stones[i] && q[3] !== before.stones[i][3]).length;
    const row = { id: d.id, geometry: geo(now) === geo(before), face: now.report.face === before.report.face, pupils: JSON.stringify(now.report.pupilsMm) === JSON.stringify(before.report.pupilsMm),
      colourChanges: colours, faceNow: now.report.face, stones: now.stones.length, stonesBefore: before.stones.length };
    const ref = path.join(RUNS, "before", `${d.run}.rs-no-soft-outlines.json`);
    if (d.run !== "car" && existsSync(ref)) row.equalsRsNoSoftOutlines = JSON.stringify(JSON.parse(readFileSync(ref, "utf8")).stones) === JSON.stringify(now.stones);
    rows.push(row);
    console.log("unchanged", JSON.stringify(row));
  }
  numbers.unchanged = rows;
}

// Item 6: before (the saved RS-rules layout and the renderer before IS-05b) and after (today's
// service and renderer), plus "layout only" (today's layout, old renderer): images for six
// designs, per-stone ΔE for them, and the downsampled ΔE of tools/is05b-tint.mjs for all 21.
const BA = ["rs-woman", "rs-portrait", "rs-leopard", "car-rule", "giraffe-rule", "dog-rule"];
async function beforeAfter() {
  const per = {};
  for (const id of BA) {
    const d = ALL_DESIGNS.find((x) => x.id === id);
    const before = layoutOf(d), after = layoutOf(d, RUNS);
    const img = await decodeRgba(d.ai);
    const sb = summary(await measure(before, img, renderTintedBefore));
    const sl = summary(await measure(after, img, renderTintedBefore));
    const sa = summary(await measure(after, img));
    const panels = [{ png: await aiCrop(before, d.ai), label: "AI image" },
      { png: (await wholeRenders(delivered(before).stoneLayout, 900, renderTintedBefore)).tinted, label: "before" },
      { png: (await wholeRenders(delivered(after).stoneLayout, 900)).tinted, label: "after" }];
    per[id] = { file: await grid(panels, 3, 560, `ba-${id.replace(/^rs-|-rule$/g, "")}.jpg`), before: { a: sb.a, b: sb.b, c: sb.c, n: sb.n }, layoutOnly: { b: sl.b, c: sl.c, n: sl.n }, after: { a: sa.a, b: sa.b, c: sa.c, t: sa.t, n: sa.n } };
    console.log("ba", id, sb.c.mean.toFixed(2), "->", sa.c.mean.toFixed(2));
  }
  const cells = [];
  for (const d of ALL_DESIGNS) {
    const before = await prepareDesign(d, null), after = await prepareDesign(d, RUNS);
    cells.push({ id: d.id, before: await scoreRender(before, renderTintedBefore), layoutOnly: await scoreRender(after, renderTintedBefore), after: await scoreRender(after, renderTinted) });
    console.log("cells", JSON.stringify(cells.at(-1)));
  }
  numbers.beforeAfter = { stones: per, cells };
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
if (parts.includes("picks")) await picks();
if (parts.includes("giraffe-eyes")) await giraffeEyes();
if (parts.includes("unchanged")) unchanged();
if (parts.includes("before-after")) await beforeAfter();
if (parts.includes("renderer-before")) await renderer(renderTintedBefore, "renderer");
if (parts.includes("renderer-after")) await renderer(renderTinted, "rendererAfter");
writeFileSync(numbersFile, `${JSON.stringify(numbers, null, 1)}\n`);
