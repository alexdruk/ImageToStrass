import { createCanvas } from "@napi-rs/canvas";
import { DEFAULT_BW_THRESHOLD } from "../pipeline/bw.js";
import { PALETTE, deltaE2000, lightnessOnWhite, sampleLab, snapColour, subjectMask } from "../pipeline/holes.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { getStoneSize } from "../stones/StoneSizes.js";
import { computeSingleDistanceRing } from "./ContourRingSampler.js";
import { dilateMask, erodeMask, labelComponents8, polylineLengthMm, smoothPolyline, traceSkeletonPaths, zhangSuenThin } from "./LineDesignSampler.js";
import { faceRegions, inAnyRegion } from "./faces.js";
import { Grid } from "./grid.js";

// The map (exp-engine, design concept sections 2-4; docs/exp-engine.md section 2). The AI image is
// only a map: of the subject's outline, of areas (shapes of one meaning, each with at most 3 tones of
// one colour ramp) and of lines (smooth paths of one colour and a width class). The engine places
// every stone itself from it (place.js).
//
// Built from the AI image and the layout service's detections (report.discsAtMm: the stones the AI
// drew, [x, y, d] in layout mm; a report without them falls back to the service's stones):
//
//   1. Subject: the AI image's alpha, closed (holes.subjectMask), on a grid of MAP_PX_PER_MM in
//      layout mm; one part per connected piece.
//   2. Discs: each detection's colour, the mean Lab of its inner 60 % (holes.sampleLab), and its
//      lightness on white. Every subject cell belongs to the disc whose edge is nearest (its
//      cell); two discs are neighbours when their cells touch.
//   3. Ink (dark discs). Colour: L* below INK_DARK_L, or below INK_MAX_L and INK_REL_L darker than
//      the median of its neighbours two steps around. Black & white: Jet (L* below the B&W
//      threshold); halftone: only where the Jet share of the discs around it (HALFTONE_INK_RADIUS_MM,
//      itself left out) is at most HALFTONE_LINE_SHARE, so the halftone pattern itself is no line.
//      Light ink likewise (markInk): discs clearly lighter than the ones around them (Crystal in
//      black & white), for light lines (whiskers, lace, white stripes, light strands).
//   3b. Face regions (faces.js) and brows (findBrows): a brow is a chain, never an area or a line.
//   4. Lines, dark and light alike: the thin ink (ink without the discs along the subject's edge, EDGE_DISC_MM, and
//      without the parts at least 2 x LINE_HALF_WIDTH_MM wide), thinned to
//      its centre line (Zhang-Suen, RS LineDesignSampler) away from the subject's edge (the AI's
//      own outline there is the subject outline's job, LINE_EDGE_MM) and from the face regions,
//      traced into paths and smoothed. A path shorter than MIN_LINE_STONES stones is no line. Width
//      class: SS4 (fine) when the discs under it are mostly smaller than SS6, else SS6 (outline).
//      Colour: the most common catalogue colour of its ink discs (Jet in black & white; Crystal for
//      light lines). A line along most of a brow is dropped (the brow is drawn).
//   5. Areas, from the discs not on a line. Colour: a graph segmentation of the disc neighbours by
//      ΔE2000 (Felzenszwalb-Huttenlocher, SEGMENT_K), areas under MIN_AREA_DISCS discs joined to their
//      most similar neighbour; tones: at most MAX_TONES catalogue colours per area, chosen among the
//      area's own snapped colours (so one ramp) where each more tone cuts the area's summed ΔE by
//      TONE_GAIN at least; each disc takes its nearest tone, and a patch of fewer than MIN_PATCH discs
//      of one tone takes its neighbours' tone. Stencil: solid Jet and solid Crystal areas. Halftone:
//      the Jet share around each disc snapped to HALFTONE_LEVELS; an area is a piece of one level,
//      placed as a regular Jet / Crystal pattern of that share.
//   6. Outline colour of each area: Jet where it is dark (its discs' mean L* below OUTLINE_JET_L) or
//      grey, else the darkest colour of its ramp (RAMPS); Jet in black & white. The AI's own dark outline along the edge (ink discs within EDGE_DISC_MM of
//      it) belongs to no area: its cells take the areas inside it.
//
// The rasters stay in memory for the placement and the checks; toJSON() and mapPicture() are what
// is saved per design.

export const MAP_PX_PER_MM = 10;
export const SS4_MM = getStoneSize("ss4").diameterMm;
export const SS6_MM = getStoneSize("ss6").diameterMm;
export const ROW_GAP_MM = 0.15;
export const MAX_TONES = 3;
export const MIN_PATCH = 4;
export const TONE_GAIN = 0.12;
export const INK_DARK_L = 28;
export const INK_MAX_L = 50;
export const INK_REL_L = 18;
export const LIGHT_MIN_L = 55;
export const HALFTONE_RADIUS_MM = 3;
export const HALFTONE_LINE_SHARE = 0.5;
export const HALFTONE_INK_RADIUS_MM = 3.5;
export const HALFTONE_LEVELS = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
export const LINE_HALF_WIDTH_MM = 1.6;
export const LINE_EDGE_MM = 1.2;
export const EDGE_DISC_MM = 1.6;
export const LINE_BAND_MM = 1.6;
export const LINE_CUT_MM = 2.5;
export const MIN_LINE_STONES = 3;
export const SEGMENT_K = 60;
export const MIN_AREA_DISCS = 8;
export const OUTLINE_JET_L = 35;
export const MIN_PART_MM2 = 3;
export const AREA_SMOOTH_MM = 0.6;
export const TONE_SMOOTH_MM = 0.5;
export const JET = "jet";
export const CRYSTAL = "crystal-clear";

const PAD_MM = 2;
const DISC_REACH_MM = 1.5;
const SMOOTH = 9;

const labOf = Object.fromEntries(PALETTE.map((p) => [p.id, p.lab]));
const hueOf = (lab) => ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
const chromaOf = (lab) => Math.hypot(lab[1], lab[2]);
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

function modeOf(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = -1;
  for (const [v, c] of counts) if (c > n || (c === n && String(v) < String(best))) { best = v; n = c; }
  return best;
}

// Union-find over 0..n-1 with sizes.
function unionFind(n) {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const size = new Int32Array(n).fill(1);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return a;
    if (size[a] < size[b]) [a, b] = [b, a];
    parent[b] = a; size[a] += size[b];
    return a;
  };
  return { find, union, size };
}

// --- 1. Subject --------------------------------------------------------------------------------

