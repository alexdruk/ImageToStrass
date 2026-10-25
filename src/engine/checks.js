import { PALETTE } from "../pipeline/holes.js";
import { MIN_GAP_MM } from "../pipeline/tiers.js";
import { inRegion, insidePolygon } from "./faces.js";
import { MIN_PATCH, MAX_TONES } from "./map.js";
import { neighbourLists } from "./place.js";

// The checks of the design concept (docs/IS-DESIGN-CONCEPT.md section 8), 1 to 5, for any design:
// today's and the engine's alike, both measured against the engine's map of the same AI image (so
// the lines and areas are the same for both). Stones: plain { x, y, d, color } in layout mm.
//
//   1. Gaps: pairs closer than MIN_GAP_MM (0.1 mm) rim to rim, and the smallest gap.
//   2. Lines, along every line of the map, from its first to its last stone in the line's colour (a
//      line with none is missing): the stones on it (centre within ON_LINE_MM of its path) must all
//      have the line's colour and size, except where another line crosses it (a stone of that
//      line's colour and size on both paths), and it must have no break: no stretch longer than
//      BREAK_PITCHES stone steps without a stone. Engine
//      designs also report their own chains (every stone the chain's colour and size, at least 3).
//   3. Areas: the stones of each map area (not on a line or a brow, not in the outline band along
//      the edge, not in a face region, not a feature) have at most MAX_TONES colours, and no patch (stones of one colour
//      touching, rim gap below PATCH_GAP_MM, in one area) has fewer than MIN_PATCH stones. A
//      halftone area's pattern is meant (concept section 6), so its patches are counted apart.
//   4. Holes: empty circles inside the subject (the AI image's closed alpha, as the hole fill
//      reads it) of MAX_HOLE_MM or more (build 3; 1.0 mm before), by the cells (map grid) whose
//      distance to every stone edge and to the subject's edge is at least MAX_HOLE_MM / 2; each
//      connected piece is one hole.
//   5. Faces (checkFaces), per landmark face: each eye has its outline (the upper lid dark along
//      UPPER_COVER of it, the lower lid darker than the skin along LOWER_COVER), its white (at least
//      two light stones in the opening, not the catch-light) and its pupil (a dark stone of SS6 or
//      more at the iris centre), and usually a catch-light (the highest of the smallest light stones
//      touching the pupil); the lips have an outline (10 L* darker than the skin along LIP_COVER of it) and
//      usually a mouth line (8 L* darker than the lower lip and the skin along LIP_COVER of it).
//      Measured on any design, against the landmarks; black & white: dark is Jet.

export const ON_LINE_MM = 0.8;
export const BREAK_PITCHES = 1.5;
export const OUTLINE_BAND_MM = 1.6;
export const MAX_HOLE_MM = 1.4;
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
    // A stone where another line crosses, of that line's colour and size, is the crossing's stone.
    const crossing = (s) => map.lines.some((o) => o !== line && o.colour === s.color && Math.abs(o.d - s.d) < 0.05 &&
      o.points.some((p) => Math.hypot(p.xMm - s.x, p.yMm - s.y) <= ON_LINE_MM));
    const members = [...on].map((i) => stones[i]).filter((s) => (s.color === line.colour && Math.abs(s.d - line.d) <= 0.05) || !crossing(s));
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
      if (ch.stones.length < (ch.kind === "lash" ? 2 : 3)) short++;
      for (const i of ch.stones) if (stones[i].color !== ch.colour || Math.abs(stones[i].d - ch.d) > 1e-6) wrong++;
    }
    out.chains = { count: chains.length, wrongStones: wrong, short, pass: !wrong && !short };
  }
  return out;
}

