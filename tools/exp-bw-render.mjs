// Experiment exp-holes, B&W render (docs/exp-holes.md section 10; tools only, never used by the app).
// Each design is made as the pipeline makes it in black & white (cleanedLayout with the hole fill,
// mapBlackAndWhiteFromImage at the default threshold), once as today and once with the class (b) fix
// (fromDiscs: each stone from the AI stone disc it overlaps most; the discs are the trace's
// detections with a stone verdict, which are exactly the service's report.discsAtMm). It reports how
// many stones the fix changes, and draws, with the fix on, the AI image and the tinted view under
// each B&W gap rule (tinted.js BW_GAPS: today "nearest", A "crystal", B "white", C "black") for the
// whole design, the face (two pupils) and the close-ups of tools/exp-bw-diagnosis.mjs; and the plain
// view without and with the fix (for the designs named in PLAIN, or all with "all").
//
//   node tools/exp-bw-render.mjs MANIFEST.json DIAGNOSIS.json OUT_DIR [PLAIN,...|all]
//
// MANIFEST as tools/exp-holes.mjs (name, ai, layout, trace); DIAGNOSIS: exp-bw-diagnosis.mjs's
// diagnosis.json for the same designs (the close-up windows). Writes OUT_DIR/render-results.json and
// OUT_DIR/NAME-{whole,face,1..4}.jpg (and NAME-plain-{whole,1..4}.jpg).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BW_DARK, BW_LIGHT, DEFAULT_BW_THRESHOLD, mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { lightnessOnWhite } from "../src/pipeline/holes.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { BW_GAPS } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { faceBox } from "./exp-bw.mjs";
import { aiPng, plainPng, rgba, strip, tintedPng } from "./exp-holes.mjs";

const STONE_VERDICTS = new Set(["kept", "tiled", "rows-deleted", "duplicate", "inside-big", "outside-mask"]);
const LABEL = { nearest: "today", crystal: "A: Crystal gap", white: "B: white", black: "C: black" };
const NEAR_MM = 0.5;

// Jet stones with at least 2 neighbours (rim gap < 0.5 mm), more than half Crystal (as the diagnosis).
function jetAmongCrystal(stones) {
  let n = 0;
  stones.forEach((st, i) => {
    if (st.color !== "jet") return;
    let all = 0, crystal = 0;
    stones.forEach((o, j) => {
      if (j === i || Math.abs(o.xMm - st.xMm) > 4 || Math.abs(o.yMm - st.yMm) > 4) return;
      if (Math.hypot(o.xMm - st.xMm, o.yMm - st.yMm) - (o.sizeMm + st.sizeMm) / 2 >= NEAR_MM) return;
      all++;
      if (o.color !== "jet") crystal++;
    });
    if (all >= 2 && crystal > all / 2) n++;
  });
  return n;
}

// Area shared by two discs (radii r1, r2, centres dist apart).
function overlapArea(r1, r2, dist) {
  if (dist >= r1 + r2) return 0;
  if (dist <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((dist * dist + r1 * r1 - r2 * r2) / (2 * dist * r1));
  const b = r2 * r2 * Math.acos((dist * dist + r2 * r2 - r1 * r1) / (2 * dist * r2));
  return a + b - 0.5 * Math.sqrt((-dist + r1 + r2) * (dist + r1 - r2) * (dist - r1 + r2) * (dist + r1 + r2));
}

// The disc fix (exp-holes; IS_BW_FROM_DISCS until exp-faces removed it from the app): the stone's colour is that of the AI stone disc
// (frame.discsAtMm, [x, y, d] in the layout's mm: the stones the service detected, not the painted
// dots it dropped) it overlaps most, the disc read as a stone at its own centre and size; a stone
// that overlaps none is read as before. The layout moves stones off their discs, partly onto the AI's
// dark gap paint, which then read Jet among Crystal (docs/exp-holes.md section 10).
function discReader(discs, ai, s, offsetMm, threshold) {
  const CELL = 3;
  const grid = new Map();
  discs.forEach(([x, y], k) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  });
  const colour = new Map();
  const colourOf = (k) => {
    if (!colour.has(k)) {
      const [x, y, d] = discs[k];
      colour.set(k, lightnessOnWhite(ai, (x + offsetMm[0]) / s, (y + offsetMm[1]) / s, d, s) < threshold ? BW_DARK : BW_LIGHT);
    }
    return colour.get(k);
  };
  // The colour of the disc a stone at (x, y), diameter d (layout mm) overlaps most, or null.
  return (x, y, d) => {
    let best = 0, at = -1;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      for (const k of grid.get(`${gx + a},${gy + b}`) || []) {
        const area = overlapArea(d / 2, discs[k][2] / 2, Math.hypot(discs[k][0] - x, discs[k][1] - y));
        if (area > best) { best = area; at = k; }
      }
    }
    return at >= 0 ? colourOf(at) : null;
  };
}

// mapBlackAndWhiteFromImage's result with every stone that overlaps a disc recoloured by it (the
// voted stones keep their vote, as the app's fromDiscs path did not read them either).
function withDiscs(mapped, layout, ai, { mmPerPx, offsetMm, originMm, discsAtMm }, threshold, voted) {
  const disc = discReader(discsAtMm, ai, Number(mmPerPx), offsetMm, threshold);
  const skip = new Set(voted);
  return new StoneLayout({
    layerId: mapped.layerId, sourceMode: mapped.sourceMode,
    stones: mapped.stones.map((st, i) => new Stone({
      xMm: st.xMm, yMm: st.yMm, sizeMm: st.sizeMm, layerId: st.layerId, index: st.index, metadata: st.metadata,
      color: skip.has(i) ? st.color : disc(layout.stones[i].xMm + originMm[0], layout.stones[i].yMm + originMm[1], st.sizeMm) ?? st.color
    }))
  });
}

