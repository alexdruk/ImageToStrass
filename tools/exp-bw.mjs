// Experiment exp-holes, black & white (docs/exp-holes.md section 6; tools only, never used by the
// app): the old B&W design (the service's colours mapped by their catalogue fill's L*, no hole fill)
// against the new one (spec 7.5 and 7.6: hole fill, every stone read from the AI image), and the
// threshold study.
//
//   node tools/exp-bw.mjs MANIFEST.json OUT_DIR [THRESHOLD]
//
// MANIFEST as tools/exp-holes.mjs (only name, ai and layout are read; every item is made B&W).
// Writes OUT_DIR/bw-results.json, OUT_DIR/NAME-bw.jpg (AI image | plain old | tinted old | plain new
// | tinted new) and, for a design with a face (two pupils), OUT_DIR/NAME-bw-faces.jpg (the face at
// thresholds 45 to 65, tinted).
//
// Threshold study: for thresholds 40 to 70 in steps of 5, the share of "lone" stones (Jet among
// Crystal or the other way round: no neighbour within 0.5 mm of its colour, at least 3 neighbours),
// over the whole design and in the face box (from the pupils: 1.6 pupil distances to each side, 1.2
// above, 2.2 below the pupils' midpoint); and Otsu's threshold of the stones' lightness, the natural
// break between the AI's dark and light stones.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BW_THRESHOLD, mapBlackAndWhite } from "../src/pipeline/bw.js";
import { cleanedLayout, removeCloseStones } from "../src/pipeline/cleanup.js";
import { fillHoles, lightnessOnWhite } from "../src/pipeline/holes.js";
import { capStoneSizes, pupilCentres, stonesOfLayout } from "../src/pipeline/tiers.js";
import { aiPng, asLayout, plainPng, rgba, stack, strip, tintedPng } from "./exp-holes.mjs";

export const THRESHOLDS = Object.freeze([40, 45, 50, 55, 60, 65, 70]);
const FACE_THRESHOLDS = [45, 50, 55, 60, 65];
const NEIGHBOUR_GAP_MM = 0.5;

// Share of lone stones among those with at least 3 neighbours, over stones (optionally only those
// inside box). colours[i] is "dark" or "light".
function loneShare(stones, colours, box = null) {
  const cell = 5;
  const grid = new Map();
  stones.forEach((st, i) => {
    const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  let lone = 0, counted = 0;
  stones.forEach((st, i) => {
    if (box && (st.x < box.x0 || st.x > box.x1 || st.y < box.y0 || st.y > box.y1)) return;
    let n = 0, same = 0;
    const gx = Math.floor(st.x / cell), gy = Math.floor(st.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) || []) {
        if (j === i) continue;
        const o = stones[j];
        if (Math.hypot(o.x - st.x, o.y - st.y) - (o.d + st.d) / 2 >= NEIGHBOUR_GAP_MM) continue;
        n++;
        if (colours[j] === colours[i]) same++;
      }
    }
    if (n < 3) return;
    counted++;
    if (same === 0) lone++;
  });
  return counted ? lone / counted : 0;
}

// Otsu's threshold of a list of L* values (1 L* bins).
function otsu(values) {
  const hist = new Array(101).fill(0);
  for (const v of values) hist[Math.max(0, Math.min(100, Math.round(v)))]++;
  const total = values.length;
  let sumAll = 0;
  hist.forEach((h, i) => { sumAll += i * h; });
  let wB = 0, sumB = 0, best = 0, at = 0;
  for (let t = 0; t <= 100; t++) {
    wB += hist[t];
    if (!wB || wB === total) continue;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) ** 2;
    if (between > best) { best = between; at = t + 0.5; }
  }
  return at;
}

function faceBox(report) {
  const p = report?.pupilsAtMm;
  if (report?.face == null || !Array.isArray(p) || p.length !== 2) return null;
  const cx = (p[0][0] + p[1][0]) / 2, cy = (p[0][1] + p[1][1]) / 2;
  const dist = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
  return { x0: cx - 1.6 * dist, x1: cx + 1.6 * dist, y0: cy - 1.2 * dist, y1: cy + 2.2 * dist };
}

