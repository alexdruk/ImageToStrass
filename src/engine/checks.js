import { MIN_GAP_MM } from "../pipeline/tiers.js";
import { inAnyRegion } from "./faces.js";
import { MIN_PATCH, MAX_TONES } from "./map.js";
import { neighbourLists } from "./place.js";

// The checks of the design concept (docs/IS-DESIGN-CONCEPT.md section 8), 1 to 4, for any design:
// today's and the engine's alike, both measured against the engine's map of the same AI image (so
// the lines and areas are the same for both). Stones: plain { x, y, d, color } in layout mm.
//
//   1. Gaps: pairs closer than MIN_GAP_MM (0.1 mm) rim to rim, and the smallest gap.
//   2. Lines, along every line of the map, from its first to its last stone in the line's colour (a
//      line with none is missing): the stones on it (centre within ON_LINE_MM of its path) must all
//      have the line's colour and size, and it must have no break: no stretch longer than
//      BREAK_PITCHES stone steps without a stone. Engine
//      designs also report their own chains (every stone the chain's colour and size, at least 3).
//   3. Areas: the stones of each map area (not on a line, not in the outline band along the edge,
//      not in a face region) have at most MAX_TONES colours, and no patch (stones of one colour
//      touching, rim gap below PATCH_GAP_MM, in one area) has fewer than MIN_PATCH stones. A
//      halftone area's pattern is meant (concept section 6), so its patches are counted apart.
//   4. Holes: empty circles inside the subject (the AI image's closed alpha, as the hole fill
//      reads it) wider than MAX_HOLE_MM, by the cells (map grid) whose distance to every stone edge
//      and to the subject's edge is above MAX_HOLE_MM / 2; each connected piece is one hole.

export const ON_LINE_MM = 0.8;
export const BREAK_PITCHES = 1.5;
export const OUTLINE_BAND_MM = 1.6;
export const MAX_HOLE_MM = 1.0;
export const PATCH_GAP_MM = 0.6;

const EPS = 1e-9;

function hashOf(stones, cell = 5) {
  const map = new Map();
  stones.forEach((s, i) => {
    const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  });
  return {
    near(x, y, reach) {
      const out = [];
      const r = Math.ceil(reach / cell);
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (const i of map.get(`${gx + a},${gy + b}`) || []) out.push(i);
      return out;
    }
  };
}

export function checkGapsOf(stones) {
  const h = hashOf(stones);
  let violations = 0, min = Infinity;
  stones.forEach((s, i) => {
    for (const j of h.near(s.x, s.y, s.d + 5)) {
      if (j <= i) continue;
      const o = stones[j];
      const gap = Math.hypot(s.x - o.x, s.y - o.y) - (s.d + o.d) / 2;
      if (gap < min) min = gap;
      if (gap < MIN_GAP_MM - EPS) violations++;
    }
  });
  return { violations, minGapMm: Number.isFinite(min) ? Math.round(min * 1000) / 1000 : null, pass: violations === 0 };
}

// Points every step mm along a polyline.
function walk(points, closed, step) {
  const pts = closed ? [...points, points[0]] : points;
  const out = [];
  for (let q = 0; q + 1 < pts.length; q++) {
    const a = pts[q], b = pts[q + 1], len = Math.hypot(b.xMm - a.xMm, b.yMm - a.yMm), n = Math.max(1, Math.ceil(len / step));
    for (let t = 0; t < n; t++) out.push({ x: a.xMm + (b.xMm - a.xMm) * t / n, y: a.yMm + (b.yMm - a.yMm) * t / n });
  }
  return out;
}

export function checkLines(stones, map, chains = null) {
  const h = hashOf(stones);
  const onLine = new Int32Array(stones.length).fill(-1);
  const rows = [];
  for (const line of map.lines) {
    // The line runs from its first to its last stone in its own colour; stones beyond are not in it.
    const samples = walk(line.points, line.closed, 0.2);
    const hits = samples.map((p) => h.near(p.x, p.y, ON_LINE_MM).filter((i) => Math.hypot(stones[i].x - p.x, stones[i].y - p.y) <= ON_LINE_MM));
    const own = hits.map((list) => list.some((i) => stones[i].color === line.colour));
    const from = own.indexOf(true), to = own.lastIndexOf(true);
    const on = new Set();
    const covered = hits.map((list, q) => {
      if (from < 0 || q < from || q > to) return false;
      for (const i of list) on.add(i);
      return list.length > 0;
    });
    for (const i of on) if (onLine[i] < 0) onLine[i] = line.id;
    const pitch = line.d + 0.15;
    const first = covered.indexOf(true), last = covered.lastIndexOf(true);
    let breaks = 0, run = 0;
    for (let q = first; first >= 0 && q <= last; q++) {
      if (covered[q]) { if (run * 0.2 > BREAK_PITCHES * pitch) breaks++; run = 0; } else run++;
    }
    const members = [...on].map((i) => stones[i]);
    const offColour = members.filter((s) => s.color !== line.colour).length;
    const offSize = members.filter((s) => Math.abs(s.d - line.d) > 0.05).length;
    rows.push({ id: line.id, stones: members.length, offColour, offSize, breaks, missing: from < 0, clean: members.length >= 3 && !offColour && !offSize && !breaks });
  }
  const out = {
    lines: rows.length,
    clean: rows.filter((r) => r.clean).length,
    offColour: rows.reduce((s, r) => s + r.offColour, 0),
    offSize: rows.reduce((s, r) => s + r.offSize, 0),
    breaks: rows.reduce((s, r) => s + r.breaks, 0),
    mixedLines: rows.filter((r) => r.offColour).length,
    brokenLines: rows.filter((r) => r.breaks).length,
    missing: rows.filter((r) => r.missing).length,
    pass: rows.every((r) => r.clean),
    onLine
  };
  if (chains) {
    let wrong = 0, short = 0;
    for (const ch of chains) {
      if (ch.stones.length < 3) short++;
      for (const i of ch.stones) if (stones[i].color !== ch.colour || Math.abs(stones[i].d - ch.d) > 1e-6) wrong++;
    }
    out.chains = { count: chains.length, wrongStones: wrong, short, pass: !wrong && !short };
  }
  return out;
}