// The layout's mm (the frame of the report, the trace and the diagnosis windows).
const shifted = (layout, [gx, gy]) => new StoneLayout({
  layerId: "design", sourceMode: "is",
  stones: layout.stones.map((st, index) => new Stone({ xMm: st.xMm + gx, yMm: st.yMm + gy, sizeMm: st.sizeMm, color: st.color, layerId: "design", index }))
});

export async function renderBw(item, windows, outDir, base, plain = false) {
  const at = (p) => path.resolve(base, p);
  const layout = JSON.parse(readFileSync(at(item.layout), "utf8"));
  if (layout.error) return { name: item.name, error: layout.error.message ?? String(layout.error) };
  const trace = JSON.parse(readFileSync(at(item.trace), "utf8"));
  const ai = await rgba(at(item.ai));
  const report = { ...layout.report, discsAtMm: layout.report.discsAtMm ?? trace.detections.filter((d) => STONE_VERDICTS.has(d[3])).map(([x, y, d]) => [x, y, d]) };
  const natural = cleanedLayout(layout, { fillHolesIn: ai });
  const frame = { ...report, originMm: natural.originMm };
  const mapped = mapBlackAndWhiteFromImage(natural.stoneLayout, ai, frame, DEFAULT_BW_THRESHOLD, natural.voted);
  const today = shifted(mapped, natural.originMm);
  const fixed = shifted(withDiscs(mapped, natural.stoneLayout, ai, frame, DEFAULT_BW_THRESHOLD, natural.voted), natural.originMm);
  let toCrystal = 0, toJet = 0;
  today.stones.forEach((st, i) => {
    if (st.color === fixed.stones[i].color) return;
    if (st.color === "jet") toCrystal++;
    else toJet++;
  });

  const box = today.getBoundingBox();
  const views = [{ tag: "whole", label: "whole design", view: { x0: box.minXmm - 1, y0: box.minYmm - 1, w: box.widthMm + 2, h: box.heightMm + 2 } }];
  const face = faceBox(report);
  if (face) {
    const side = Math.max(face.x1 - face.x0, face.y1 - face.y0);
    views.push({ tag: "face", label: "face", view: { x0: (face.x0 + face.x1) / 2 - side / 2, y0: (face.y0 + face.y1) / 2 - side / 2, w: side, h: side } });
  }
  windows.forEach((w, k) => views.push({ tag: String(k + 1), label: `close-up ${k + 1}`, view: { x0: w.xMm, y0: w.yMm, w: 10, h: 10 } }));

  const files = [];
  for (const { tag, label, view } of views) {
    const height = tag === "whole" ? 520 : 360;
    const ppmm = (tag === "whole" ? 1.5 : 1) * height / Math.max(view.w, view.h);
    const panels = [{ label: "AI image", png: await aiPng(at(item.ai), report, view, ppmm) }];
    for (const g of BW_GAPS) panels.push({ label: LABEL[g], png: await tintedPng(fixed, view, ppmm, { bwGap: g }) });
    const file = `${item.name}-${tag}.jpg`;
    writeFileSync(path.join(outDir, file), await strip(null, panels, height));
    const entry = { tag, label, file };
    if (plain) {
      entry.plain = `${item.name}-plain-${tag}.jpg`;
      writeFileSync(path.join(outDir, entry.plain), await strip(null, [
        { label: "AI image", png: panels[0].png },
        { label: "plain, today", png: plainPng(today, view, ppmm) },
        { label: "plain, disc fix", png: plainPng(fixed, view, ppmm) }
      ], height));
    }
    files.push(entry);
  }
  return {
    name: item.name,
    stones: today.stones.length,
    discs: report.discsAtMm.length,
    changed: toCrystal + toJet,
    toCrystal,
    toJet,
    jetAmongCrystal: { today: jetAmongCrystal(today.stones), fixed: jetAmongCrystal(fixed.stones) },
    jetShare: { today: Math.round(today.stones.filter((s) => s.color === "jet").length / today.stones.length * 1000) / 1000, fixed: Math.round(fixed.stones.filter((s) => s.color === "jet").length / fixed.stones.length * 1000) / 1000 },
    files
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestFile, diagnosisFile, outDir, plainArg = ""] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const diagnosis = new Map(JSON.parse(readFileSync(diagnosisFile, "utf8")).map((d) => [d.name, d.closeups ?? []]));
  const plain = new Set(plainArg.split(",").filter(Boolean));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const item of manifest) {
    const r = await renderBw(item, (diagnosis.get(item.name) ?? []).map((c) => ({ xMm: c.xMm, yMm: c.yMm })), outDir, path.dirname(path.resolve(manifestFile)), plain.has("all") || plain.has(item.name));
    results.push(r);
    console.log(item.name, r.error ? `error: ${r.error}` : `changed ${r.changed} (to Crystal ${r.toCrystal}, to Jet ${r.toJet}), Jet among Crystal ${r.jetAmongCrystal.today} -> ${r.jetAmongCrystal.fixed}`);
  }
  writeFileSync(path.join(outDir, "render-results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
