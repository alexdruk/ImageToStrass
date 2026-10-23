import { fillHoles } from "./holes.js";
import { MIN_GAP_MM, capStoneSizes, checkGaps, pupilCentres, stonesOfLayout, toStoneLayout } from "./tiers.js";

// Overlap cleanup (spec section 7.5), after the SS16 cap: for every pair of stones whose rim gap
// (centre distance minus both radii) is below 0.1 mm, the smaller stone is removed; on equal size
// the one with fewer neighbours, and on equal neighbours the later one in the layout. Pairs are
// taken worst gap first, and a pair whose stone is already gone is skipped, so afterwards no pair
// is closer than 0.1 mm. Neighbours are the other stones whose rim gap is below NEIGHBOUR_GAP_MM,
// counted once on the capped stones.
//
// Coverage after the cleanup: the service's coverage (share of subject-mask pixels under a stone)
// scaled by the area under the delivered stones over the area under the service's stones, both
// rasterised on the service's grid (COVERAGE_PX_PER_MM). It includes the cap's shrinking.
//
// Hole fill (experiment exp-holes, off unless cleanedLayout is given the AI image; docs/exp-holes.md):
// after the cleanup every hole in the subject gets a stone, SS6 first and then SS4, with the 0.1 mm
// gap to all stones, coloured from the AI image (holes.js). The gap check then runs as before.

export const NEIGHBOUR_GAP_MM = 0.5;
export const COVERAGE_PX_PER_MM = 10;

const EPS = 1e-9;
const rimGap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) - (a.d + b.d) / 2;

// Every pair { i, j, gap } of plain { x, y, d } stones with rim gap below maxGap, by a uniform grid.
function closePairs(stones, maxGap) {
  let dMax = 0;
  for (const s of stones) dMax = Math.max(dMax, s.d);
  const cell = dMax + Math.max(maxGap, 0) + EPS;
  const grid = new Map();
  stones.forEach((s, i) => {
    const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const pairs = [];
  stones.forEach((s, i) => {
    const gx = Math.floor(s.x / cell), gy = Math.floor(s.y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
          if (j <= i) continue;
          const gap = rimGap(s, stones[j]);
          if (gap < maxGap - EPS) pairs.push({ i, j, gap });
        }
      }
    }
  });
  return pairs;
}

// Plain { x, y, d, color } stones -> { stones (kept, in layout order), removed (indices) }.
export function removeCloseStones(stones) {
  const neighbours = new Array(stones.length).fill(0);
  for (const { i, j } of closePairs(stones, NEIGHBOUR_GAP_MM)) {
    neighbours[i]++;
    neighbours[j]++;
  }
  const pairs = closePairs(stones, MIN_GAP_MM).sort((a, b) => a.gap - b.gap || a.i - b.i || a.j - b.j);
  const gone = new Set();
  for (const { i, j } of pairs) {
    if (gone.has(i) || gone.has(j)) continue;
    const a = stones[i], b = stones[j];
    let loser;
    if (Math.abs(a.d - b.d) > EPS) loser = a.d < b.d ? i : j;
    else if (neighbours[i] !== neighbours[j]) loser = neighbours[i] < neighbours[j] ? i : j;
    else loser = j;
    gone.add(loser);
  }
  return { stones: stones.filter((_, i) => !gone.has(i)), removed: [...gone].sort((a, b) => a - b) };
}

// Pixels (at COVERAGE_PX_PER_MM, pixel centre inside a circle) under at least one stone.
function areaUnder(stones, box) {
  const ppmm = COVERAGE_PX_PER_MM;
  const w = Math.ceil((box.maxX - box.minX) * ppmm) + 1;
  const h = Math.ceil((box.maxY - box.minY) * ppmm) + 1;
  const occ = new Uint8Array(w * h);
  for (const s of stones) {
    const cx = (s.x - box.minX) * ppmm, cy = (s.y - box.minY) * ppmm, r = s.d / 2 * ppmm;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) occ[y * w + x] = 1;
      }
    }
  }
  let n = 0;
  for (const v of occ) n += v;
  return n;
}

function boxOf(stones) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of stones) {
    box.minX = Math.min(box.minX, s.x - s.d / 2);
    box.minY = Math.min(box.minY, s.y - s.d / 2);
    box.maxX = Math.max(box.maxX, s.x + s.d / 2);
    box.maxY = Math.max(box.maxY, s.y + s.d / 2);
  }
  return box;
}

// layout service answer -> the design's stones at natural size after the SS16 cap and the cleanup:
// { stoneLayout, gaps, capped, removed, removedShare, coverageBefore, coverage, filled }. removedShare
// is removed over the stones before the cleanup; coverageBefore is the service's own coverage.
// fillHolesIn: the AI image ({ data, width, height }, RGBA) to fill the holes from (exp-holes), or
// null (production); filled is the number of stones it added.
export function cleanedLayout(layout, { fillHolesIn = null } = {}) {
  const measured = stonesOfLayout(layout);
  if (measured.length === 0) throw new Error("The layout has no stones.");
  const { stones: capped, capped: cappedCount } = capStoneSizes(measured, pupilCentres(layout));
  const { stones: kept, removed } = removeCloseStones(capped);
  const filled = fillHolesIn ? fillHoles(kept, fillHolesIn, layout.report) : null;
  const delivered = filled ? filled.stones : kept;
  const box = boxOf(measured);
  const coverageBefore = Number(layout.report?.coverage);
  const coverage = coverageBefore * areaUnder(delivered, box) / areaUnder(measured, box);
  const { stoneLayout, stones } = toStoneLayout(delivered, 1);
  return {
    stoneLayout,
    gaps: checkGaps(stones),
    capped: cappedCount,
    removed: removed.length,
    removedShare: removed.length / capped.length,
    coverageBefore,
    coverage,
    filled: filled ? filled.added.length : 0
  };
}
