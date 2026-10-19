// IS-05b tinted renderer tuning (tools only, no provider or strass call):
//   node tools/is05b-tint.mjs [runs dir]
// compares the downsampled tinted render with the AI image on the 21 designs of the IS-05 tinted
// comparison and grid-searches the gap rule of spec section 8 step 3 (GAP_RULE in
// src/render/tinted.js). With a runs dir (scripts/is05b_runs.py output) each design is its
// <run>.default.json layout, else the saved fixture. Results: docs/IS-05b-results/tint-tune.json.
//
// The comparison: both images are cut into CELL_MM cells of the delivered design. The AI cell is
// the mean sRGB of the AI image's stone colours: its opaque pixels within STONE_SHARE of a
// delivered stone's radius. Its gaps are left out: the prompt asks for transparent gaps, but most
// AI images paint them opaque and dark (mug: gap L* 14 between stones of L* 78), which is not a
// colour of the design. ("asDrawn" scores use every opaque pixel instead, for reference.) The
// tinted cell is the mean sRGB of the render. A cell counts when the tint fills at least 90 % of
// it and the AI pixels counted cover at least 20 % of it. The design's score is the mean CIE
// ΔE2000 over its cells; the overall score is the mean over the designs.
//
// For the search the render is split into a stone layer (stones drawn on transparent, step 6
// applied) and the tint under it: a pixel is stone·a + tint·(1 − a), so each cell is linear in the
// tint colours and every rule is scored without re-rendering. The final numbers use renderTinted.
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FILL_REACH, GAP_RULE, gapRgb, keepStoneLightness, lightnessOfHex, nearestStones, renderTinted, tintCanvasMm
} from "../src/render/tinted.js";
import { getCrystalAppearance } from "../src/stones/CrystalAppearance.js";
import { drawCrystalStone } from "../src/stones/CrystalStoneRenderer.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { ALL_DESIGNS, decodeRgba, delivered, layoutOf } from "./is05b-measure.mjs";
import { deltaE2000, srgbToLab } from "./colour-diff.mjs";

export const CELL_MM = Number(process.env.IS05B_CELL_MM || 2);
const PX_PER_MM = 8;
const MIN_FILLED = 0.9;
const MIN_AI = 0.2;
const STONE_SHARE = 0.8;
export const BEFORE_BRIGHTNESS = 0.85; // spec section 8 step 3 before IS-05b

const fillOf = (color) => (STONE_COLORS[color] || STONE_COLORS.crystal).fill;
const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16));
export const beforeGapRgb = (hex) => hexRgb(hex).map((v) => Math.round(v * BEFORE_BRIGHTNESS));

// The tinted renderer before IS-05b (fill × 0.85 in the gaps, stones as drawn), same signature as
// renderTinted. For the before/after images and numbers.
export function renderTintedBefore(stoneLayout, { longSidePx, background = "transparent" } = {}) {
  const box = tintCanvasMm(stoneLayout);
  const scale = longSidePx / Math.max(box.widthMm, box.heightMm);
  const widthPx = Math.round(box.widthMm * scale), heightPx = Math.round(box.heightMm * scale);
  const geometry = { minXmm: box.minXmm, minYmm: box.minYmm, widthPx, heightPx, scale };
  const { owner, best } = nearestStones(stoneLayout.stones, geometry);
  const bg = background === "white" ? [255, 255, 255, 255] : [0, 0, 0, 0];
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(widthPx, heightPx);
  const tints = new Map();
  for (let p = 0; p < owner.length; p++) {
    const s = owner[p] >= 0 ? stoneLayout.stones[owner[p]] : null;
    const r = s ? (s.sizeMm / 2) * scale : 0;
    if (s && !tints.has(s.color)) tints.set(s.color, [...beforeGapRgb(fillOf(s.color)), 255]);
    img.data.set(s && best[p] + r <= FILL_REACH * r ? tints.get(s.color) : bg, p * 4);
  }
  ctx.putImageData(img, 0, 0);
  for (const st of stoneLayout.stones) {
    drawCrystalStone(ctx, (st.xMm - box.minXmm) * scale, (st.yMm - box.minYmm) * scale, (st.sizeMm / 2) * scale, st.color, getCrystalAppearance(st));
  }
  return { png: canvas.toBuffer("image/png"), widthPx, heightPx, scale };
}