export async function runBw(item, outDir, base, threshold = DEFAULT_BW_THRESHOLD) {
  const at = (p) => path.resolve(base, p);
  const layout = JSON.parse(readFileSync(at(item.layout), "utf8"));
  if (layout.error) return { name: item.name, error: layout.error.message ?? String(layout.error) };
  const ai = await rgba(at(item.ai));
  const report = layout.report;
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const kept = removeCloseStones(capStoneSizes(stonesOfLayout(layout), pupilCentres(layout)).stones).stones;
  const filled = fillHoles(kept, ai, report).stones;

  // Old: the production before exp-holes (no fill, catalogue fills mapped). New: fill, image read.
  const oldNatural = cleanedLayout(layout);
  const oldStones = mapBlackAndWhite(asLayout(kept, "colour"), threshold);
  const newStones = asLayout(filled, "bw", ai, report, threshold);
  const L = filled.map((st) => lightnessOnWhite(ai, (st.x + ox) / s, (st.y + oy) / s, st.d, s));
  const keptL = L.slice(0, kept.length);
  let changed = 0;
  oldStones.stones.forEach((st, i) => { if ((st.color === "jet") !== (keptL[i] < threshold)) changed++; });

  const box = faceBox(report);
  const study = THRESHOLDS.map((t) => {
    const colours = L.map((v) => (v < t ? "dark" : "light"));
    return { threshold: t, jetShare: colours.filter((c) => c === "dark").length / colours.length, lone: loneShare(filled, colours), loneFace: box ? loneShare(filled, colours, box) : null };
  });
  const oldColours = oldStones.stones.map((st) => (st.color === "jet" ? "dark" : "light"));

  // Views.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of filled) { x0 = Math.min(x0, st.x - st.d); y0 = Math.min(y0, st.y - st.d); x1 = Math.max(x1, st.x + st.d); y1 = Math.max(y1, st.y + st.d); }
  const whole = { x0, y0, w: x1 - x0, h: y1 - y0 };
  const ppmm = 1200 / Math.max(whole.w, whole.h);
  const views = await strip(null, [
    { label: "AI image", png: await aiPng(at(item.ai), report, whole, ppmm) },
    { label: "plain, old", png: plainPng(oldStones, whole, ppmm) },
    { label: "tinted, old", png: await tintedPng(oldStones, whole, ppmm) },
    { label: `plain, new (${threshold})`, png: plainPng(newStones, whole, ppmm) },
    { label: `tinted, new (${threshold})`, png: await tintedPng(newStones, whole, ppmm) }
  ], 640);
  writeFileSync(path.join(outDir, `${item.name}-bw.jpg`), views);
  if (box) {
    const side = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const view = { x0: (box.x0 + box.x1) / 2 - side / 2, y0: (box.y0 + box.y1) / 2 - side / 2, w: side, h: side };
    const zp = 380 / side;
    const panels = [{ label: "AI image", png: await aiPng(at(item.ai), report, view, zp) }, { label: "old", png: await tintedPng(oldStones, view, zp) }];
    for (const t of FACE_THRESHOLDS) panels.push({ label: `new, ${t}`, png: await tintedPng(asLayout(filled, "bw", ai, report, t), view, zp) });
    await stack(path.join(outDir, `${item.name}-bw-faces.jpg`), [await strip(null, panels, 380)]);
  }
  const round = (v, p = 4) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);
  return {
    name: item.name,
    stones: { old: oldNatural.stoneLayout.count, new: filled.length },
    jetShare: { old: round(oldColours.filter((c) => c === "dark").length / oldColours.length), new: round(study.find((r) => r.threshold === threshold).jetShare) },
    changedOfKept: changed,
    lone: { old: round(loneShare(kept, oldColours)), oldFace: box ? round(loneShare(kept, oldColours, box)) : null },
    otsu: otsu(L),
    face: Boolean(box),
    study: study.map((r) => ({ threshold: r.threshold, jetShare: round(r.jetShare), lone: round(r.lone), loneFace: round(r.loneFace) }))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestFile, outDir, t] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const item of manifest) {
    const r = await runBw(item, outDir, path.dirname(path.resolve(manifestFile)), t ? Number(t) : DEFAULT_BW_THRESHOLD);
    results.push(r);
    console.log(item.name, r.error ? `error: ${r.error}` : `jet ${r.jetShare.old} -> ${r.jetShare.new}, changed ${r.changedOfKept}, otsu ${r.otsu}`);
  }
  writeFileSync(path.join(outDir, "bw-results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
