// IS-05b colour diagnosis (tools only): for every delivered stone of a design (the strass /layout
// answer after the SS16 cap and the overlap cleanup), the AI image colour under the stone (mean Lab
// of the inner 60 % of its disc radius, opaque pixels only) and its CIE ΔE2000 to
//   (a) the nearest catalogue colour (plain ΔE2000 over every catalogue fill),
//   (b) the colour the service assigned (its catalogue fill),
//   (c) the stone as rendered in the tinted view (mean Lab of the inner 60 % of the rendered disc),
// plus (t) the tint around the stone (fill × 0.85, spec section 8 step 3).
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { capStoneSizes, pupilCentres, stonesOfLayout, toStoneLayout } from "../src/pipeline/tiers.js";
import { removeCloseStones } from "../src/pipeline/cleanup.js";
import { TINT_BRIGHTNESS, renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { deltaE2000, discLab, hexToLab, mean, quantile, srgbToLab } from "./colour-diff.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const CATALOGUE = JSON.parse(readFileSync(path.join(ROOT, "services/strass/strass_layout/catalogue.json"), "utf8"));
export const CAT_IDS = Object.keys(CATALOGUE);
export const CAT_LAB = Object.fromEntries(CAT_IDS.map((k) => [k, hexToLab(CATALOGUE[k].fill)]));
const TINT_LAB = Object.fromEntries(CAT_IDS.map((k) => {
  const h = CATALOGUE[k].fill.replace("#", "");
  return [k, srgbToLab([0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * TINT_BRIGHTNESS)))];
}));
export const SAMPLE_SHARE = 0.6;
const RENDER_PX_PER_MM = 24;

export function nearestCatalogue(lab) {
  let best = null, bestDe = Infinity;
  for (const k of CAT_IDS) {
    const de = deltaE2000(lab, CAT_LAB[k]);
    if (de < bestDe) { best = k; bestDe = de; }
  }
  return { id: best, de: bestDe };
}

// layout -> { stoneLayout, kept: [{ x, y, d, color, layoutIndex }] in service mm (frame = x +
// offsetMm) }, the delivered stones (cap and cleanup as cleanedLayout).
export function delivered(layout) {
  const { stones: capped } = capStoneSizes(stonesOfLayout(layout), pupilCentres(layout));
  const { stones: kept, removed } = removeCloseStones(capped.map((s, layoutIndex) => ({ ...s, layoutIndex })));
  return { stoneLayout: toStoneLayout(kept, 1).stoneLayout, kept, removed: removed.length };
}

export async function decodeRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Per-stone records for one layout and its AI image (a PNG path or decoded RGBA).
export async function measure(layout, ai) {
  const img = typeof ai === "string" ? await decodeRgba(ai) : ai;
  const { stoneLayout, kept } = delivered(layout);
  const [offX, offY] = layout.report.offsetMm;
  const s = layout.report.mmPerPx;
  const box = tintCanvasMm(stoneLayout);
  const longSidePx = Math.round(Math.max(box.widthMm, box.heightMm) * RENDER_PX_PER_MM);
  const render = renderTinted(stoneLayout, { longSidePx, background: "white" });
  const rimg = await decodeRgba(render.png);
  const out = [];
  kept.forEach((st, i) => {
    const placed = stoneLayout.stones[i];
    const aiLab = discLab(img, (st.x + offX) / s, (st.y + offY) / s, SAMPLE_SHARE * st.d / 2 / s);
    if (!aiLab) return;
    const near = nearestCatalogue(aiLab);
    const rLab = discLab(rimg, (placed.xMm - box.minXmm) * render.scale, (placed.yMm - box.minYmm) * render.scale,
      SAMPLE_SHARE * placed.sizeMm / 2 * render.scale);
    out.push({
      index: i, layoutIndex: st.layoutIndex, x: st.x, y: st.y, d: st.d, aiLab, nearest: near.id, assigned: st.color,
      deA: near.de, deB: deltaE2000(aiLab, CAT_LAB[st.color]), deC: deltaE2000(aiLab, rLab), deT: deltaE2000(aiLab, TINT_LAB[st.color])
    });
  });
  return out;
}

// Mean and 90th percentile ΔE2000 from the AI colour to the colour each stone had after every
// colour step of the service (stages from scripts/is05b_runs.py, aligned with the layout's stones).
export function stageSummary(records, stages) {
  return stages.stages.map((name, k) => {
    const de = records.map((r) => deltaE2000(r.aiLab, CAT_LAB[stages.colours[r.layoutIndex][k]]));
    const changed = records.filter((r) => k > 0 && stages.colours[r.layoutIndex][k] !== stages.colours[r.layoutIndex][k - 1]).length;
    return { stage: name, mean: mean(de), p90: quantile(de, 0.9), changed };
  });
}

export function summary(records) {
  const pick = (k) => records.map((r) => r[k]);
  const stat = (k) => ({ mean: mean(pick(k)), p90: quantile(pick(k), 0.9) });
  const changes = new Map();
  for (const r of records) {
    if (r.nearest === r.assigned) continue;
    const key = `${r.nearest} → ${r.assigned}`;
    changes.set(key, (changes.get(key) || 0) + 1);
  }
  return {
    n: records.length,
    changed: records.filter((r) => r.nearest !== r.assigned).length,
    a: stat("deA"), b: stat("deB"), c: stat("deC"), t: stat("deT"),
    top: [...changes].sort((x, y) => y[1] - x[1]).slice(0, 10)
  };
}
