// Experiment exp-holes (docs/exp-holes.md; tools only, never used by the app): measures the holes of
// laid-out designs before and after the IS hole fill (src/pipeline/holes.js), tells each hole's cause
// from the strass stage trace (services/strass/scripts/holes_trace.py), and draws the plain and
// tinted views and close-ups of the worst holes.
//
//   node tools/exp-holes.mjs MANIFEST.json OUT_DIR
//
// MANIFEST: [{ name, mode: "colour" | "bw", ai: PNG, layout: /layout JSON, trace: trace JSON or
// null, strict: the service's strict mask PNG or null }]. Writes OUT_DIR/results.json,
// OUT_DIR/NAME-views.jpg (plain before | plain after | tinted before | tinted after) and
// OUT_DIR/NAME-closeups.jpg (per worst hole: AI image | plain before, holes ringed | tinted before |
// tinted after) and OUT_DIR/NAME-neighbours.jpg (where the neighbour step recoloured filled stones:
// AI image | plain and tinted without the step | with it). B&W designs are drawn as the pipeline
// makes them: every stone Jet or Crystal by the AI image's lightness (spec 7.6). Paths in the
// manifest are relative to its own folder.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { cleanedLayout, removeCloseStones } from "../src/pipeline/cleanup.js";
import { acceptLayout } from "../src/pipeline/design.js";
import { NEIGHBOUR_GAP_MM, PALETTE, deltaE2000, findHoles, fillHoles, sampleLab, srgbToLab, subjectMask } from "../src/pipeline/holes.js";
import { capStoneSizes, pupilCentres, stonesOfLayout } from "../src/pipeline/tiers.js";
import { renderTinted } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";

export const CAUSES = Object.freeze([
  ["is-cleanup", "IS overlap cleanup removed a stone there"],
  ["check", "service: last gap check removed a stone there"],
  ["eyes", "service: eye stage removed a stone there"],
  ["rows", "service: ordered rows dropped, deleted or moved the AI's stone"],
  ["fill-declined", "service: its fill found the spot and declined it (cover < 0.7 or no room)"],
  ["fill-margin", "service: its fill needs 0.15 mm, the spot has less"],
  ["edge", "subject edge: outside the service's strict subject mask"],
  ["not-detected", "AI drew a stone there, not detected"],
  ["ai-empty", "AI drew no stone there (gap colour or transparent)"]
]);

const FILL_MARGIN_MM = 0.15 + 0.5 / 20; // geometry.fill: GAP + 0.05 at 20 px/mm
const GAP_DROP_DE = 12; // ordered.py: a small detection within 12 ΔE of the gap colour is a painted gap

const overlaps = (a, hole) => Math.hypot(a[0] - hole.x, a[1] - hole.y) < a[2] / 2 + hole.d / 2;
const inside = (a, hole) => Math.hypot(a[0] - hole.x, a[1] - hole.y) < hole.d / 2;

export async function rgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function grey(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// The AI's gap colour, as ordered.py tells painted gaps: the subject's pixels outside every
// detection disc; painted when their mean alpha is above one half, then their median Lab.
function gapColour(ai, detections, report) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const { width: w, height: h, data } = ai;
  const disc = new Uint8Array(w * h);
  for (const [x, y, d] of detections) {
    const cx = (x + ox) / s, cy = (y + oy) / s, r = d / 2 / s;
    for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(h - 1, Math.ceil(cy + r)); py++) {
      for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(w - 1, Math.ceil(cx + r)); px++) {
        if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) disc[py * w + px] = 1;
      }
    }
  }
  const subject = subjectMask(ai, s);
  let alpha = 0, n = 0;
  const labs = [];
  for (let i = 0; i < w * h; i++) {
    if (!subject[i] || disc[i]) continue;
    alpha += data[i * 4 + 3] / 255;
    n++;
    if (data[i * 4 + 3] >= 128 && labs.length < 200000 && i % 3 === 0) labs.push(srgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  }
  if (!n || alpha / n <= 0.5 || !labs.length) return null;
  const med = (k) => labs.map((v) => v[k]).sort((a, b) => a - b)[Math.floor(labs.length / 2)];
  return [med(0), med(1), med(2)];
}

