// From Rhinestone-Studio @38cd831 src/geometry/LineDesignSampler.js
// IS: an excerpt. Only the raster and path helpers below are copied, unchanged (lines 196-641 of
// the RS file: dilateMask ... densifyRingForWalk); the RS imports they do not use, the colour stages
// and generateLineDesignStonePoints() are left out. The export list at the end is IS's.

import { rawGridDistanceTransform } from './ContourRingSampler.js';

// ---- Raster morphology: disk dilation/erosion via rawGridDistanceTransform() --------------------

function dilateMask(mask, cols, rows, cellSizeMm, radiusMm) {
  if (!(radiusMm > 0)) return Uint8Array.from(mask);
  const complement = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) complement[i] = mask[i] ? 0 : 1;
  const distToMask = rawGridDistanceTransform(complement, cols, rows, cellSizeMm);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = distToMask[i] <= radiusMm ? 1 : 0;
  return out;
}

function erodeMask(mask, cols, rows, cellSizeMm, radiusMm) {
  if (!(radiusMm > 0)) return Uint8Array.from(mask);
  const distToBackground = rawGridDistanceTransform(mask, cols, rows, cellSizeMm);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = (mask[i] && distToBackground[i] >= radiusMm) ? 1 : 0;
  return out;
}

// ---- Zhang-Suen thinning ---------------------------------------------------------------------

// Standard 2-subiteration Zhang-Suen skeletonization over a binary raster. p2..p9 are the 8
// neighbours in clockwise order starting north, matching the algorithm's own canonical numbering.
function zhangSuenThin(mask, cols, rows) {
  const img = Uint8Array.from(mask);
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows) ? 0 : img[y * cols + x];

  const collectRemovals = (subiter) => {
    const removals = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!at(x, y)) continue;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
        const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0;
        for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
        if (A !== 1) continue;
        if (subiter === 1) {
          if (p2 * p4 * p6 !== 0) continue;
          if (p4 * p6 * p8 !== 0) continue;
        } else {
          if (p2 * p4 * p8 !== 0) continue;
          if (p2 * p6 * p8 !== 0) continue;
        }
        removals.push(y * cols + x);
      }
    }
    return removals;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const removals1 = collectRemovals(1);
    if (removals1.length) { for (const idx of removals1) img[idx] = 0; changed = true; }
    const removals2 = collectRemovals(2);
    if (removals2.length) { for (const idx of removals2) img[idx] = 0; changed = true; }
  }

  // Standard Zhang-Suen follow-up: the algorithm can converge with an un-thinned 2x2 block left on
  // some diagonal runs (a well-known limitation of the algorithm, not specific to this fixture --
  // measured here on the antenna chains' own diagonal segments, each block a spurious degree-3/4
  // junction that fragments an otherwise-clean run into pieces under D2's minimum traced-path
  // length). Repeatedly drops the bottom-right corner of every remaining all-foreground 2x2 block
  // until none remain -- removing one corner of a 2x2 block can never disconnect it (the other three
  // pixels stay mutually 8-adjacent), so this cannot change which pixels are reachable from which.
  let blockChanged = true;
  while (blockChanged) {
    blockChanged = false;
    const removals = [];
    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < cols - 1; x++) {
        if (at(x, y) && at(x + 1, y) && at(x, y + 1) && at(x + 1, y + 1)) {
          removals.push((y + 1) * cols + (x + 1));
        }
      }
    }
    if (removals.length) { for (const idx of removals) img[idx] = 0; blockChanged = true; }
  }

  return img;
}

// ---- Connected-component labelling (8-connected) + bounding-box-diagonal length measure ---------

function labelComponents8(mask, cols, rows) {
  const pixelCount = cols * rows;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  for (let start = 0; start < pixelCount; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; visited[start] = 1;
    const comp = [];
    while (head < tail) {
      const idx = queue[head++];
      comp.push(idx);
      const x = idx % cols, y = (idx - x) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (mask[nIdx] && !visited[nIdx]) { visited[nIdx] = 1; queue[tail++] = nIdx; }
        }
      }
    }
    components.push(comp);
  }
  return components;
}

function bboxDiagonalMm(comp, cols, mmPerPx) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const idx of comp) {
    const x = idx % cols, y = (idx - x) / cols;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot((maxX - minX) * mmPerPx, (maxY - minY) * mmPerPx);
}

// ---- Skeleton -> polylines: trace edges out of every non-degree-2 node, plus any leftover cycles -