// The delivered design of a layout and the shift from its stone mm (the layout's, cropped) to the
// delivered StoneLayout's mm.
function deliveredOf(layout) {
  const { stoneLayout, kept } = delivered(layout);
  return { stoneLayout, shift: [kept[0].x - stoneLayout.stones[0].xMm, kept[0].y - stoneLayout.stones[0].yMm] };
}

// The AI image's cells: sums of the counted pixels' sRGB and their count, on the cell grid of the
// tint canvas box. Counted: opaque, and with asDrawn false within STONE_SHARE of a stone's radius.
async function aiCells(layout, aiFile, stoneLayout, box, shift, grid, asDrawn = false) {
  const img = await decodeRgba(aiFile);
  const s = layout.report.mmPerPx;
  const [ox, oy] = layout.report.offsetMm;
  const toPx = (mm, o, sh) => (mm + sh + o) / s;
  let inStone = null;
  if (!asDrawn) {
    inStone = new Uint8Array(img.width * img.height);
    for (const st of stoneLayout.stones) {
      const cx = toPx(st.xMm, ox, shift[0]), cy = toPx(st.yMm, oy, shift[1]), r = (STONE_SHARE * st.sizeMm) / 2 / s;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(img.height - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(img.width - 1, Math.ceil(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) inStone[y * img.width + x] = 1;
        }
      }
    }
  }
  const sum = new Float64Array(grid.n * 3), count = new Float64Array(grid.n);
  for (let y = 0; y < img.height; y++) {
    const cy = Math.floor(((y + 0.5) * s - oy - shift[1] - box.minYmm) / CELL_MM);
    if (cy < 0 || cy >= grid.rows) continue;
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      if (img.data[p + 3] < 128 || (inStone && !inStone[y * img.width + x])) continue;
      const cx = Math.floor(((x + 0.5) * s - ox - shift[0] - box.minXmm) / CELL_MM);
      if (cx < 0 || cx >= grid.cols) continue;
      const c = cy * grid.cols + cx;
      sum[c * 3] += img.data[p]; sum[c * 3 + 1] += img.data[p + 1]; sum[c * 3 + 2] += img.data[p + 2];
      count[c]++;
    }
  }
  const aiPxPerCell = (CELL_MM / s) ** 2;
  return { sum, count, share: Array.from(count, (n) => n / aiPxPerCell) };
}

// One design's linear cell model at fillReach: per cell the stone layer's part (base, sRGB sums)
// and, per stone colour, the weight its gap colour gets; plus the share of the cell the tint fills.
function cellModel(stoneLayout, box, grid, { fillReach = FILL_REACH, keepLightness = true } = {}) {
  const scale = PX_PER_MM;
  const widthPx = Math.round(box.widthMm * scale), heightPx = Math.round(box.heightMm * scale);
  const geometry = { minXmm: box.minXmm, minYmm: box.minYmm, widthPx, heightPx, scale, fillReach };
  const near = nearestStones(stoneLayout.stones, geometry);
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  for (const st of stoneLayout.stones) {
    drawCrystalStone(ctx, (st.xMm - box.minXmm) * scale, (st.yMm - box.minYmm) * scale, (st.sizeMm / 2) * scale, st.color, getCrystalAppearance(st));
  }
  const layer = ctx.getImageData(0, 0, widthPx, heightPx).data;
  if (keepLightness) keepStoneLightness(layer, stoneLayout.stones, near);
  const colours = [...new Set(stoneLayout.stones.map((s) => s.color))];
  const colourIdx = new Map(colours.map((c, i) => [c, i]));
  const base = new Float64Array(grid.n * 3), px = new Float64Array(grid.n), filled = new Float64Array(grid.n);
  const weight = new Float64Array(grid.n * colours.length);
  const { owner, best } = near;
  for (let y = 0; y < heightPx; y++) {
    const cy = Math.floor((y + 0.5) / scale / CELL_MM);
    if (cy >= grid.rows) continue;
    for (let x = 0; x < widthPx; x++) {
      const cx = Math.floor((x + 0.5) / scale / CELL_MM);
      if (cx >= grid.cols) continue;
      const p = y * widthPx + x, c = cy * grid.cols + cx, a = layer[p * 4 + 3] / 255;
      for (let k = 0; k < 3; k++) base[c * 3 + k] += layer[p * 4 + k] * a;
      px[c]++;
      const s = owner[p] >= 0 ? stoneLayout.stones[owner[p]] : null;
      const r = s ? (s.sizeMm / 2) * scale : 0;
      if (s && best[p] + r <= fillReach * r) {
        filled[c]++;
        weight[c * colours.length + colourIdx.get(s.color)] += 1 - a;
      } else {
        for (let k = 0; k < 3; k++) base[c * 3 + k] += 255 * (1 - a);
      }
    }
  }
  return { colours, base, px, weight, filledShare: Array.from(filled, (f, c) => (px[c] ? f / px[c] : 0)) };
}