export function checkAreas(stones, map, onLine) {
  const { grid, areaOf, subjectDist, regions, areas } = map;
  const browPoints = (map.brows || []).flatMap((b) => b.rows.flatMap((r) => r.points));
  const onBrow = (s) => browPoints.some((p) => Math.hypot(p.xMm - s.x, p.yMm - s.y) <= ON_LINE_MM);
  const areaOfStone = stones.map((s, i) => {
    // Features are no area: stones in any face region (the nose's too) or placed as features.
    if (onLine[i] >= 0 || s.role === "feature" || regions.some((r) => inRegion(r, s.x, s.y)) || onBrow(s)) return -1;
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

// Hole sizes counted from HIST_MIN_MM: bins [0.6, 0.8), [0.8, 1.0), [1.0, 1.2), [1.2, 1.4), 1.4 and more.
export const HIST_BINS = Object.freeze([0.6, 0.8, 1.0, 1.2, 1.4]);

// Empty circles inside the subject wider than minMm, one per gap: the local maxima of the clearance
// (to every stone edge and to the subject's edge) above minMm / 2, each twice its clearance wide.
// (Check 4 counts connected pieces instead; neighbouring gaps above 0.6 mm often join into one.)
// -> [[x, y, diameter]].
export function emptyCircles(stones, map, minMm) {
  const { grid, subject, subjectDist } = map;
  const cap = 2;
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
  const val = (k) => (subject[k] ? Math.min(clear[k], subjectDist[k]) : -1);
  const out = [];
  for (let k = 0; k < grid.n; k++) {
    const v = val(k);
    if (v <= minMm / 2) continue;
    const i = k % grid.w;
    let top = true;
    // Strictly above the neighbours before it, at least as high as those after (one cell per plateau).
    for (const [m, before] of [[k - grid.w - 1, 1], [k - grid.w, 1], [k - grid.w + 1, 1], [k - 1, 1], [k + 1, 0], [k + grid.w - 1, 0], [k + grid.w, 0], [k + grid.w + 1, 0]]) {
      if (m < 0 || m >= grid.n || Math.abs((m % grid.w) - i) > 1) continue;
      const w = val(m);
      if (before ? w >= v : w > v) { top = false; break; }
    }
    if (top) out.push([Math.round(grid.cx(k) * 100) / 100, Math.round(grid.cy(k) * 100) / 100, Math.round(2 * Math.min(v, cap) * 100) / 100]);
  }
  return out;
}

export function holeHistogram(stones, map) {
  const sizes = emptyCircles(stones, map, HIST_BINS[0]).map((h) => h[2]);
  return HIST_BINS.map((lo, i) => sizes.filter((d) => d >= lo && (i + 1 === HIST_BINS.length || d < HIST_BINS[i + 1])).length);
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
    if (c >= cap / 2) open[k] = 1;
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

// --- Check 5 -------------------------------------------------------------------------------------

export const FACE_REACH_MM = 1.3;
export const UPPER_COVER = 0.7;
export const LOWER_COVER = 0.6;
export const LIP_COVER = 0.7;
export const LIGHT_L = 80;
export const DARK_L = 25;
export const TOUCH_MM = 0.35;
const LIGHTNESS = Object.fromEntries(PALETTE.map((p) => [p.id, p.lab[0]]));

// Points every step mm along a polyline of [x, y] (closed: back to its start).
function walkXY(line, step, closed = false) {
  const pts = closed ? [...line, line[0]] : line, out = [];
  for (let q = 0; q + 1 < pts.length; q++) {
    const a = pts[q], b = pts[q + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let t = 0; t < n; t++) out.push([a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n]);
  }
  return out;
}

const middle = (pts, from = 0.1, to = 0.9) => pts.slice(Math.floor(from * pts.length), Math.ceil(to * pts.length));
const medianOf = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

// stones (plain, layout mm) + landmark faces (faces.js faceGeometry) -> per face { eyes: [{ outline,
// upper, lower, white, pupil, pupilD, pupilShare, catchLight, side }], sameSide, lips: { outline,
// mouthLine }, pass }. mode: "bw" judges dark as Jet and light as Crystal.
export function checkFaces(stones, faces, { mode = "colour" } = {}) {
  const h = hashOf(stones);
  const Ls = stones.map((s) => LIGHTNESS[s.color] ?? 50);
  const near = (p, reach) => h.near(p[0], p[1], reach + 3).filter((i) => Math.hypot(stones[i].x - p[0], stones[i].y - p[1]) <= reach);
  const share = (samples, test, reach = FACE_REACH_MM) => (samples.length ? samples.filter((p) => near(p, reach).some((i) => test(i))).length / samples.length : 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  return faces.map((face) => {
    const cheek = new Set(face.cheeks.flatMap((p) => near(p, 0.12 * face.ipd)));
    const skinL = medianOf([...cheek].map((i) => Ls[i])) ?? 70;
    const dark = (i, below) => (mode === "bw" ? stones[i].color === "jet" : Ls[i] <= below);
    const eyes = face.eyes.map((eye) => {
      const upper = share(middle(eye.upper), (i) => dark(i, Math.max(30, skinL - 25)));
      const lower = share(middle(eye.lower), (i) => dark(i, skinL - 8));
      const { c, r } = eye.iris;
      const pupil = near(c, Math.max(1.0, 0.6 * r)).filter((i) => Ls[i] <= DARK_L && stones[i].d >= 1.9).sort((a, b) => stones[b].d - stones[a].d)[0];
      const rim = (i) => (pupil == null ? Infinity : Math.hypot(stones[i].x - stones[pupil].x, stones[i].y - stones[pupil].y) - (stones[i].d + stones[pupil].d) / 2);
      const inOpening = near(c, eye.widthMm).filter((i) => insidePolygon([stones[i].x, stones[i].y], eye.opening));
      // The catch-light: of the smallest light stones touching the pupil, the highest; other light
      // stones are white.
      const up = (i) => (stones[i].x - c[0]) * face.v[0] + (stones[i].y - c[1]) * face.v[1];
      const catchLight = [...new Set(inOpening.concat(near(c, 6)))].filter((i) => Ls[i] >= LIGHT_L && stones[i].d <= 2.05 && rim(i) <= TOUCH_MM)
        .sort((a, b) => stones[a].d - stones[b].d || up(a) - up(b))[0];
      const whites = inOpening.filter((i) => Ls[i] >= LIGHT_L && i !== catchLight);
      const side = catchLight == null ? null : Math.sign((stones[catchLight].x - stones[pupil].x) * face.u[0] + (stones[catchLight].y - stones[pupil].y) * face.u[1]) || 0;
      return {
        outline: upper >= UPPER_COVER && lower >= LOWER_COVER, upper: r2(upper), lower: r2(lower),
        white: whites.length >= 2, whites: whites.length,
        pupil: pupil != null, pupilD: pupil == null ? null : stones[pupil].d, pupilShare: pupil == null ? null : r2(stones[pupil].d / (2 * r)),
        catchLight: catchLight != null, side
      };
    });
    const sides = eyes.map((e) => e.side);
    const lips = face.lips;
    // Outline: darker than the skin; mouth line: darker than the lower lip (the lighter one).
    const lowerL = medianOf(near(face.lips.line[5], lips.widthMm).filter((i) => insidePolygon([stones[i].x, stones[i].y], lips.lower)).map((i) => Ls[i])) ?? skinL;
    const outline = share(walkXY(lips.outer, 0.3, true), (i) => dark(i, skinL - 10));
    const lineSamples = lips.open ? [...middle(walkXY(lips.upperInner, 0.3), 0.15, 0.85), ...middle(walkXY(lips.lowerInner, 0.3), 0.15, 0.85)] : middle(walkXY(lips.line, 0.3), 0.15, 0.85);
    const mouthLine = share(lineSamples, (i) => dark(i, Math.min(lowerL, skinL) - 8), 1.0);
    const faceOut = {
      eyes,
      sameSide: sides.every((s) => s != null) ? sides[0] === sides[1] : null,
      lips: { outline: outline >= LIP_COVER, outlineShare: r2(outline), mouthLine: mouthLine >= LIP_COVER, mouthLineShare: r2(mouthLine) },
      skinL: Math.round(skinL)
    };
    faceOut.pass = eyes.every((e) => e.outline && e.white && e.pupil) && faceOut.lips.outline;
    return faceOut;
  });
}

// Checks 1-5 of a design. chains: the engine's chains (place.js), or null for today's designs.
// faces: landmark faces for check 5 (the map's, when it has them).
export function runChecks(stones, map, { chains = null, faces = map.faces ?? [] } = {}) {
  const gaps = checkGapsOf(stones);
  const lines = checkLines(stones, map, chains);
  const areas = checkAreas(stones, map, lines.onLine);
  const holes = checkHoles(stones, map);
  holes.histogram = holeHistogram(stones, map);
  delete lines.onLine;
  const out = { gaps, lines, areas, holes };
  if (faces.length) out.faces = checkFaces(stones, faces, { mode: map.mode });
  return out;
}