// What the AI drew in the inner 60 % of a hole: { opaque share, mean Lab }.
function drawnAt(ai, hole, report) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const cx = (hole.x + ox) / s, cy = (hole.y + oy) / s, r = 0.6 * hole.d / 2 / s;
  let n = 0, opaque = 0;
  const sum = [0, 0, 0];
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(ai.height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(ai.width - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      n++;
      const p = (y * ai.width + x) * 4;
      if (ai.data[p + 3] < 128) continue;
      opaque++;
      const lab = srgbToLab(ai.data[p], ai.data[p + 1], ai.data[p + 2]);
      sum[0] += lab[0]; sum[1] += lab[1]; sum[2] += lab[2];
    }
  }
  return { opaqueShare: n ? opaque / n : 0, lab: opaque ? sum.map((v) => v / opaque) : null };
}

// Share of the hole's AI pixels inside the service's strict subject mask.
function strictShare(strict, hole, report) {
  if (!strict) return 1;
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const cx = (hole.x + ox) / s, cy = (hole.y + oy) / s, r = hole.d / 2 / s;
  let n = 0, on = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(strict.height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(strict.width - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      n++;
      if (strict.data[y * strict.width + x] >= 128) on++;
    }
  }
  return n ? on / n : 0;
}

// The first cause that applies, in CAUSES order, and its detail.
function causeOf(hole, ctx) {
  const { removedByCleanup, trace, serviceStones, ai, strict, report, gap } = ctx;
  if (removedByCleanup.some((st) => overlaps([st.x, st.y, st.d], hole))) return ["is-cleanup", ""];
  if (trace) {
    if (trace.checkRemoved.some((a) => overlaps(a, hole))) return ["check", ""];
    if (trace.eyeDropped.some((a) => overlaps(a, hole))) return ["eyes", ""];
    const det = trace.detections.filter((a) => inside(a, hole));
    const dropped = det.find((a) => a[3] !== "kept" && a[3] !== "tiled");
    if (dropped) return ["rows", dropped[3]];
    if (det.length) return ["rows", "moved"];
    if (trace.rowsDeleted.some((a) => overlaps(a, hole))) return ["rows", "rows-deleted-2"];
    const declined = trace.fill.find((f) => !f[6] && overlaps(f, hole));
    if (declined) return ["fill-declined", declined[4] < 0.7 ? (declined[5] ? "cover" : "cover+room") : "room"];
  }
  let minGap = Infinity;
  for (const st of serviceStones) minGap = Math.min(minGap, Math.hypot(st.x - hole.x, st.y - hole.y) - (st.d + hole.d) / 2);
  if (minGap < FILL_MARGIN_MM) return ["fill-margin", minGap.toFixed(3)];
  if (strictShare(strict, hole, report) < 1) return ["edge", ""];
  const drawn = drawnAt(ai, hole, report);
  if (drawn.opaqueShare >= 0.5 && (!gap || deltaE2000(drawn.lab, gap) >= GAP_DROP_DE)) return ["not-detected", ""];
  return ["ai-empty", drawn.opaqueShare < 0.5 ? "transparent" : "gap colour"];
}

// Groups of holes whose discs lie within 1 mm of each other, worst (largest hole area) first.
export function clusters(holes) {
  const parent = holes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < holes.length; i++) {
    for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i], b = holes[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) - (a.d + b.d) / 2 < 1) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  holes.forEach((h, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  });
  const area = (g) => g.reduce((s, h) => s + h.d * h.d, 0);
  return [...groups.values()].sort((a, b) => area(b) - area(a));
}

// Plain stones (layout mm) -> StoneLayout in the same mm; B&W read from the AI image (7.6).
export const asLayout = (stones, mode, ai = null, report = null, threshold = undefined) => {
  const layout = new StoneLayout({
    layerId: "design", sourceMode: "is",
    stones: stones.map((s, index) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color, layerId: "design", index }))
  });
  return mode === "bw" ? mapBlackAndWhiteFromImage(layout, ai, { ...report, originMm: [0, 0] }, threshold) : layout;
};

