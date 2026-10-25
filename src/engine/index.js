import { mapBlackAndWhiteFromImage } from "../pipeline/bw.js";
import { cleanedLayout } from "../pipeline/cleanup.js";
import { checkGaps, toStoneLayout } from "../pipeline/tiers.js";
import { buildMap, mapPicture, mapToJSON } from "./map.js";
import { placeStones } from "./place.js";

// The stone placement engine of the design concept (exp-engine, docs/IS-DESIGN-CONCEPT.md,
// docs/exp-engine.md). Experimental: the pipeline uses it only with IS_ENGINE=concept; the default
// stays today's (spec 7.5, 7.6). The layout service is used as it is: for its detections
// (report.discsAtMm), its face and pupils, and its frame (report.mmPerPx, offsetMm), so the design
// keeps today's natural size and frame.

export { buildMap, mapPicture, mapToJSON, placeStones };

// Today's design (spec 7.5 and 7.6) as plain { x, y, d, color } stones in the layout's mm, with
// cleanedLayout's answer (natural).
export function todaysDesign(layout, ai, { mode = "colour", threshold = 55, fillHoles = true, serviceFillNeighbours = false } = {}) {
  const natural = cleanedLayout(layout, { fillHolesIn: fillHoles ? ai : null, serviceFillNeighbours });
  const stoneLayout = mode === "bw"
    ? mapBlackAndWhiteFromImage(natural.stoneLayout, ai, { ...layout.report, originMm: natural.originMm }, threshold, natural.voted)
    : natural.stoneLayout;
  const [ox, oy] = natural.originMm;
  return { natural, stoneLayout, stones: stoneLayout.stones.map((s) => ({ x: s.xMm + ox, y: s.yMm + oy, d: s.sizeMm, color: s.color })) };
}

// /layout answer + AI image ({ data, width, height } RGBA) + today's stones (todaysDesign().stones)
// -> { map, stones (plain, layout mm, with role, chain, area), chains, stats, stoneLayout (footprint
// at the origin, as today's), originMm, gaps, ms }. mode "colour" or "bw"; style: the black & white
// style ("halftone" or "stencil", spec 7.2 BW_STYLE).
export function engineLayout(layout, ai, { mode = "colour", style = "halftone", threshold = 55, today = [] } = {}) {
  const t0 = performance.now();
  const map = buildMap(layout, ai, { mode, style, threshold });
  const t1 = performance.now();
  const { stones, chains, stats } = placeStones(map, ai, { today });
  const t2 = performance.now();
  const { stoneLayout, stones: placed, originMm } = toStoneLayout(stones, 1);
  return {
    map, stones, chains, stats, stoneLayout, originMm,
    gaps: checkGaps(placed),
    ms: { map: Math.round(t1 - t0), place: Math.round(t2 - t1) }
  };
}