// Mean ΔE2000 over the counted cells, for the gap colours tintOf(colour) -> [r, g, b].
function scoreCells(model, ai, cells, tintOf) {
  const tints = model.colours.map((c) => tintOf(c));
  let sum = 0;
  for (const c of cells) {
    const rgb = [0, 1, 2].map((k) => {
      let v = model.base[c * 3 + k];
      for (let j = 0; j < tints.length; j++) v += model.weight[c * tints.length + j] * tints[j][k];
      return v / model.px[c];
    });
    const aiRgb = [0, 1, 2].map((k) => ai.sum[c * 3 + k] / ai.count[c]);
    sum += deltaE2000(srgbToLab(aiRgb), srgbToLab(rgb));
  }
  return sum / cells.length;
}

// Everything one design needs for scoring: its models (by fill reach) and the counted cells.
export async function prepareDesign(design, runs) {
  const layout = layoutOf(design, runs);
  const { stoneLayout, shift } = deliveredOf(layout);
  const box = tintCanvasMm(stoneLayout);
  const cols = Math.ceil(box.widthMm / CELL_MM), rows = Math.ceil(box.heightMm / CELL_MM);
  const grid = { cols, rows, n: cols * rows };
  const ai = await aiCells(layout, design.ai, stoneLayout, box, shift, grid);
  const aiDrawn = await aiCells(layout, design.ai, stoneLayout, box, shift, grid, true);
  const model = cellModel(stoneLayout, box, grid);
  const cells = [];
  for (let c = 0; c < grid.n; c++) if (model.filledShare[c] >= MIN_FILLED && ai.share[c] >= MIN_AI) cells.push(c);
  return { design, layout, stoneLayout, box, grid, ai, aiDrawn, model, cells };
}

export const scoreRule = (prep, rule, asDrawn = false) =>
  scoreCells(prep.model, asDrawn ? prep.aiDrawn : prep.ai, prep.cells, (c) => gapRgb(fillOf(c), rule));

// The cell ΔE of an actual render (renderTinted's signature) on the design's counted cells.
export async function scoreRender(prep, render) {
  const longSidePx = Math.round(Math.max(prep.box.widthMm, prep.box.heightMm) * PX_PER_MM);
  const img = await decodeRgba(render(prep.stoneLayout, { longSidePx, background: "white" }).png);
  const sx = img.width / prep.box.widthMm, sy = img.height / prep.box.heightMm;
  const sum = new Float64Array(prep.grid.n * 3), n = new Float64Array(prep.grid.n);
  for (let y = 0; y < img.height; y++) {
    const cy = Math.floor((y + 0.5) / sy / CELL_MM);
    for (let x = 0; x < img.width; x++) {
      const cx = Math.floor((x + 0.5) / sx / CELL_MM);
      if (cx >= prep.grid.cols || cy >= prep.grid.rows) continue;
      const c = cy * prep.grid.cols + cx, p = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) sum[c * 3 + k] += img.data[p + k];
      n[c]++;
    }
  }
  const score = (ai) => {
    let total = 0;
    for (const c of prep.cells) {
      const rgb = [0, 1, 2].map((k) => sum[c * 3 + k] / n[c]);
      const aiRgb = [0, 1, 2].map((k) => ai.sum[c * 3 + k] / ai.count[c]);
      total += deltaE2000(srgbToLab(aiRgb), srgbToLab(rgb));
    }
    return total / prep.cells.length;
  };
  return { stones: score(prep.ai), asDrawn: score(prep.aiDrawn) };
}