// Flat discs in their catalogue fill on white. view: { x0, y0, w, h } in mm; rings: [{ x, y, d, colour }].
export function plainPng(layout, view, ppmm, rings = []) {
  const W = Math.round(view.w * ppmm), H = Math.round(view.h * ppmm);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  for (const s of layout.stones) {
    const c = STONE_COLORS[s.color];
    ctx.beginPath();
    ctx.arc((s.xMm - view.x0) * ppmm, (s.yMm - view.y0) * ppmm, s.sizeMm / 2 * ppmm, 0, 2 * Math.PI);
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(0.5, 0.06 * ppmm);
    ctx.strokeStyle = c.stroke;
    ctx.stroke();
  }
  for (const r of rings) {
    ctx.beginPath();
    ctx.arc((r.x - view.x0) * ppmm, (r.y - view.y0) * ppmm, r.d / 2 * ppmm, 0, 2 * Math.PI);
    ctx.lineWidth = Math.max(1.5, 0.15 * ppmm);
    ctx.strokeStyle = r.colour;
    ctx.stroke();
  }
  return canvas.toBuffer("image/png");
}

// The tinted render of the stones near a view, cropped to it.
export async function tintedPng(layout, view, ppmm) {
  const near = layout.stones.filter((s) => s.xMm > view.x0 - 4 && s.xMm < view.x0 + view.w + 4 && s.yMm > view.y0 - 4 && s.yMm < view.y0 + view.h + 4);
  if (!near.length) return plainPng(asLayout([], "colour"), view, ppmm);
  const sub = new StoneLayout({ layerId: "design", sourceMode: "is", stones: near });
  const box = sub.getBoundingBox();
  const main = 2;
  const minX = box.minXmm - 2 * main, minY = box.minYmm - 2 * main;
  const span = Math.max(box.widthMm, box.heightMm) + 4 * main;
  const { png, scale } = renderTinted(sub, { longSidePx: Math.round(span * ppmm), background: "white" });
  const meta = await sharp(png).metadata();
  const left = Math.round((view.x0 - minX) * scale), top = Math.round((view.y0 - minY) * scale);
  const W = Math.round(view.w * scale), H = Math.round(view.h * scale);
  // Pad with white where the view reaches beyond the render.
  const padded = await sharp(png).extend({ left: Math.max(0, -left), top: Math.max(0, -top), right: Math.max(0, left + W - meta.width), bottom: Math.max(0, top + H - meta.height), background: "#ffffff" }).png().toBuffer();
  return sharp(padded).extract({ left: Math.max(0, left), top: Math.max(0, top), width: W, height: H }).png().toBuffer();
}

