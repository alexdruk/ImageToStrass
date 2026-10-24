// Experiment exp-holes, dark spots (docs/exp-holes.md section 9; tools only, never used by the app).
// For each design and mode, the delivered stones as the pipeline makes them (cap, cleanup, hole fill;
// B&W read from the AI image) are coloured three ways:
//   A "pixels"      the IS hole fill's stones read the pixels under them (before the fix);
//   B "neighbours"  they take their neighbours' colour (spec 7.5, the pipeline);
//   C "service"     B, and the service's own fill stones (report.fillAtMm) too
//                   (IS_SERVICE_FILL_NEIGHBOURS=1).
// Stones are split into classes: "is" (the IS fill's), "service" (the service's fills') and "other".
// Per variant and class: lone stones (no neighbour within 0.5 mm of the same colour), and in B&W Jet
// stones with mostly Crystal neighbours ("dark among light", at least 3 neighbours, more than half
// Crystal) and the reverse; for A also the mean lightness read for the class and its neighbours.
//
//   node tools/exp-spots.mjs MANIFEST.json OUT_DIR [MODES]
//
// MODES: "own" (each item's mode, default) or "both" (colour and B&W for every item). Writes
// OUT_DIR/spots-results.json and OUT_DIR/NAME[-bw]-spots.jpg: the three worst groups of A's spots
// (fill stones that are lone in colour, dark among light in B&W): AI image | plain A, spots ringed
// (magenta IS fill, cyan service fill) | tinted A | tinted B | tinted C; and for B&W
// OUT_DIR/NAME[-bw]-remaining.jpg: the densest dark spots left in B, of any class (orange: stones
// the AI drew) | plain B, ringed | tinted B. "spots" counts every class.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { removeCloseStones } from "../src/pipeline/cleanup.js";
import { fillHoles, lightnessOnWhite, neighbourVote } from "../src/pipeline/holes.js";
import { capStoneSizes, pupilCentres, stonesOfLayout } from "../src/pipeline/tiers.js";
import { aiPng, asLayout, clusters, plainPng, rgba, stack, strip, tintedPng } from "./exp-holes.mjs";

const NEAR_MM = 0.5;
const RING = { is: "#e0115f", service: "#0aa5c8", other: "#f08c00" };
const VARIANTS = ["pixels", "neighbours", "service"];
const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;

// Neighbours (rim gap below NEAR_MM) of every stone, by index.
function neighbourLists(stones) {
  const cell = 5;
  const grid = new Map();
  stones.forEach((st, i) => {
    const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  return stones.map((st, i) => {
    const out = [];
    const gx = Math.floor(st.x / cell), gy = Math.floor(st.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) || []) {
        if (j !== i && Math.hypot(stones[j].x - st.x, stones[j].y - st.y) - (stones[j].d + st.d) / 2 < NEAR_MM) out.push(j);
      }
    }
    return out;
  });
}

function tallyOf(colours, cls, nb, bw, L = null) {
  const tally = {};
  const spots = [];
  colours.forEach((c, i) => {
    const t = (tally[cls[i]] ??= { stones: 0, lone: 0, darkAmongLight: 0, lightAmongDark: 0, sumL: 0, sumNbL: 0 });
    t.stones++;
    if (L) {
      t.sumL += L[i];
      t.sumNbL += nb[i].length ? nb[i].reduce((a, j) => a + L[j], 0) / nb[i].length : L[i];
    }
    const lone = nb[i].length > 0 && !nb[i].some((j) => colours[j] === c);
    if (lone) t.lone++;
    let spot = !bw && lone;
    if (bw && nb[i].length >= 3) {
      const crystal = nb[i].filter((j) => colours[j] !== "jet").length;
      if (c === "jet" && crystal > nb[i].length / 2) { t.darkAmongLight++; spot = true; }
      if (c !== "jet" && crystal < nb[i].length / 2) t.lightAmongDark++;
    }
    if (spot) spots.push(i);
  });
  for (const t of Object.values(tally)) {
    t.meanL = L ? Math.round(t.sumL / t.stones * 10) / 10 : null;
    t.meanNeighbourL = L ? Math.round(t.sumNbL / t.stones * 10) / 10 : null;
    delete t.sumL;
    delete t.sumNbL;
  }
  return { tally, spots };
}