// A junction-clustering tracer. Zhang-Suen thinning can leave a persistent, several-pixel-long
// double-strand ("staircase") on some diagonal runs -- not just an isolated 2x2 block (already
// cleaned up in zhangSuenThin() above), a genuinely thicker artifact of adjacent degree-3/4 pixels
// running alongside an otherwise-clean 1px path. Tracing each of those pixels as its own separate
// branch point (the naive reading of "trace edges out of every non-degree-2 node") fragments what
// should be one long run into dozens of sub-pitch pieces -- several of which independently clear
// D2's minimum traced-path length and race each other for the same physical space via the shared
// chainHash in generateLineDesignStonePoints(), starving the genuine long run of every candidate
// position. Every mutually-8-adjacent group of non-degree-2 pixels is instead clustered into one
// logical node (position = the cluster's own pixel centroid) before tracing; a clean single-pixel
// junction is simply a cluster of one, so this is a superset of the naive behaviour, not a
// different one. The remaining, expected fragmentation (see the spec's own "Defect found: skeleton
// junction fragmentation") still happens at genuine branch points and is still filtered afterward by
// the minimum traced-path length, not fixed at the tracer.
//
// Returns {points:[{xPx,yPx},...], closed}[] -- fractional pixel coordinates, since a cluster's own
// point is its member pixels' centroid, not one pixel's centre.
function traceSkeletonPaths(pixelIndices, cols, rows) {
  const pixelSet = new Set(pixelIndices);
  const NEI8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const neighboursOf = (idx) => {
    const x = idx % cols, y = (idx - x) / cols;
    const out = [];
    for (const [dx, dy] of NEI8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nIdx = ny * cols + nx;
      if (pixelSet.has(nIdx)) out.push(nIdx);
    }
    return out;
  };
  const degree = new Map();
  for (const idx of pixelIndices) degree.set(idx, neighboursOf(idx).length);
  const pixelPoint = (idx) => {
    const x = idx % cols;
    return { xPx: x, yPx: (idx - x) / cols };
  };

  // Union-find clustering of every mutually-8-adjacent non-degree-2 pixel.
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const next = parent.get(x); parent.set(x, r); x = next; }
    return r;
  };
  for (const idx of pixelIndices) if (degree.get(idx) !== 2) parent.set(idx, idx);
  for (const idx of pixelIndices) {
    if (degree.get(idx) === 2) continue;
    for (const n of neighboursOf(idx)) {
      if (degree.get(n) === 2) continue;
      const ra = find(idx), rb = find(n);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const clusterMembers = new Map();
  for (const idx of pixelIndices) {
    if (degree.get(idx) === 2) continue;
    const root = find(idx);
    if (!clusterMembers.has(root)) clusterMembers.set(root, []);
    clusterMembers.get(root).push(idx);
  }
  const clusterCentroid = new Map();
  for (const [root, members] of clusterMembers) {
    let sx = 0, sy = 0;
    for (const idx of members) { const p = pixelPoint(idx); sx += p.xPx; sy += p.yPx; }
    clusterCentroid.set(root, { xPx: sx / members.length, yPx: sy / members.length });
  }
  const nodeRootOf = (idx) => (degree.get(idx) === 2 ? null : find(idx));

  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const visitedEdge = new Set();
  const visitedChainPixel = new Set();
  const paths = [];

  // Walks a run of degree-2 pixels starting at `n` (an immediate neighbour of some cluster member
  // `prev`), consuming edges until it reaches another node (cluster) or a dead end.
  const walkChain = (prev, n) => {
    const points = [];
    let cur = n;
    while (degree.get(cur) === 2) {
      points.push(pixelPoint(cur));
      visitedChainPixel.add(cur);
      const options = neighboursOf(cur).filter((m) => m !== prev);
      let next = null;
      for (const m of options) {
        if (!visitedEdge.has(edgeKey(cur, m))) { next = m; break; }
      }
      if (next === null) return { points, endRoot: null };
      visitedEdge.add(edgeKey(cur, next));
      prev = cur; cur = next;
    }
    points.push(pixelPoint(cur));
    return { points, endRoot: nodeRootOf(cur) };
  };

  for (const [root, members] of clusterMembers) {
    for (const m of members) {
      for (const n of neighboursOf(m)) {
        if (nodeRootOf(n) === root) continue; // internal cluster edge, not a real branch
        const key0 = edgeKey(m, n);
        if (visitedEdge.has(key0)) continue;
        visitedEdge.add(key0);
        const walked = degree.get(n) === 2 ? walkChain(m, n) : { points: [], endRoot: nodeRootOf(n) };
        const points = [clusterCentroid.get(root), ...walked.points];
        if (walked.endRoot !== null) points.push(clusterCentroid.get(walked.endRoot));
        paths.push({ points, closed: false });
      }
    }
  }

  // Leftover pure cycles: loops with no cluster (no junction/dead-end) touching them at all -- every
  // pixel on them is degree-2 and untouched by any cluster walk above.
  for (const startIdx of pixelIndices) {
    if (visitedChainPixel.has(startIdx) || degree.get(startIdx) !== 2) continue;
    const points = [pixelPoint(startIdx)];
    visitedChainPixel.add(startIdx);
    let prev = startIdx;
    let cur = neighboursOf(startIdx)[0];
    visitedEdge.add(edgeKey(prev, cur));
    points.push(pixelPoint(cur));
    visitedChainPixel.add(cur);
    while (cur !== startIdx) {
      const options = neighboursOf(cur).filter((m) => m !== prev);
      let next = null;
      for (const m of options) {
        if (m === startIdx) { next = m; break; }
        if (!visitedEdge.has(edgeKey(cur, m))) { next = m; break; }
      }
      if (next === null) break;
      visitedEdge.add(edgeKey(cur, next));
      prev = cur; cur = next;
      if (cur !== startIdx) { points.push(pixelPoint(cur)); visitedChainPixel.add(cur); }
    }
    paths.push({ points, closed: true });
  }

  return paths;
}

// ---- Path smoothing (boxcar, edge-padded/circular) + chord-distance placement --------------------

const SMOOTH_WINDOW = 5;

function smoothPolyline(points, windowSize, closed) {
  const n = points.length;
  if (n < 3 || windowSize <= 1) return points;
  const half = Math.floor(windowSize / 2);
  const get = closed
    ? (i) => points[((i % n) + n) % n]
    : (i) => points[Math.min(n - 1, Math.max(0, i))];
  const out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, count = 0;
    for (let k = -half; k <= half; k++) {
      const p = get(i + k);
      sx += p.xMm; sy += p.yMm; count++;
    }
    out.push({ xMm: sx / count, yMm: sy / count });
  }
  return out;
}

