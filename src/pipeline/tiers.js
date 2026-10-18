import { Stone } from "../stones/Stone.js";
import { StoneLayout, findOverlappingStonePairs } from "../stones/StoneLayout.js";
import { getStoneSize, listAllStoneSizes } from "../stones/StoneSizes.js";

// Natural size (spec section 7.5): every design is delivered at the size the layout service measured,
// built by naturalLayout() below.
//
// Stone-size tiers: kept with their tests but unused, for a possible later "more sizes" option. The
// layout service's stones (mm, natural size about 130-170 mm on the longest side) become the design
// at a longest side T >= L0:
//   1. the largest tier k with L0 * k <= T;
//   2. positions and diameters scaled by k, every diameter snapped down to a standard size;
//   3. positions only scaled by r >= 1 so the longest side is exactly T;
//   4. the gap check (no overlap, every gap at least 0.1 mm); a violation fails the attempt.
// L0 and "longest side" are the stones' footprint box (centre +/- radius), as StoneLayout measures.
// r is solved so the footprint box is exactly T after snapping; it is never below T / (L0 * k).
// T below L0 is refused: shrinking would close the gaps.

export const TIERS = Object.freeze([1.0, 1.4, 2.0, 2.35, 3.2]);
export const MIN_GAP_MM = 0.1;
export const LAYER_ID = "design";

const EPS = 1e-9;
const SIZES = listAllStoneSizes(); // ascending diameter, SS4 included

// The largest standard size whose diameter is at most d (the smallest size if d is below it).
export function snapDown(d) {
  let best = SIZES[0];
  for (const size of SIZES) {
    if (size.diameterMm <= d + EPS) best = size;
  }
  return best;
}

export function chooseTier(l0, target) {
  let k = TIERS[0];
  for (const tier of TIERS) {
    if (l0 * tier <= target + EPS) k = tier;
  }
  return k;
}

// Footprint box of plain { x, y, d } stones.
function footprint(stones, scale = 1) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stones) {
    const h = s.d / 2;
    minX = Math.min(minX, s.x * scale - h);
    minY = Math.min(minY, s.y * scale - h);
    maxX = Math.max(maxX, s.x * scale + h);
    maxY = Math.max(maxY, s.y * scale + h);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

const longest = (box) => Math.max(box.width, box.height);

// The layout service answer -> plain { x, y, d, color } stones.
export function stonesOfLayout(layout) {
  return layout.stones.map(([x, y, sizeId, color]) => {
    const size = getStoneSize(sizeId);
    if (!size) throw new Error(`Unknown stone size: ${sizeId}`);
    return { x, y, d: size.diameterMm, color };
  });
}

// The smallest r with longest(footprint at r) >= target; longest() grows with r.
function solveStretch(stones, target, r0) {
  let lo = r0;
  let hi = r0;
  while (longest(footprint(stones, hi)) < target) hi *= 1.01;
  for (let i = 0; i < 60 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (longest(footprint(stones, mid)) < target) lo = mid; else hi = mid;
  }
  return hi;
}

// Smallest rim gap (centre distance minus both radii) over neighbouring stones, by a uniform grid.
export function minRimGap(stones) {
  let dMax = 0;
  for (const s of stones) dMax = Math.max(dMax, s.sizeMm);
  const cell = dMax + 1;
  const grid = new Map();
  const key = (gx, gy) => `${gx},${gy}`;
  for (const s of stones) {
    const k = key(Math.floor(s.xMm / cell), Math.floor(s.yMm / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  let min = Infinity;
  let below = 0;
  for (const s of stones) {
    const gx = Math.floor(s.xMm / cell), gy = Math.floor(s.yMm / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const o of grid.get(key(gx + dx, gy + dy)) || []) {
          if (o === s) continue;
          const gap = Math.hypot(s.xMm - o.xMm, s.yMm - o.yMm) - (s.sizeMm + o.sizeMm) / 2;
          if (gap < min) min = gap;
          if (gap < MIN_GAP_MM - EPS) below++;
        }
      }
    }
  }
  return { minGapMm: stones.length > 1 ? min : null, belowMinGap: below / 2 };
}

// Step 4. { ok, overlaps, belowMinGap, minGapMm }.
export function checkGaps(stones) {
  const overlaps = findOverlappingStonePairs(stones).length;
  const { minGapMm, belowMinGap } = minRimGap(stones);
  return { ok: overlaps === 0 && belowMinGap === 0, overlaps, belowMinGap, minGapMm };
}

// Plain { x, y, d, color } stones scaled by r -> StoneLayout with its footprint box at the origin.
function toStoneLayout(stones, r) {
  const box = footprint(stones, r);
  const placed = stones.map((s, index) => new Stone({
    xMm: s.x * r - box.minX,
    yMm: s.y * r - box.minY,
    sizeMm: s.d,
    color: s.color,
    layerId: LAYER_ID,
    index
  }));
  return { stoneLayout: new StoneLayout({ layerId: LAYER_ID, sourceMode: "is", stones: placed }), stones: placed };
}

// layout service answer -> { stoneLayout, gaps } at the natural size: positions and diameters as
// measured, only moved so the footprint box starts at the origin.
export function naturalLayout(layout) {
  const natural = stonesOfLayout(layout);
  if (natural.length === 0) throw new Error("The layout has no stones.");
  const { stoneLayout, stones } = toStoneLayout(natural, 1);
  return { stoneLayout, gaps: checkGaps(stones) };
}

// layout service answer + T (mm, at least L0) -> { stoneLayout, tier: { k, r, r0, l0Mm }, gaps }.
export function applyTier(layout, targetMm) {
  const natural = stonesOfLayout(layout);
  if (natural.length === 0) throw new Error("The layout has no stones.");
  const l0 = longest(footprint(natural));
  if (targetMm < l0 - EPS) throw new RangeError(`T ${targetMm} mm is below the natural size ${l0} mm.`);
  const k = chooseTier(l0, targetMm);
  const tiered = natural.map((s) => ({ x: s.x * k, y: s.y * k, d: snapDown(s.d * k).diameterMm, color: s.color }));
  const r0 = Math.max(1, targetMm / (l0 * k));
  const r = solveStretch(tiered, targetMm, r0);
  const { stoneLayout, stones } = toStoneLayout(tiered, r);
  return { stoneLayout, tier: { k, r, r0, l0Mm: l0 }, gaps: checkGaps(stones) };
}