export async function runSpots(item, mode, outDir, base) {
  const at = (p) => path.resolve(base, p);
  const layout = JSON.parse(readFileSync(at(item.layout), "utf8"));
  if (layout.error) return { name: item.name, mode, error: layout.error.message ?? String(layout.error) };
  const ai = await rgba(at(item.ai));
  const report = layout.report;
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const kept = removeCloseStones(capStoneSizes(stonesOfLayout(layout), pupilCentres(layout)).stones).stones;
  const { stones } = fillHoles(kept, ai, report, { colours: "pixels" });
  const serviceKeys = new Set((report.fillAtMm ?? []).map(([x, y]) => key(x, y)));
  const cls = stones.map((st, i) => (i >= kept.length ? "is" : serviceKeys.has(key(st.x, st.y)) ? "service" : "other"));
  const targetsOf = { pixels: [], neighbours: cls.flatMap((c, i) => (c === "is" ? [i] : [])), service: cls.flatMap((c, i) => (c !== "other" ? [i] : [])) };
  const nb = neighbourLists(stones);
  const L = mode === "bw" ? stones.map((st) => lightnessOnWhite(ai, (st.x + ox) / s, (st.y + oy) / s, st.d, s)) : null;

  const designs = {}, out = {};
  for (const v of VARIANTS) {
    const targets = targetsOf[v];
    let coloured = stones;
    if (mode !== "bw" && targets.length) {
      const voted = neighbourVote(stones, new Set(targets), (st) => st.color);
      coloured = stones.map((st, i) => (voted.has(i) ? { ...st, color: voted.get(i) } : st));
    }
    designs[v] = asLayout(coloured, mode, ai, report, undefined, mode === "bw" ? targets : []);
    const colours = designs[v].stones.map((st) => st.color);
    out[v] = { colours, ...tallyOf(colours, cls, nb, mode === "bw", v === "pixels" ? L : null) };
  }
  const changed = (v) => {
    const by = { is: 0, service: 0 };
    out[v].colours.forEach((c, i) => { if (c !== out.pixels.colours[i]) by[cls[i]]++; });
    return by;
  };

  const suffix = mode === "bw" && item.mode !== "bw" ? "-bw" : "";
  const spotStones = out.pixels.spots.filter((i) => cls[i] !== "other").map((i) => ({ ...stones[i], cls: cls[i] }));
  const groups = clusters(spotStones).slice(0, 3);
  if (groups.length) {
    const rows = [];
    for (const g of groups) {
      const cx = g.reduce((t, h) => t + h.x, 0) / g.length, cy = g.reduce((t, h) => t + h.y, 0) / g.length;
      const view = { x0: cx - 6, y0: cy - 6, w: 12, h: 12 };
      const zp = 360 / 12;
      const byCls = {};
      for (const h of g) byCls[h.cls] = (byCls[h.cls] || 0) + 1;
      rows.push(await strip(null, [
        { label: `AI image (${Object.entries(byCls).map(([k, n]) => `${k} fill ${n}`).join(", ")})`, png: await aiPng(at(item.ai), report, view, zp) },
        { label: "plain, before (pixels)", png: plainPng(designs.pixels, view, zp, g.map((h) => ({ ...h, colour: RING[h.cls] }))) },
        { label: "tinted, before", png: await tintedPng(designs.pixels, view, zp) },
        { label: "tinted, IS fill by neighbours", png: await tintedPng(designs.neighbours, view, zp) },
        { label: "tinted, + service fill", png: await tintedPng(designs.service, view, zp) }
      ], 330));
    }
    await stack(path.join(outDir, `${item.name}${suffix}-spots.jpg`), rows);
  }
  // B&W: the dark spots left in the pipeline's design (B), any class, where they are densest.
  if (mode === "bw") {
    const left = out.neighbours.spots.map((i) => ({ ...stones[i], cls: cls[i] }));
    const rows = [];
    for (const g of clusters(left).slice(0, 3)) {
      const cx = g.reduce((t, h) => t + h.x, 0) / g.length, cy = g.reduce((t, h) => t + h.y, 0) / g.length;
      const view = { x0: cx - 6, y0: cy - 6, w: 12, h: 12 };
      const zp = 360 / 12;
      const byCls = {};
      for (const h of g) byCls[h.cls] = (byCls[h.cls] || 0) + 1;
      const inView = left.filter((h) => h.x > view.x0 && h.x < view.x0 + 12 && h.y > view.y0 && h.y < view.y0 + 12);
      rows.push(await strip(null, [
        { label: `AI image (${Object.entries(byCls).map(([k, n]) => `${k} ${n}`).join(", ")})`, png: await aiPng(at(item.ai), report, view, zp) },
        { label: "plain, dark spots ringed", png: plainPng(designs.neighbours, view, zp, inView.map((h) => ({ ...h, colour: RING[h.cls] }))) },
        { label: "tinted (the pipeline)", png: await tintedPng(designs.neighbours, view, zp) }
      ], 330));
    }
    if (rows.length) await stack(path.join(outDir, `${item.name}${suffix}-remaining.jpg`), rows);
  }
  return {
    name: item.name + suffix, mode, serviceFill: serviceKeys.size, isFill: stones.length - kept.length,
    variants: Object.fromEntries(VARIANTS.map((v) => [v, { classes: out[v].tally, spots: out[v].spots.length, ...(v === "pixels" ? {} : { changed: changed(v) }) }]))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestFile, outDir, modes = "own"] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const item of manifest) {
    for (const mode of modes === "both" ? ["colour", "bw"] : [item.mode]) {
      const r = await runSpots(item, mode, outDir, path.dirname(path.resolve(manifestFile)));
      results.push(r);
      console.log(r.name, mode, r.error ? `error: ${r.error}` : VARIANTS.map((v) => `${v} ${r.variants[v].spots}`).join(", "));
    }
  }
  writeFileSync(path.join(outDir, "spots-results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