function polylineLengthMm(points) {
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    sum += Math.hypot(points[i + 1].xMm - points[i].xMm, points[i + 1].yMm - points[i].yMm);
  }
  return sum;
}

// New: walks forward from the last PLACED point until straight-line (chord) distance reaches
// `pitchMm`, not arc length -- see docs/specifications/IMG-010-LineDesign.md Task A item 5 (every
// existing path-placement primitive in this codebase walks by arc length, the documented failure
// mode this mode must avoid on bends). Densifies the path to a fine step first and scans forward,
// so a candidate `isAcceptable()` rejects cleanly falls through to the next, slightly-further
// candidate rather than solving one crossing per source segment and getting stuck once that single
// candidate is rejected (outline and line chains are placed independently of each other -- see
// generateLineDesignStonePoints()'s own shared chainHash -- so a rim's line-chain candidate landing
// on top of an already-placed outline stone is expected, not exceptional, and must be skippable).
function resampleByChordDistance(points, pitchMm, closed, isAcceptable = () => true) {
  if (points.length === 0) return [];
  const path = closed ? [...points, points[0]] : points;
  const stepMm = pitchMm / 20;
  const dense = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    dense.push(a);
    const segLenMm = Math.hypot(b.xMm - a.xMm, b.yMm - a.yMm);
    const steps = Math.floor(segLenMm / stepMm);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      dense.push({ xMm: a.xMm + (b.xMm - a.xMm) * t, yMm: a.yMm + (b.yMm - a.yMm) * t });
    }
  }
  dense.push(path[path.length - 1]);

  let startIdx = 0;
  while (startIdx < dense.length && !isAcceptable(dense[startIdx])) startIdx++;
  if (startIdx >= dense.length) return [];

  // A source polygon that folds back near itself (a concave-corner pinch in an eroded/offset
  // contour, e.g. where two silhouette lobes meet) can bring a LATER point within pitchMm of an
  // EARLIER placed point that isn't the immediately-preceding one -- the plain "distance from the
  // last placed point" check above can't see that. Guarding against every already-placed point on
  // this same path (not just the walk's own chainHash, which only covers OTHER paths) closes that
  // gap; a normal, non-self-intersecting run never has two placed points within pitchMm of each
  // other anyway, so this is a no-op there.
  const tooCloseToAnyPlaced = (p) => placed.some((q) => Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm) < pitchMm);

  const placed = [dense[startIdx]];
  let last = dense[startIdx];
  for (let i = startIdx + 1; i < dense.length; i++) {
    const p = dense[i];
    if (Math.hypot(p.xMm - last.xMm, p.yMm - last.yMm) < pitchMm) continue;
    if (!isAcceptable(p)) continue;
    if (tooCloseToAnyPlaced(p)) continue;
    placed.push(p);
    last = p;
  }

  if (closed && placed.length > 1) {
    const first = placed[0], lastPlaced = placed[placed.length - 1];
    if (Math.hypot(first.xMm - lastPlaced.xMm, first.yMm - lastPlaced.yMm) < pitchMm) {
      // The ring's true perimeter is rarely an exact multiple of the pitch -- rather than overlap
      // the seam, drop the extra stone (a slightly wider closing gap there, never an overlap).
      placed.pop();
    }
  }
  return placed;
}