export function checkAreas(stones, map, onLine) {
  const { grid, areaOf, subjectDist, regions, areas } = map;
  const areaOfStone = stones.map((s, i) => {
    if (onLine[i] >= 0 || inAnyRegion(regions, s.x, s.y)) return -1;
    const k = grid.at(s.x, s.y);
    if (k < 0 || areaOf[k] < 0 || subjectDist[k] < OUTLINE_BAND_MM) return -1;
    return areaOf[k];
  });
  const tones = new Map();
  stones.forEach((s, i) => { const a = areaOfStone[i]; if (a >= 0) { if (!tones.has(a)) tones.set(a, new Set()); tones.get(a).add(s.color); } });
  const overTones = [...tones.values()].filter((t) => t.size > MAX_TONES).length;
  const maxTones = Math.max(0, ...[...tones.values()].map((t) => t.size));
  const idx = stones.map((_, i) => i).filter((i) => areaOfStone[i] >= 0);
  const nb = neighbourLists(stones, idx, PATCH_GAP_MM);
  const seen = new Set();
  let small = 0, smallStones = 0, halftoneSmall = 0, patches = 0;
  for (const start of idx) {
    if (seen.has(start)) continue;
    const patch = [start];
    seen.add(start);
    for (let q = 0; q < patch.length; q++) {
      for (const o of nb.get(patch[q])) {
        if (!seen.has(o) && areaOfStone[o] === areaOfStone[start] && stones[o].color === stones[start].color) { seen.add(o); patch.push(o); }
      }
    }
    patches++;
    if (patch.length >= MIN_PATCH) continue;
    // A lone patch with no neighbour in its area (a speck of an area) is no patch of another tone.
    const others = patch.some((p) => nb.get(p).some((o) => areaOfStone[o] === areaOfStone[start] && stones[o].color !== stones[start].color));
    if (!others) continue;
    if (areas[areaOfStone[start]].kind === "halftone") { halftoneSmall++; continue; }
    small++;
    smallStones += patch.length;
  }
  return { areas: tones.size, overTones, maxTones, patches, smallPatches: small, smallPatchStones: smallStones, halftonePatches: halftoneSmall, pass: overTones === 0 && small === 0 };
}

export function checkHoles(stones, map) {
  const { grid, subject, subjectDist } = map;
  const cap = MAX_HOLE_MM;
  const clear = new Float32Array(grid.n).fill(cap + 1);
  for (const s of stones) {
    const r = s.d / 2, { i0, i1, j0, j1 } = grid.span(s.x, s.y, r + cap + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.w + i;
        const c = Math.hypot(grid.cx(k) - s.x, grid.cy(k) - s.y) - r;
        if (c < clear[k]) clear[k] = c;
      }
    }
  }
  const open = new Uint8Array(grid.n);
  let largest = 0;
  for (let k = 0; k < grid.n; k++) {
    if (!subject[k]) continue;
    const c = Math.min(clear[k], subjectDist[k]);
    if (c > largest) largest = c;
    if (c > cap / 2) open[k] = 1;
  }
  let holes = 0;
  const at = [];
  const seen = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) {
    if (!open[k] || seen[k]) continue;
    holes++;
    const stack = [k];
    seen[k] = 1;
    let best = k;
    while (stack.length) {
      const c = stack.pop();
      if (Math.min(clear[c], subjectDist[c]) > Math.min(clear[best], subjectDist[best])) best = c;
      const i = c % grid.w;
      for (const m of [i > 0 ? c - 1 : -1, i < grid.w - 1 ? c + 1 : -1, c - grid.w, c + grid.w]) {
        if (m >= 0 && m < grid.n && open[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
      }
    }
    at.push([Math.round(grid.cx(best) * 100) / 100, Math.round(grid.cy(best) * 100) / 100, Math.round(2 * Math.min(clear[best], subjectDist[best]) * 100) / 100]);
  }
  return { holes, largestMm: Math.round(2 * Math.min(largest, cap + 1) * 100) / 100, at, pass: holes === 0 };
}

// Checks 1-4 of a design. chains: the engine's chains (place.js), or null for today's designs.
export function runChecks(stones, map, { chains = null } = {}) {
  const gaps = checkGapsOf(stones);
  const lines = checkLines(stones, map, chains);
  const areas = checkAreas(stones, map, lines.onLine);
  const holes = checkHoles(stones, map);
  delete lines.onLine;
  return { gaps, lines, areas, holes };
}