export async function aiPng(file, report, view, ppmm) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const meta = await sharp(file).metadata();
  const left = Math.round((view.x0 + ox) / s), top = Math.round((view.y0 + oy) / s);
  const W = Math.round(view.w / s), H = Math.round(view.h / s);
  const padded = await sharp(file).extend({ left: Math.max(0, -left), top: Math.max(0, -top), right: Math.max(0, left + W - meta.width), bottom: Math.max(0, top + H - meta.height), background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp(padded).extract({ left: Math.max(0, left), top: Math.max(0, top), width: W, height: H })
    .resize(Math.round(view.w * ppmm), Math.round(view.h * ppmm), { kernel: "nearest" })
    .flatten({ background: "#e9edf5" }).png().toBuffer();
}

export async function strip(file, panels, height) {
  const PAD = 12, LABEL = 30;
  const bufs = [];
  for (const p of panels) {
    const buf = await sharp(p.png).resize({ height, width: Math.round(height * 2), fit: "inside" }).flatten({ background: "#ffffff" }).png().toBuffer();
    bufs.push({ buf, width: (await sharp(buf).metadata()).width, label: p.label });
  }
  const W = bufs.reduce((s, b) => s + b.width, 0) + PAD * (bufs.length + 1);
  let x = PAD;
  const composites = [], labels = [];
  for (const b of bufs) {
    composites.push({ input: b.buf, left: x, top: LABEL });
    labels.push(`<text x="${x}" y="${LABEL - 9}" font-family="Helvetica, Arial" font-size="18" fill="#1d3a8a">${b.label}</text>`);
    x += b.width + PAD;
  }
  composites.push({ input: Buffer.from(`<svg width="${W}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg">${labels.join("")}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: height + LABEL + PAD, channels: 3, background: "#ffffff" } }).composite(composites).jpeg({ quality: 86 }).toBuffer();
}

export async function stack(file, rows) {
  const metas = await Promise.all(rows.map((r) => sharp(r).metadata()));
  const W = Math.max(...metas.map((m) => m.width)), H = metas.reduce((s, m) => s + m.height, 0);
  let y = 0;
  const composites = rows.map((r, i) => { const c = { input: r, left: 0, top: y }; y += metas[i].height; return c; });
  await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(composites).jpeg({ quality: 86 }).toFile(file);
}

export async function runDesign(item, outDir, base) {
  const at = (p) => (p ? path.resolve(base, p) : null);
  const layout = JSON.parse(readFileSync(at(item.layout), "utf8"));
  if (layout.error) return { name: item.name, mode: item.mode, error: layout.error.message ?? String(layout.error) };
  const ai = await rgba(at(item.ai));
  const trace = item.trace && existsSync(at(item.trace)) ? JSON.parse(readFileSync(at(item.trace), "utf8")) : null;
  const strict = item.strict && existsSync(at(item.strict)) ? await grey(at(item.strict)) : null;
  const report = layout.report;
  const serviceStones = stonesOfLayout(layout);
  const capped = capStoneSizes(serviceStones, pupilCentres(layout)).stones;
  const { stones: kept, removed } = removeCloseStones(capped);
  const removedByCleanup = removed.map((i) => capped[i]);

  const before = findHoles(kept, ai, report);
  const filled = fillHoles(kept, ai, report);
  const unstepped = fillHoles(kept, ai, report, { neighbours: false });
  const after = findHoles(filled.stones, ai, report);
  const production = acceptLayout(cleanedLayout(layout));
  const natural = cleanedLayout(layout, { fillHolesIn: ai });
  const check = acceptLayout(natural);

  const gap = trace ? gapColour(ai, trace.detections, report) : null;
  const ctx = { removedByCleanup, trace, serviceStones, ai, strict, report, gap };
  const causes = Object.fromEntries(CAUSES.map(([k]) => [k, 0]));
  const details = {};
  for (const hole of before.holes) {
    const [cause, detail] = causeOf(hole, ctx);
    hole.cause = cause;
    causes[cause]++;
    const key = detail ? `${cause}:${detail}` : cause;
    if (!/^fill-margin/.test(key)) details[key] = (details[key] || 0) + 1;
  }

  // Views of the whole design.
  const all = [...kept, ...filled.added];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of all) { x0 = Math.min(x0, s.x - s.d); y0 = Math.min(y0, s.y - s.d); x1 = Math.max(x1, s.x + s.d); y1 = Math.max(y1, s.y + s.d); }
  const whole = { x0, y0, w: x1 - x0, h: y1 - y0 };
  const beforeLayout = asLayout(kept, item.mode, ai, report), afterLayout = asLayout(filled.stones, item.mode, ai, report);
  const ppmm = 1400 / Math.max(whole.w, whole.h);
  const views = await strip(null, [
    { label: `plain before (${before.holes.length} holes)`, png: plainPng(beforeLayout, whole, ppmm, before.holes.map((h) => ({ ...h, colour: "#e0115f" }))) },
    { label: `plain after (+${filled.added.length})`, png: plainPng(afterLayout, whole, ppmm) },
    { label: "tinted before", png: await tintedPng(beforeLayout, whole, ppmm) },
    { label: "tinted after", png: await tintedPng(afterLayout, whole, ppmm) }
  ], 760);
  writeFileSync(path.join(outDir, `${item.name}-views.jpg`), views);

  // Close-ups of the three worst hole groups.
  const groups = clusters(before.holes).slice(0, 3);
  const rows = [];
  const closeups = [];
  for (const g of groups) {
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (const h of g) { gx0 = Math.min(gx0, h.x); gy0 = Math.min(gy0, h.y); gx1 = Math.max(gx1, h.x); gy1 = Math.max(gy1, h.y); }
    const side = Math.max(14, gx1 - gx0 + 8, gy1 - gy0 + 8);
    const view = { x0: (gx0 + gx1) / 2 - side / 2, y0: (gy0 + gy1) / 2 - side / 2, w: side, h: side };
    const zp = 420 / side;
    const tally = {};
    for (const h of g) tally[h.cause] = (tally[h.cause] || 0) + 1;
    closeups.push({ at: [Math.round((gx0 + gx1) / 2), Math.round((gy0 + gy1) / 2)], holes: g.length, causes: tally });
    rows.push(await strip(null, [
      { label: `AI image (${g.length} holes: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")})`, png: await aiPng(at(item.ai), report, view, zp) },
      { label: "plain before, holes ringed", png: plainPng(beforeLayout, view, zp, g.map((h) => ({ ...h, colour: "#e0115f" }))) },
      { label: "tinted before", png: await tintedPng(beforeLayout, view, zp) },
      { label: "tinted after", png: await tintedPng(afterLayout, view, zp) }
    ], 420));
  }
  if (rows.length) await stack(path.join(outDir, `${item.name}-closeups.jpg`), rows);

  // The neighbour step: the filled stones whose colour none of their neighbours uses ("lone"), the
  // ΔE from the colour sampled at the spot to the neighbours' most common colour, and the three
  // largest groups of lone stones drawn without and with the step.
  const lone = [];
  const fillLab = new Map(PALETTE.map((p) => [p.id, p.lab]));
  unstepped.added.forEach((st) => {
    const nb = unstepped.stones.filter((o) => o !== st && Math.hypot(o.x - st.x, o.y - st.y) - (o.d + st.d) / 2 < NEIGHBOUR_GAP_MM);
    if (!nb.length || nb.some((o) => o.color === st.color)) return;
    const counts = {};
    for (const o of nb) counts[o.color] = (counts[o.color] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const lab = sampleLab(ai, (st.x + report.offsetMm[0]) / report.mmPerPx, (st.y + report.offsetMm[1]) / report.mmPerPx, st.d, report.mmPerPx);
    lone.push({ ...st, de: deltaE2000(lab, fillLab.get(best)) });
  });
  if (lone.length) {
    const noStep = asLayout(unstepped.stones, item.mode, ai, report);
    const nrows = [];
    for (const g of clusters(lone).slice(0, 3)) {
      const cx = g.reduce((t, h) => t + h.x, 0) / g.length, cy = g.reduce((t, h) => t + h.y, 0) / g.length;
      const view = { x0: cx - 6, y0: cy - 6, w: 12, h: 12 };
      const zp = 420 / 12;
      const ringed = g.map((h) => ({ ...h, colour: "#e0115f" }));
      const changedHere = g.filter((h) => filled.added.some((a) => a.x === h.x && a.y === h.y && a.color !== h.color)).length;
      nrows.push(await strip(null, [
        { label: `AI image (${g.length} lone, ΔE ${g.map((h) => h.de.toFixed(0)).join(", ")})`, png: await aiPng(at(item.ai), report, view, zp) },
        { label: "plain, no neighbour step", png: plainPng(noStep, view, zp, ringed) },
        { label: `plain, neighbour step (${changedHere} changed)`, png: plainPng(afterLayout, view, zp, ringed) },
        { label: "tinted, no neighbour step", png: await tintedPng(noStep, view, zp) },
        { label: "tinted, neighbour step", png: await tintedPng(afterLayout, view, zp) }
      ], 360));
    }
    await stack(path.join(outDir, `${item.name}-neighbours.jpg`), nrows);
  }

  const round = (v, p = 4) => Math.round(v * 10 ** p) / 10 ** p;
  return {
    name: item.name, mode: item.mode,
    stones: kept.length, serviceStones: serviceStones.length, cleanupRemoved: removed.length,
    before: { ss6: before.ss6, ss4: before.ss4, holes: before.holes.length, areaShare: round(before.areaShare), largestEmptyMm: round(before.largestEmptyMm, 2) },
    after: { ss6: after.ss6, ss4: after.ss4, holes: after.holes.length, areaShare: round(after.areaShare), largestEmptyMm: round(after.largestEmptyMm, 2) },
    added: { total: filled.added.length, ss6: filled.added.filter((s) => s.d === 2).length, ss4: filled.added.filter((s) => s.d === 1.5).length, recoloured: filled.recoloured, lone: lone.length, loneDe: lone.map((h) => Math.round(h.de * 10) / 10).sort((a, b) => a - b) },
    serviceLargestEmptyMm: report.largestEmptyCircleMm,
    subjectAreaMm2: Math.round(before.subjectAreaMm2),
    causes, details, closeups, traced: Boolean(trace),
    gapColour: gap ? "painted" : "transparent",
    production: { ok: production.ok, coverage: production.coverage, violations: production.violations },
    filledDesign: { ok: check.ok, coverage: check.coverage, violations: check.violations, stones: check.stones, minGapMm: round(natural.gaps.minGapMm, 4) }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestFile, outDir] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const item of manifest) {
    const t = Date.now();
    const r = await runDesign(item, outDir, path.dirname(path.resolve(manifestFile)));
    results.push(r);
    console.log(item.name, item.mode, r.error ? `error: ${r.error}` : `holes ${r.before.holes} -> ${r.after.holes}, +${r.added.total}, ${Date.now() - t} ms`);
  }
  writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