// Gap visibility of a rule over the 47 catalogue colours: the gap's L* minus the fill's (negative:
// darker). Visible: at most -4, or at least +4 for a fill the rule lightens.
export function gapSteps(rule) {
  return Object.keys(STONE_COLORS).map((id) => {
    const l = lightnessOfHex(fillOf(id));
    const g = srgbToLab(gapRgb(fillOf(id), rule))[0];
    return { id, l, step: g - l };
  });
}
const visible = (rule) => gapSteps(rule).every(({ step }) => step <= -4 + 1e-6 || step >= 4 - 1e-6);

async function main(runs) {
  const preps = [];
  for (const d of ALL_DESIGNS) {
    preps.push(await prepareDesign(d, runs));
    console.error(`${d.id}: ${preps.at(-1).cells.length} cells`);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const scoreAll = (rule) => mean(preps.map((p) => scoreRule(p, rule)));

  const grid = [];
  for (const minStep of [4, 5, 6, 8]) for (const slope of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4])
    for (const fromL of [0, 20, 40, 60, 80]) for (const darkBelow of [0, 8, 12, 16, 20]) {
      const rule = { minStep, slope, fromL, darkBelow };
      if (slope === 0 && fromL > 0) continue; // same as fromL 0
      grid.push({ rule, visible: visible(rule), score: scoreAll(rule) });
    }
  grid.sort((a, b) => a.score - b.score);
  const best = grid.find((g) => g.visible);
  // References: no darkening (gaps invisible) and the stones layer under the old 0.85 tint.
  const reference = {
    noStep: scoreAll({ minStep: 0, slope: 0, fromL: 0, darkBelow: 0 }),
    before085: mean(preps.map((p) => scoreCells(p.model, p.ai, p.cells, (c) => beforeGapRgb(fillOf(c))))),
    asDrawn: {
      best: mean(preps.map((p) => scoreRule(p, best.rule, true))),
      noStep: mean(preps.map((p) => scoreRule(p, { minStep: 0, slope: 0, fromL: 0, darkBelow: 0 }, true))),
      before085: mean(preps.map((p) => scoreCells(p.model, p.aiDrawn, p.cells, (c) => beforeGapRgb(fillOf(c)))))
    }
  };
  // Fill reach, with the best rule: same counted cells (filled at FILL_REACH), the tint elsewhere
  // white.
  const reach = {};
  for (const r of [1.4, 1.5, 1.6, 1.7, 1.8]) {
    reach[r] = mean(preps.map((p) => {
      const model = cellModel(p.stoneLayout, p.box, p.grid, { fillReach: r });
      return scoreCells(model, p.ai, p.cells, (c) => gapRgb(fillOf(c), best.rule));
    }));
  }
  // Per design, actual renders: before (renderTintedBefore) and now (renderTinted, GAP_RULE).
  const designs = [];
  for (const p of preps) {
    designs.push({ id: p.design.id, cells: p.cells.length, before: await scoreRender(p, renderTintedBefore), after: await scoreRender(p, renderTinted),
      bestRuleModel: scoreRule(p, best.rule) });
  }
  const out = { runs: runs || null, cellMm: CELL_MM, gapRule: GAP_RULE, best, top: grid.slice(0, 15), topVisible: grid.filter((g) => g.visible).slice(0, 15),
    reference, reach, designs, steps: gapSteps(GAP_RULE) };
  const dir = new URL("../docs/IS-05b-results/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "tint-tune.json"), `${JSON.stringify(out, null, 1)}\n`);
  const avg = (k, j) => mean(designs.map((d) => d[k][j]));
  console.log(JSON.stringify({ best, top: grid.slice(0, 8).map((g) => [g.rule, g.visible, +g.score.toFixed(3)]), reference, reach,
    mean: { before: avg("before", "stones"), after: avg("after", "stones"), beforeAsDrawn: avg("before", "asDrawn"), afterAsDrawn: avg("after", "asDrawn") } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