function subjectOnGrid(ai, report) {
  const s = Number(report.mmPerPx);
  const [ox, oy] = report.offsetMm;
  const mask = subjectMask(ai, s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < ai.height; y++) {
    for (let x = 0; x < ai.width; x++) {
      if (!mask[y * ai.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const ppmm = MAP_PX_PER_MM;
  const x0 = Math.floor((minX - 0.5) * s - ox - PAD_MM), y0 = Math.floor((minY - 0.5) * s - oy - PAD_MM);
  const grid = new Grid({
    x0, y0, ppmm,
    w: Math.ceil(((maxX + 0.5) * s - ox + PAD_MM - x0) * ppmm), h: Math.ceil(((maxY + 0.5) * s - oy + PAD_MM - y0) * ppmm)
  });
  const subject = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) {
    const px = Math.round((grid.cx(k) + ox) / s), py = Math.round((grid.cy(k) + oy) / s);
    subject[k] = px >= 0 && py >= 0 && px < ai.width && py < ai.height && mask[py * ai.width + px] ? 1 : 0;
  }
  // Parts: 4-connected pieces; specks under MIN_PART_MM2 are dropped.
  const part = new Int32Array(grid.n).fill(-1);
  const parts = [];
  const minCells = MIN_PART_MM2 * ppmm * ppmm;
  for (let k = 0; k < grid.n; k++) {
    if (!subject[k] || part[k] >= 0) continue;
    const id = parts.length, members = [k];
    part[k] = id;
    for (let q = 0; q < members.length; q++) {
      const c = members[q], i = c % grid.w, j = (c - i) / grid.w;
      for (const m of [i > 0 ? c - 1 : -1, i < grid.w - 1 ? c + 1 : -1, j > 0 ? c - grid.w : -1, j < grid.h - 1 ? c + grid.w : -1]) {
        if (m >= 0 && subject[m] && part[m] < 0) { part[m] = id; members.push(m); }
      }
    }
    if (members.length < minCells) for (const c of members) { subject[c] = 0; part[c] = -2; }
    parts.push({ id, cells: members.length, dropped: members.length < minCells });
  }
  for (let k = 0; k < grid.n; k++) if (part[k] === -2) part[k] = -1;
  return { grid, subject, part, parts: parts.filter((p) => !p.dropped).map(({ id, cells }) => ({ id, areaMm2: cells / (ppmm * ppmm) })) };
}

// --- 2. Discs ----------------------------------------------------------------------------------

function readDiscs(layout, ai, mode, threshold) {
  const report = layout.report;
  const s = Number(report.mmPerPx), [ox, oy] = report.offsetMm;
  const source = Array.isArray(report.discsAtMm) && report.discsAtMm.length
    ? report.discsAtMm.map(([x, y, d]) => ({ x, y, d }))
    : layout.stones.map(([x, y, sizeId]) => ({ x, y, d: getStoneSize(sizeId).diameterMm }));
  return source.map((st, id) => {
    const px = (st.x + ox) / s, py = (st.y + oy) / s;
    const lab = sampleLab(ai, px, py, st.d, s);
    const lw = lightnessOnWhite(ai, px, py, st.d, s);
    return { id, x: st.x, y: st.y, d: st.d, lab, lw, snap: mode === "colour" ? snapColour(lab) : (lw < threshold ? JET : CRYSTAL) };
  });
}

function discCells(grid, subject, discs) {
  const owner = new Int32Array(grid.n).fill(-1);
  const best = new Float32Array(grid.n).fill(Infinity);
  for (const disc of discs) {
    const r = disc.d / 2, { i0, i1, j0, j1 } = grid.span(disc.x, disc.y, r + DISC_REACH_MM);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.w + i;
        if (!subject[k]) continue;
        const e = Math.hypot(grid.cx(k) - disc.x, grid.cy(k) - disc.y) - r;
        if (e < best[k]) { best[k] = e; owner[k] = disc.id; }
      }
    }
  }
  return grid.spread(owner, subject);
}

// Neighbour lists of the discs whose cells touch.
function discGraph(grid, owner, count) {
  const nb = Array.from({ length: count }, () => new Set());
  for (let k = 0; k < grid.n; k++) {
    const a = owner[k];
    if (a < 0) continue;
    const i = k % grid.w;
    for (const m of [i < grid.w - 1 ? k + 1 : -1, k + grid.w < grid.n ? k + grid.w : -1]) {
      if (m < 0) continue;
      const b = owner[m];
      if (b >= 0 && b !== a) { nb[a].add(b); nb[b].add(a); }
    }
  }
  return nb.map((s) => [...s]);
}

// --- 3. Ink ------------------------------------------------------------------------------------

// The Jet share around each disc (Gaussian weights, sigma half the radius), from discs where
// counts(disc) is true; without the disc itself unless self.
function jetShare(discs, counts, { self = true, radius = HALFTONE_RADIUS_MM } = {}) {
  const cell = radius;
  const index = new Map();
  for (const d of discs) {
    if (!counts(d)) continue;
    const key = `${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(d);
  }
  const sigma2 = (radius / 2) ** 2;
  return discs.map((d) => {
    let w = 0, jet = 0;
    const gx = Math.floor(d.x / cell), gy = Math.floor(d.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of index.get(`${gx + a},${gy + b}`) || []) {
        if (!self && o === d) continue;
        const r2 = (o.x - d.x) ** 2 + (o.y - d.y) ** 2;
        if (r2 > radius ** 2) continue;
        const wt = Math.exp(-r2 / (2 * sigma2));
        w += wt;
        if (o.snap === JET) jet += wt;
      }
    }
    return w ? jet / w : d.snap === JET ? 1 : 0;
  });
}

// Dark ink (d.ink) and light ink (d.light): discs clearly darker or lighter than the ones around
// them. Colour, light: L* above LIGHT_MIN_L and INK_REL_L lighter than the median two steps around.
// Black & white, light: Crystal; in halftone only where the Crystal share around it is at most
// HALFTONE_LINE_SHARE.
function markInk(discs, nb, mode, style) {
  if (mode === "colour") {
    for (const d of discs) {
      const ring = new Set(nb[d.id]);
      for (const a of nb[d.id]) for (const b of nb[a]) ring.add(b);
      ring.delete(d.id);
      const ref = median([...ring].map((o) => discs[o].lab[0]));
      d.ink = d.lab[0] < INK_DARK_L || (d.lab[0] < INK_MAX_L && ref - d.lab[0] > INK_REL_L);
      d.light = d.lab[0] > LIGHT_MIN_L && d.lab[0] - ref > INK_REL_L;
    }
    return;
  }
  const share = style === "halftone" ? jetShare(discs, () => true, { self: false, radius: HALFTONE_INK_RADIUS_MM }) : null;
  for (const d of discs) {
    d.ink = d.snap === JET && (!share || share[d.id] <= HALFTONE_LINE_SHARE);
    d.light = d.snap === CRYSTAL && (!share || 1 - share[d.id] <= HALFTONE_LINE_SHARE);
  }
}

// --- 4. Lines ----------------------------------------------------------------------------------

// Skeleton paths ({ points: [{ xMm, yMm }], closed }, each from node to node, as traceSkeletonPaths
// gives them) -> longer paths: spurs (a piece with a free end shorter than SPUR_MM) are dropped, and
// at every node the two pieces that continue each other most straightly are joined, so a line runs
// on through the junctions the cells' jagged edges leave.
export const SPUR_MM = 2;

function joinSkeletonPaths(paths) {
  const keyOf = (p) => `${Math.round(p.xMm * 1000)},${Math.round(p.yMm * 1000)}`;
  let pieces = paths.filter((p) => !p.closed && p.points.length >= 2).map((p) => ({ points: p.points, length: polylineLengthMm(p.points) }));
  const closed = paths.filter((p) => p.closed);
  const degree = () => {
    const deg = new Map();
    for (const p of pieces) for (const end of [p.points[0], p.points[p.points.length - 1]]) deg.set(keyOf(end), (deg.get(keyOf(end)) || 0) + 1);
    return deg;
  };
  for (let round = 0; round < 3; round++) {
    const deg = degree();
    const before = pieces.length;
    pieces = pieces.filter((p) => {
      const a = deg.get(keyOf(p.points[0])), b = deg.get(keyOf(p.points[p.points.length - 1]));
      return !(p.length < SPUR_MM && (a === 1) !== (b === 1));
    });
    if (pieces.length === before) break;
  }
  // Join at nodes: the pair of pieces whose directions (over their first SPUR_MM) are most opposite.
  const direction = (points) => {
    let i = 1, len = 0;
    while (i < points.length - 1 && len < SPUR_MM) { len += Math.hypot(points[i].xMm - points[i - 1].xMm, points[i].yMm - points[i - 1].yMm); i++; }
    const dx = points[i].xMm - points[0].xMm, dy = points[i].yMm - points[0].yMm, n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  };
  for (;;) {
    const ends = new Map();
    pieces.forEach((p, pi) => {
      for (const atStart of [true, false]) {
        const pts = atStart ? p.points : [...p.points].reverse();
        const key = keyOf(pts[0]);
        if (!ends.has(key)) ends.set(key, []);
        ends.get(key).push({ pi, atStart, dir: direction(pts) });
      }
    });
    let best = null;
    for (const list of ends.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          if (list[a].pi === list[b].pi) continue;
          const cos = list[a].dir[0] * list[b].dir[0] + list[a].dir[1] * list[b].dir[1];
          if (cos < -0.5 && (!best || cos < best.cos)) best = { cos, a: list[a], b: list[b] };
        }
      }
    }
    if (!best) break;
    const pa = pieces[best.a.pi], pb = pieces[best.b.pi];
    const first = best.a.atStart ? [...pa.points].reverse() : pa.points;
    const second = best.b.atStart ? pb.points : [...pb.points].reverse();
    const points = [...first, ...second.slice(1)];
    pieces = pieces.filter((_, i) => i !== best.a.pi && i !== best.b.pi);
    pieces.push({ points, length: polylineLengthMm(points) });
  }
  // A piece whose two ends meet is a closed path.
  return [
    ...closed,
    ...pieces.map((p) => {
      const a = p.points[0], b = p.points[p.points.length - 1];
      return Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) < 1e-6 && p.points.length > 3 ? { points: p.points.slice(0, -1), closed: true } : { points: p.points, closed: false };
    })
  ];
}

function findLines(grid, subject, subjectDist, owner, discs, regions, mode, key = "ink") {
  // The AI's own outline along the subject's edge (discs centred within EDGE_DISC_MM of it) is the
  // subject outline's job; left in, it glues every contour that touches it into a wide band.
  const edgeDisc = discs.map((d) => (key === "ink" ? d.edge : d.lightEdge));
  const ink = new Uint8Array(grid.n);
  let i0 = grid.w, i1 = -1, j0 = grid.h, j1 = -1;
  for (let k = 0; k < grid.n; k++) {
    if (owner[k] < 0 || !discs[owner[k]][key] || edgeDisc[owner[k]]) continue;
    ink[k] = 1;
    const i = k % grid.w, j = (k - i) / grid.w;
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  }
  if (i1 < 0) return [];
  // The ink's bounding box (plus a margin) is all the line stage looks at.
  const m = Math.ceil(2 * LINE_HALF_WIDTH_MM * grid.ppmm) + 2;
  i0 = Math.max(0, i0 - m); j0 = Math.max(0, j0 - m); i1 = Math.min(grid.w - 1, i1 + m); j1 = Math.min(grid.h - 1, j1 + m);
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
  const crop = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) crop[j * cols + i] = ink[(j + j0) * grid.w + i + i0];
  const cell = 1 / grid.ppmm;
  // Thin ink: without the parts at least 2 x LINE_HALF_WIDTH_MM wide (an opening), a little grown.
  const wide = dilateMask(erodeMask(crop, cols, rows, cell, LINE_HALF_WIDTH_MM), cols, rows, cell, LINE_HALF_WIDTH_MM + 0.3);
  const thin = new Uint8Array(cols * rows);
  for (let q = 0; q < thin.length; q++) thin[q] = crop[q] && !wide[q] ? 1 : 0;
  const skeleton = zhangSuenThin(thin, cols, rows);
  const toK = (q) => { const i = q % cols; return ((q - i) / cols + j0) * grid.w + i + i0; };
  for (let q = 0; q < skeleton.length; q++) {
    if (!skeleton[q]) continue;
    const k = toK(q);
    if (!subject[k] || subjectDist[k] < LINE_EDGE_MM || inAnyRegion(regions, grid.cx(k), grid.cy(k), SS6_MM / 2)) skeleton[q] = 0;
  }
  const lines = [];
  for (const comp of labelComponents8(skeleton, cols, rows)) {
    if (comp.length < 3) continue;
    const traced = traceSkeletonPaths(comp, cols, rows).map(({ points, closed }) => ({
      closed,
      points: points.map((p) => ({ xMm: grid.x0 + (p.xPx + i0 + 0.5) / grid.ppmm, yMm: grid.y0 + (p.yPx + j0 + 0.5) / grid.ppmm }))
    }));
    for (const { points: raw, closed } of joinSkeletonPaths(traced)) {
      const under = new Set();
      for (const p of raw) {
        const k = grid.at(p.xMm, p.yMm);
        if (k >= 0 && owner[k] >= 0 && discs[owner[k]][key]) under.add(owner[k]);
      }
      if (!under.size) continue;
      const fine = median([...under].map((o) => discs[o].d)) < (SS4_MM + SS6_MM) / 2;
      const d = fine ? SS4_MM : SS6_MM;
      const length = polylineLengthMm(closed ? [...raw, raw[0]] : raw);
      if (length < (MIN_LINE_STONES - 1) * (d + ROW_GAP_MM) + 0.5) continue;
      const smooth = smoothPolyline(smoothPolyline(raw, SMOOTH, closed), SMOOTH, closed);
      lines.push({
        id: lines.length,
        size: fine ? "ss4" : "ss6",
        d,
        colour: mode === "colour" ? modeOf([...under].map((o) => discs[o].snap)) : key === "ink" ? JET : CRYSTAL,
        tone: key === "ink" ? "dark" : "light",
        closed,
        lengthMm: length,
        points: smooth,
        discs: [...under]
      });
    }
  }
  return lines;
}

// A line running within one stone step of a longer one (a doubled strand) cannot get its own chain:
// it is dropped when most of it lies that close.
function dropDoubled(lines) {
  const kept = [];
  for (const line of [...lines].sort((a, b) => b.lengthMm - a.lengthMm)) {
    const reach = line.d + ROW_GAP_MM + SS6_MM / 2;
    const close = line.points.filter((p) => kept.some((o) => o.points.some((q) => Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm) < reach))).length;
    if (close > 0.5 * line.points.length) continue;
    kept.push(line);
  }
  return kept.map((l, id) => ({ ...l, id }));
}

// --- Brows -------------------------------------------------------------------------------------

// Brows (concept section 5: a chain of 1-2 rows along the brow, thicker at the inner end, in the hair
// colour), from the pupils: above each eye, in the box BROW_U across and BROW_V above the eye's
// centre (in pupil distances, on the pupils' axis), the largest connected group of dark discs (dark
// ink; black & white: Jet) is the brow. Its centre line is a quadratic fitted through the discs; one
// row along all of it, and where the drawn brow is thicker than BROW_TWO_ROWS stones, a second row
// on the inner BROW_INNER share, both SS6, so the brow is thicker at its inner end (towards the other
// eye). Colour: the brow discs' most common catalogue colour (Jet in black & white). A group of fewer
// than BROW_MIN_DISCS discs is no brow. Returns [{ eye, colour, discs, rows: [line-like { points,
// d, closed }] }].
export const BROW_U = [-0.5, 0.5];
export const BROW_V = [-0.85, -0.2];
export const BROW_MIN_DISCS = 3;
export const BROW_TWO_ROWS = 1.4;
export const BROW_INNER = 0.55;

function findBrows(discs, nb, regions, mode) {
  const eyes = regions.filter((r) => r.kind === "eye");
  if (eyes.length !== 2) return [];
  const [p, q] = eyes.map((e) => e.pupil);
  const ipd = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const u = [(q[0] - p[0]) / ipd, (q[1] - p[1]) / ipd], v = [-u[1], u[0]];
  const pitch = SS6_MM + ROW_GAP_MM;
  const brows = [];
  eyes.forEach((eye, e) => {
    const other = eyes[1 - e];
    const inner = Math.sign((other.x - eye.x) * u[0] + (other.y - eye.y) * u[1]) || 1;
    const local = (d) => [((d.x - eye.x) * u[0] + (d.y - eye.y) * u[1]) / ipd, ((d.x - eye.x) * v[0] + (d.y - eye.y) * v[1]) / ipd];
    const dark = (d) => (mode === "colour" ? d.ink : d.snap === JET);
    const inBox = new Set(discs.filter((d) => {
      const [a, b] = local(d);
      return dark(d) && !d.edge && a >= BROW_U[0] && a <= BROW_U[1] && b >= BROW_V[0] && b <= BROW_V[1];
    }).map((d) => d.id));
    let best = [];
    const seen = new Set();
    for (const start of inBox) {
      if (seen.has(start)) continue;
      const group = [start];
      seen.add(start);
      for (let k = 0; k < group.length; k++) for (const o of nb[group[k]]) if (inBox.has(o) && !seen.has(o)) { seen.add(o); group.push(o); }
      if (group.length > best.length) best = group;
    }
    if (best.length < BROW_MIN_DISCS) return;
    // Centre line t(s) (mm, on the eye's axes), least squares, quadratic when the brow is long enough.
    const pts = best.map((o) => { const [a, b] = local(discs[o]); return [a * ipd, b * ipd]; });
    const sMin = Math.min(...pts.map((t) => t[0])), sMax = Math.max(...pts.map((t) => t[0]));
    if (sMax - sMin < 2 * pitch) return;
    const fit = polyFit(pts, sMax - sMin > 5 * pitch ? 2 : 1);
    const along = (s, off) => {
      const t = fit(s) + off;
      return { xMm: eye.x + s * u[0] + t * v[0], yMm: eye.y + s * u[1] + t * v[1] };
    };
    const residual = pts.map(([a, b]) => b - fit(a));
    // Thickness of the drawn brow on its inner half: the spread of the discs across the line.
    const mid = (sMin + sMax) / 2;
    const innerSide = pts.map(([a], k) => ((a - mid) * inner > 0 ? residual[k] : null)).filter((r) => r != null);
    const thick = innerSide.length ? (Math.max(...innerSide) - Math.min(...innerSide)) / pitch + 1 : 1;
    // Inner end first.
    const [s0, s1] = inner > 0 ? [sMax, sMin] : [sMin, sMax];
    const path = (from, to, off) => {
      const n = Math.max(2, Math.ceil(Math.abs(to - from) / 0.2));
      return Array.from({ length: n + 1 }, (_, k) => along(from + (to - from) * k / n, off));
    };
    const rows = [];
    if (thick >= BROW_TWO_ROWS) {
      const half = 0.45 * pitch;
      rows.push({ points: path(s0, s1, half), d: SS6_MM, closed: false });
      rows.push({ points: path(s0, s0 + (s1 - s0) * BROW_INNER, -half), d: SS6_MM, closed: false });
    } else {
      rows.push({ points: path(s0, s1, 0), d: SS6_MM, closed: false });
    }
    brows.push({ eye: e, colour: mode === "colour" ? modeOf(best.map((o) => discs[o].snap)) : JET, discs: best, rows, thickness: Math.round(thick * 10) / 10 });
  });
  return brows;
}

// Least-squares polynomial t(s) of the given degree (1 or 2) through [s, t] points.
function polyFit(pts, degree) {
  const n = degree + 1;
  const A = Array.from({ length: n }, () => new Float64Array(n)), b = new Float64Array(n);
  for (const [x, y] of pts) {
    const pw = Array.from({ length: n }, (_, i) => x ** i);
    for (let i = 0; i < n; i++) { b[i] += pw[i] * y; for (let j = 0; j < n; j++) A[i][j] += pw[i] * pw[j]; }
  }
  // Gaussian elimination.
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) return () => pts.reduce((s, p) => s + p[1], 0) / pts.length;
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const c = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let v = b[i]; for (let j = i + 1; j < n; j++) v -= A[i][j] * c[j]; c[i] = v / A[i][i]; }
  return (x) => c.reduce((s, ci, i) => s + ci * x ** i, 0);
}

// --- 5. Areas ----------------------------------------------------------------------------------

// Felzenszwalb-Huttenlocher on the disc graph (weights ΔE2000), then areas below MIN_AREA_DISCS
// joined to their most similar neighbour. Returns the area index per disc (-1 for discs not in use).
function segmentColour(discs, nb, use) {
  const edges = [];
  for (const d of discs) {
    if (!use[d.id]) continue;
    for (const o of nb[d.id]) if (o > d.id && use[o]) edges.push([d.id, o, deltaE2000(d.lab, discs[o].lab)]);
  }
  edges.sort((a, b) => a[2] - b[2]);
  const uf = unionFind(discs.length);
  const inner = new Float32Array(discs.length);
  for (const [a, b, w] of edges) {
    const ra = uf.find(a), rb = uf.find(b);
    if (ra === rb) continue;
    if (w <= Math.min(inner[ra] + SEGMENT_K / uf.size[ra], inner[rb] + SEGMENT_K / uf.size[rb])) {
      const r = uf.union(ra, rb);
      inner[r] = Math.max(inner[ra], inner[rb], w);
    }
  }
  for (const [a, b] of edges) {
    const ra = uf.find(a), rb = uf.find(b);
    if (ra !== rb && (uf.size[ra] < MIN_AREA_DISCS || uf.size[rb] < MIN_AREA_DISCS)) uf.union(ra, rb);
  }
  return relabel(discs, use, uf);
}

function relabel(discs, use, uf) {
  const ids = new Map();
  return discs.map((d) => {
    if (!use[d.id]) return -1;
    const r = uf.find(d.id);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r);
  });
}

// Areas of one key per disc (stencil: Jet or Crystal; halftone: the share level): pieces of equal
// key; pieces under minDiscs discs joined to the neighbour piece sharing most edges (halftone:
// nearest level first). Returns { areaOf, keyOf }.
function segmentByKey(discs, nb, use, key, minDiscs, nearness = null) {
  const uf = unionFind(discs.length);
  for (const d of discs) {
    if (!use[d.id]) continue;
    for (const o of nb[d.id]) if (use[o] && key[o] === key[d.id]) uf.union(d.id, o);
  }
  const keyOfRoot = new Map();
  for (const d of discs) if (use[d.id]) keyOfRoot.set(uf.find(d.id), key[d.id]);
  for (let round = 0; round < 4; round++) {
    let changed = false;
    const touch = new Map();
    for (const d of discs) {
      if (!use[d.id]) continue;
      const r = uf.find(d.id);
      if (uf.size[r] >= minDiscs) continue;
      for (const o of nb[d.id]) {
        if (!use[o]) continue;
        const ro = uf.find(o);
        if (ro === r) continue;
        if (!touch.has(r)) touch.set(r, new Map());
        touch.get(r).set(ro, (touch.get(r).get(ro) || 0) + 1);
      }
    }
    for (const [r, around] of touch) {
      if (uf.find(r) !== r || uf.size[r] >= minDiscs) continue;
      let best = null, score = -Infinity;
      for (const [ro, n] of around) {
        const s = n - (nearness ? 100 * Math.abs(keyOfRoot.get(uf.find(ro)) - keyOfRoot.get(r)) : 0);
        if (s > score) { score = s; best = uf.find(ro); }
      }
      if (best == null || best === r) continue;
      const k = keyOfRoot.get(best);
      const merged = uf.union(r, best);
      keyOfRoot.set(merged, k);
      changed = true;
    }
    if (!changed) break;
  }
  const areaOf = relabel(discs, use, uf);
  const keyOf = new Map();
  for (const d of discs) if (use[d.id]) keyOf.set(areaOf[d.id], keyOfRoot.get(uf.find(d.id)));
  return { areaOf, keyOf };
}

// At most MAX_TONES tones from the area's own snapped colours; returns { tones, toneOfDisc }.
function chooseTones(members) {
  const candidates = [...new Set(members.map((d) => d.snap))];
  const dist = members.map((d) => candidates.map((c) => deltaE2000(d.lab, labOf[c])));
  const chosen = [];
  let err = members.map(() => Infinity), total = Infinity;
  while (chosen.length < MAX_TONES && chosen.length < candidates.length) {
    let best = -1, bestTotal = Infinity, bestErr = null;
    candidates.forEach((c, ci) => {
      if (chosen.includes(ci)) return;
      const e = err.map((v, m) => Math.min(v, dist[m][ci]));
      const t = e.reduce((s, v) => s + v, 0);
      if (t < bestTotal) { bestTotal = t; best = ci; bestErr = e; }
    });
    if (best < 0) break;
    if (chosen.length) {
      const gain = total - bestTotal;
      const takers = members.filter((_, m) => dist[m][best] < Math.min(...chosen.map((ci) => dist[m][ci]))).length;
      if (gain < TONE_GAIN * total || takers < MIN_PATCH) break;
    }
    chosen.push(best);
    err = bestErr;
    total = bestTotal;
  }
  const tones = chosen.map((ci) => candidates[ci]);
  const toneOfDisc = members.map((_, m) => {
    let bi = 0;
    chosen.forEach((ci, t) => { if (dist[m][ci] < dist[m][chosen[bi]]) bi = t; });
    return bi;
  });
  return { tones, toneOfDisc };
}

// Patches of fewer than MIN_PATCH discs of one tone take their neighbours' most common tone (within
// the area). tone: Map(disc id -> tone index).
function joinSmallPatches(memberIds, nb, tone) {
  const inArea = new Set(memberIds);
  for (let round = 0; round < 6; round++) {
    let changed = false;
    const seen = new Set();
    for (const start of memberIds) {
      if (seen.has(start)) continue;
      const patch = [start];
      seen.add(start);
      for (let q = 0; q < patch.length; q++) {
        for (const o of nb[patch[q]]) if (inArea.has(o) && !seen.has(o) && tone.get(o) === tone.get(start)) { seen.add(o); patch.push(o); }
      }
      if (patch.length >= MIN_PATCH) continue;
      const around = [];
      const inPatch = new Set(patch);
      for (const p of patch) for (const o of nb[p]) if (inArea.has(o) && !inPatch.has(o)) around.push(tone.get(o));
      if (!around.length) continue;
      const t = modeOf(around);
      if (t === tone.get(start)) continue;
      for (const p of patch) tone.set(p, t);
      changed = true;
    }
    if (!changed) break;
  }
}

// The colour ramps of the catalogue (concept section 3: skin, fur, greys ...), light to dark. An
// area's ramp is the one holding most of its tones (the first listed on a tie); its outline colour is
// the ramp's darkest colour (concept section 4). Before (build 1) the outline took the darkest
// catalogue colour within 25 degrees of hue of the area's darkest tone, which for light skin (hue 47)
// reached Indian Siam, a lip red (rs-woman's neck).
export const RAMPS = Object.freeze([
  { id: "skin", colours: ["light-peach", "silk", "rose-gold", "vintage-rose", "golden-shadow", "light-colorado", "copper", "topaz", "colorado-topaz", "greige", "light-smoked-topaz", "smoked-topaz"] },
  { id: "gold", colours: ["citrine", "gold", "metallic-sunshine", "light-topaz", "light-colorado", "topaz", "colorado-topaz", "smoked-topaz"] },
  { id: "grey", colours: ["crystal-clear", "crystal", "silver", "grey", "black-diamond", "graphite", "jet-hematite", "hematite", "jet"] },
  { id: "red", colours: ["rose-peach", "padparadscha", "hyacinth", "scarlet", "light-siam", "siam", "indian-siam"] },
  { id: "pink", colours: ["rose", "amethyst", "fuchsia"] },
  { id: "blue", colours: ["light-sapphire", "aquamarine", "sapphire", "capri-blue"] },
  { id: "green", colours: ["chrysolite", "citrus-green", "peridot", "fern-green", "erinite", "emerald", "olivine", "khaki"] }
]);

export function rampOf(tones) {
  let best = RAMPS[2], n = 0;
  for (const r of RAMPS) {
    const c = tones.filter((t) => r.colours.includes(t)).length;
    if (c > n) { best = r; n = c; }
  }
  return best;
}

function outlineColourOf(area, mode, meanL) {
  if (mode !== "colour") return JET;
  const ramp = rampOf(area.tones);
  if (meanL < OUTLINE_JET_L || ramp.id === "grey") return JET;
  return ramp.colours[ramp.colours.length - 1];
}

function buildAreas(discs, nb, mode, style) {
  const use = discs.map((d) => !d.line && !d.edge);
  let areaOf, areas;
  if (mode === "colour") {
    areaOf = segmentColour(discs, nb, use);
    const count = Math.max(-1, ...areaOf) + 1;
    const members = Array.from({ length: count }, () => []);
    discs.forEach((d) => { if (areaOf[d.id] >= 0) members[areaOf[d.id]].push(d); });
    areas = members.map((list, id) => {
      const { tones, toneOfDisc } = chooseTones(list);
      const tone = new Map(list.map((d, m) => [d.id, toneOfDisc[m]]));
      joinSmallPatches(list.map((d) => d.id), nb, tone);
      for (const d of list) d.tone = tone.get(d.id);
      return { id, kind: "tones", tones, discs: list.length };
    });
  } else if (style === "stencil") {
    const key = discs.map((d) => (d.snap === JET ? 1 : 0));
    const seg = segmentByKey(discs, nb, use, key, MIN_PATCH);
    areaOf = seg.areaOf;
    areas = [...seg.keyOf.keys()].sort((a, b) => a - b).map((id) => ({ id, kind: "solid", tones: [seg.keyOf.get(id) ? JET : CRYSTAL], discs: 0 }));
    for (const d of discs) if (areaOf[d.id] >= 0) { d.tone = 0; areas[areaOf[d.id]].discs++; }
  } else {
    const share = jetShare(discs, (d) => !d.line);
    const level = share.map((v) => HALFTONE_LEVELS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)));
    const seg = segmentByKey(discs, nb, use, level, 10, true);
    areaOf = seg.areaOf;
    areas = [...seg.keyOf.keys()].sort((a, b) => a - b).map((id) => {
      const p = seg.keyOf.get(id);
      return { id, kind: p === 0 || p === 1 ? "solid" : "halftone", share: p, tones: p === 1 ? [JET] : p === 0 ? [CRYSTAL] : [JET, CRYSTAL], discs: 0 };
    });
    for (const d of discs) if (areaOf[d.id] >= 0) { d.tone = 0; areas[areaOf[d.id]].discs++; }
  }
  for (const d of discs) d.area = areaOf[d.id];
  const sumL = new Float64Array(areas.length);
  for (const d of discs) if (areaOf[d.id] >= 0) sumL[areaOf[d.id]] += d.lab[0];
  for (const a of areas) a.outlineColour = outlineColourOf(a, mode, sumL[a.id] / Math.max(1, a.discs));
  return areas;
}

// --- Shapes for the saved map ------------------------------------------------------------------

// The spacing that sizes RS computeSingleDistanceRing's grid (a cell is an eighth of it): 0.1 mm
// cells, coarser for a design so large that they would pass the RS grid budget (4 million cells).
export const traceSpacing = (box) => 8 * Math.max(0.1, Math.max(box.maxXmm - box.minXmm, box.maxYmm - box.minYmm) / 1900);

function boundaryLoops(grid, inside, box) {
  const loops = computeSingleDistanceRing({ insideAt: inside, boundingBox: box, spacingMm: traceSpacing(box), thresholdMm: 0.05 });
  return loops.filter((l) => l.length >= 4);
}

const thin = (points, step) => {
  const out = [];
  let last = null;
  for (const p of points) {
    if (last && Math.hypot(p.xMm - last.xMm, p.yMm - last.yMm) < step) continue;
    out.push([Math.round(p.xMm * 100) / 100, Math.round(p.yMm * 100) / 100]);
    last = p;
  }
  return out;
};

// --- The map -----------------------------------------------------------------------------------

// /layout answer + AI image ({ data, width, height } RGBA) -> the map. mode "colour" or "bw";
// style "halftone" or "stencil" (black & white only); threshold: the B&W L* threshold.
export function buildMap(layout, ai, { mode = "colour", style = "halftone", threshold = DEFAULT_BW_THRESHOLD } = {}) {
  const report = layout.report;
  if (!(Number(report?.mmPerPx) > 0) || !Array.isArray(report?.offsetMm)) throw new Error("The layout has no frame (mmPerPx, offsetMm).");
  const on = subjectOnGrid(ai, report);
  if (!on) throw new Error("The AI image has no subject.");
  const { grid, subject, part, parts } = on;
  const outside = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) outside[k] = subject[k] ? 0 : 1;
  const subjectDist = grid.distanceTo(outside);
  const discs = readDiscs(layout, ai, mode, threshold).filter((d) => {
    const k = grid.at(d.x, d.y);
    return k >= 0 && subject[k];
  }).map((d, id) => ({ ...d, id }));
  const owner = discCells(grid, subject, discs);
  const nb = discGraph(grid, owner, discs.length);
  markInk(discs, nb, mode, style);
  const regions = faceRegions(report, discs);
  // The AI's own dark outline along the subject's edge: the subject outline's job, neither line nor
  // area (its cells take the areas inside it). Light discs there are no light line either.
  for (const d of discs) {
    const k = grid.at(d.x, d.y), near = k < 0 || subjectDist[k] < EDGE_DISC_MM;
    d.edge = d.ink && near;
    d.lightEdge = d.light && near;
  }

  // Brows (concept section 5): never an area, never an ordinary line.
  const brows = report.face === "human" ? findBrows(discs, nb, regions, mode) : [];
  for (const b of brows) for (const o of b.discs) { discs[o].line = true; discs[o].ink = false; discs[o].light = false; }

  const lines = dropDoubled([
    ...findLines(grid, subject, subjectDist, owner, discs, regions, mode, "ink"),
    ...findLines(grid, subject, subjectDist, owner, discs, regions, mode, "light")
  ]).filter((l) => !brows.some((b) => l.points.filter((p) => b.rows[0].points.some((q) => Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm) < 2.5)).length > 0.3 * l.points.length))
    .map((l, id) => ({ ...l, id }));
  // A line's discs: the ink discs whose cells lie within LINE_BAND_MM of its path, so the areas on
  // both sides meet on the path, not at the edge of a thin dark strip beside it.
  for (const line of lines) {
    const band = new Set(line.discs);
    for (const p of line.points) {
      const { i0, i1, j0, j1 } = grid.span(p.xMm, p.yMm, LINE_BAND_MM);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * grid.w + i, o = owner[k];
          if (o >= 0 && discs[o][line.tone === "dark" ? "ink" : "light"] && Math.hypot(grid.cx(k) - p.xMm, grid.cy(k) - p.yMm) <= LINE_BAND_MM) band.add(o);
        }
      }
    }
    line.discs = [...band];
    for (const o of band) discs[o].line = true;
  }
  const areas = buildAreas(discs, nb, mode, style);

  // Area and tone of every subject cell; the cells of line discs take their nearest area's.
  const label = new Int32Array(grid.n).fill(-1);
  for (let k = 0; k < grid.n; k++) {
    const d = owner[k] >= 0 ? discs[owner[k]] : null;
    if (d && d.area >= 0) label[k] = d.area * 8 + d.tone;
  }
  // Near a line the areas are cut by its path: the cells within LINE_CUT_MM take the area of their own
  // side (the path itself is a barrier to the spreading), so where two areas meet at a line their
  // border is the line.
  const onPath = new Uint8Array(grid.n);
  for (const line of [...lines, ...brows.flatMap((b) => b.rows)]) {
    const pts = line.closed ? [...line.points, line.points[0]] : line.points;
    for (let q = 0; q + 1 < pts.length; q++) {
      const a = pts[q], b = pts[q + 1], steps = Math.max(1, Math.ceil(Math.hypot(b.xMm - a.xMm, b.yMm - a.yMm) * grid.ppmm * 2));
      for (let t = 0; t <= steps; t++) {
        const k = grid.at(a.xMm + (b.xMm - a.xMm) * t / steps, a.yMm + (b.yMm - a.yMm) * t / steps);
        if (k >= 0) onPath[k] = 1;
      }
    }
  }
  const lineDist = grid.distanceTo(onPath);
  const open = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) {
    if (lineDist[k] <= LINE_CUT_MM) label[k] = -1;
    open[k] = subject[k] && lineDist[k] > 0.15 ? 1 : 0;
  }
  grid.spread(label, open);
  grid.spread(label, subject);
  // Calm borders: areas smoothed at AREA_SMOOTH_MM, then the tones within each area.
  const areaOf = new Int32Array(grid.n).fill(-1), toneOf = new Int8Array(grid.n).fill(-1);
  for (let k = 0; k < grid.n; k++) if (label[k] >= 0) areaOf[k] = label[k] >> 3;
  grid.smoothLabels(areaOf, subject, AREA_SMOOTH_MM);
  for (let k = 0; k < grid.n; k++) {
    if (label[k] < 0) continue;
    label[k] = (label[k] >> 3) === areaOf[k] ? label[k] : -1;
  }
  grid.spread(label, subject);
  grid.smoothLabels(label, subject, TONE_SMOOTH_MM);
  for (let k = 0; k < grid.n; k++) {
    if (label[k] < 0 || areaOf[k] < 0) continue;
    toneOf[k] = (label[k] >> 3) === areaOf[k] ? label[k] & 7 : 0;
  }
  const border = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) {
    if (!subject[k]) { border[k] = 1; continue; }
    const i = k % grid.w;
    for (const m of [i > 0 ? k - 1 : -1, i < grid.w - 1 ? k + 1 : -1, k - grid.w, k + grid.w]) {
      if (m >= 0 && m < grid.n && areaOf[m] !== areaOf[k]) { border[k] = 1; break; }
    }
  }
  const borderDist = grid.distanceTo(border);
  const cellsOf = new Int32Array(areas.length);
  for (let k = 0; k < grid.n; k++) if (areaOf[k] >= 0) cellsOf[areaOf[k]]++;
  areas.forEach((a) => { a.areaMm2 = cellsOf[a.id] / (grid.ppmm * grid.ppmm); });

  return {
    mode, style: mode === "colour" ? null : style, threshold, report, grid, subject, part, parts, subjectDist, regions,
    discs, owner, lines, brows, areas, areaOf, toneOf, borderDist
  };
}

// The saved map: subject outline, areas (shapes, tones, outline colour), lines and face regions,
// in layout mm (rounded to 0.01 mm; shapes and lines thinned to about 0.4 mm steps).
export function mapToJSON(map) {
  const { grid, subject, areaOf } = map;
  const box = (test) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let k = 0; k < grid.n; k++) {
      if (!test(k)) continue;
      const x = grid.cx(k), y = grid.cy(k);
      if (x < a) a = x;
      if (x > c) c = x;
      if (y < b) b = y;
      if (y > d) d = y;
    }
    return { minXmm: a - 1, minYmm: b - 1, maxXmm: c + 1, maxYmm: d + 1 };
  };
  const at = (x, y) => grid.at(x, y);
  const outline = boundaryLoops(grid, (x, y) => { const k = at(x, y); return k >= 0 && subject[k] === 1; }, box((k) => subject[k]));
  // One pass for every area's box.
  const boxes = map.areas.map(() => ({ minXmm: Infinity, minYmm: Infinity, maxXmm: -Infinity, maxYmm: -Infinity }));
  for (let k = 0; k < grid.n; k++) {
    const a = areaOf[k];
    if (a < 0) continue;
    const b = boxes[a], x = grid.cx(k), y = grid.cy(k);
    if (x < b.minXmm) b.minXmm = x;
    if (x > b.maxXmm) b.maxXmm = x;
    if (y < b.minYmm) b.minYmm = y;
    if (y > b.maxYmm) b.maxYmm = y;
  }
  return {
    version: 1,
    mode: map.mode,
    style: map.style,
    frame: { mmPerPx: map.report.mmPerPx, offsetMm: map.report.offsetMm },
    subject: { parts: map.parts, outline: outline.map((l) => thin(l, 0.4)) },
    areas: map.areas.map((a) => {
      const b = boxes[a.id];
      const shape = Number.isFinite(b.minXmm)
        ? boundaryLoops(grid, (x, y) => { const k = at(x, y); return k >= 0 && areaOf[k] === a.id; }, { minXmm: b.minXmm - 1, minYmm: b.minYmm - 1, maxXmm: b.maxXmm + 1, maxYmm: b.maxYmm + 1 })
        : [];
      return {
        id: a.id, kind: a.kind, tones: a.tones, ...(a.share != null ? { share: a.share } : {}), outlineColour: a.outlineColour,
        discs: a.discs, areaMm2: Math.round(a.areaMm2 * 10) / 10, shape: shape.map((l) => thin(l, 0.4))
      };
    }),
    lines: map.lines.map((l) => ({ id: l.id, tone: l.tone, size: l.size, colour: l.colour, closed: l.closed, lengthMm: Math.round(l.lengthMm * 10) / 10, points: thin(l.points, 0.4) })),
    brows: (map.brows || []).map((b) => ({ eye: b.eye, colour: b.colour, thickness: b.thickness, rows: b.rows.map((r) => thin(r.points, 0.4)) })),
    faces: map.regions.map((r) => ({ kind: r.kind, x: +r.x.toFixed(2), y: +r.y.toFixed(2), ax: +r.ax.toFixed(2), ay: +r.ay.toFixed(2), angle: +r.angle.toFixed(4) }))
  };
}

// The map as a picture (PNG) at ppmm px per mm: every area in its tones (halftone areas in a grey
// of their share), area borders thin grey, lines in their colour (SS6 wide, SS4 narrow) over a casing
// (dark lines red, light lines blue, brows violet), the subject outline magenta, the face regions
// cyan.
export function mapPicture(map, ppmm = 6) {
  const { grid, areaOf, toneOf, subject, areas } = map;
  const w = Math.ceil(grid.w / grid.ppmm * ppmm), h = Math.ceil(grid.h / grid.ppmm * ppmm);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const colourOfCell = (k) => {
    const a = areas[areaOf[k]];
    if (!a) return [255, 255, 255];
    if (a.kind === "halftone") { const v = Math.round(245 - a.share * 225); return [v, v, v]; }
    return rgb(STONE_COLORS[a.tones[Math.max(0, toneOf[k])]].fill);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = grid.at(grid.x0 + (x + 0.5) / ppmm, grid.y0 + (y + 0.5) / ppmm);
      const p = (y * w + x) * 4;
      let c = [255, 255, 255];
      if (k >= 0 && subject[k]) {
        c = colourOfCell(k);
        const kr = grid.at(grid.x0 + (x + 1.5) / ppmm, grid.y0 + (y + 0.5) / ppmm), kd = grid.at(grid.x0 + (x + 0.5) / ppmm, grid.y0 + (y + 1.5) / ppmm);
        if ((kr >= 0 && areaOf[kr] !== areaOf[k]) || (kd >= 0 && areaOf[kd] !== areaOf[k])) c = [150, 150, 150];
      }
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const X = (x) => (x - grid.x0) * ppmm, Y = (y) => (y - grid.y0) * ppmm;
  const json = mapToJSON(map);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = "#ff00ff"; ctx.lineWidth = Math.max(1, 0.35 * ppmm);
  for (const loop of json.subject.outline) {
    ctx.beginPath();
    loop.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath(); ctx.stroke();
  }
  for (const line of [...map.lines, ...(map.brows || []).flatMap((b) => b.rows.map((r) => ({ ...r, colour: b.colour, brow: true })))]) {
    for (const [style, width] of [[line.brow ? "#7a00ff" : line.tone === "light" ? "#0050e0" : "#e0001a", line.d * 0.9 + 0.5], [STONE_COLORS[line.colour].fill, line.d * 0.9]]) {
      ctx.strokeStyle = style; ctx.lineWidth = width * ppmm;
      ctx.beginPath();
      line.points.forEach((p, i) => (i ? ctx.lineTo(X(p.xMm), Y(p.yMm)) : ctx.moveTo(X(p.xMm), Y(p.yMm))));
      if (line.closed) ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.strokeStyle = "#00b7ff"; ctx.lineWidth = Math.max(1, 0.3 * ppmm);
  for (const r of map.regions) {
    ctx.beginPath();
    ctx.ellipse(X(r.x), Y(r.y), r.ax * ppmm, r.ay * ppmm, r.angle, 0, 2 * Math.PI);
    ctx.stroke();
  }
  return canvas.toBuffer("image/png");
}