// ---- Incremental spatial hash: outline+line share ONE growing accept/reject index ---------------

// Outline (decision c) and line chains (decision d) are traced independently of each other (and
// line chains from different components/paths are traced independently of one another), so nothing
// otherwise stops two of them from placing a stone in the same spot -- most visibly the rim band's
// own would-be line chain landing on top of the outline chain that already occupies that same
// one-radius-in band (see the spec's own "the outline chain runs first and already occupies that
// band" note). This is a real accept/reject index (not the fill stage's read-only
// buildSpatialHash()/hashHasWithin() below): `.add()` grows it as each chain is placed, in decision
// order (outline first, then line chains), so a later chain's candidates are rejected against every
// earlier chain's already-accepted stones.
function createIncrementalHash(cellSizeMm) {
  const buckets = new Map();
  const keyOf = (xMm, yMm) => `${Math.floor(xMm / cellSizeMm)},${Math.floor(yMm / cellSizeMm)}`;
  return {
    add(stone) {
      const key = keyOf(stone.xMm, stone.yMm);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(stone);
    },
    overlaps(xMm, yMm, sizeMm, gapMm) {
      const gx = Math.floor(xMm / cellSizeMm), gy = Math.floor(yMm / cellSizeMm);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = buckets.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const s of bucket) {
            const ddx = xMm - s.xMm, ddy = yMm - s.yMm;
            const minSepMm = (sizeMm + s.sizeMm) / 2 + gapMm;
            if (ddx * ddx + ddy * ddy < minSepMm * minSepMm) return true;
          }
        }
      }
      return false;
    }
  };
}

// ---- Spatial hash (grid-bucket) for the fill-ring free-space test --------------------------------

function buildSpatialHash(stones, cellSizeMm) {
  const buckets = new Map();
  const keyOf = (xMm, yMm) => `${Math.floor(xMm / cellSizeMm)},${Math.floor(yMm / cellSizeMm)}`;
  for (const s of stones) {
    const key = keyOf(s.xMm, s.yMm);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  return { buckets, cellSizeMm };
}

function hashHasWithin(hash, xMm, yMm, reachMm) {
  const gx = Math.floor(xMm / hash.cellSizeMm), gy = Math.floor(yMm / hash.cellSizeMm);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = hash.buckets.get(`${gx + dx},${gy + dy}`);
      if (!bucket) continue;
      for (const s of bucket) {
        const ddx = xMm - s.xMm, ddy = yMm - s.yMm;
        if (ddx * ddx + ddy * ddy < reachMm * reachMm) return true;
      }
    }
  }
  return false;
}

function densifyRingForWalk(loop, stepMm) {
  const out = [];
  const n = loop.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    out.push(a);
    const segLenMm = Math.hypot(b.xMm - a.xMm, b.yMm - a.yMm);
    const steps = Math.floor(segLenMm / stepMm);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      out.push({ xMm: a.xMm + (b.xMm - a.xMm) * t, yMm: a.yMm + (b.yMm - a.yMm) * t });
    }
  }
  return out;
}

// IS: the helpers the engine uses (src/engine/).
export {
  dilateMask, erodeMask, zhangSuenThin, labelComponents8, bboxDiagonalMm, traceSkeletonPaths, SMOOTH_WINDOW,
  smoothPolyline, polylineLengthMm, resampleByChordDistance, createIncrementalHash, buildSpatialHash, hashHasWithin,
  densifyRingForWalk
};
