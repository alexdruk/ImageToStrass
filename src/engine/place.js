import { PALETTE, deltaE2000, findHoles, lightnessOnWhite, neighbourVote, sampleLab } from "../pipeline/holes.js";
import { MIN_GAP_MM } from "../pipeline/tiers.js";
import { computeInwardRingPolygons, computeSingleDistanceRing } from "./ContourRingSampler.js";
import { createIncrementalHash, densifyRingForWalk, resampleByChordDistance, smoothPolyline } from "./LineDesignSampler.js";
import { blocksLine, inAnyRegion, inRegion } from "./faces.js";
import { buildFace } from "./features.js";
import { JET, MIN_LINE_STONES, MIN_PATCH, ROW_GAP_MM, SS4_MM, SS6_MM, traceSpacing } from "./map.js";

// Placement (exp-engine, design concept section 7; docs/exp-engine.md section 2): IS places every
// stone itself from the map, in the concept's priority order, and a stone of a higher rule is never
// removed for a lower one (each later stone must keep MIN_GAP_MM to every earlier one):
//
//   1. Features. Landmark faces (build 3): every face's features built by the concept (features.js
//      buildFace: eyes, lips, teeth, nose), role "feature" with its part, the lines among them
//      chains. Pupil regions (faces without landmarks, builds 1 and 2): today's stones whose centre
//      lies in an eye or mouth region, unchanged.
//   1b. Brows (map.js findBrows): each row a chain along its path, inner end first, in the brow's
//      colour, SS6 (a piece of at least MIN_LINE_STONES stones).
//   2. Lines, dark and light, longest first: stones along each smoothed path at an even chord step
//      (the line's size plus ROW_GAP_MM; RS resampleByChordDistance), all in the line's colour and
//      size. Where a stone cannot be placed the chain skips it; it stays one chain across a crossing
//      (the skipped spot holds a stone of an earlier chain), else it is split there. Pieces of at
//      least MIN_LINE_STONES stones are its chains, shorter ones are dropped (they are no line).
//   3. Subject outline: SS6 stones on the ring one radius inside the subject's edge (RS
//      computeSingleDistanceRing), one closed chain per part and per enclosed hole, each stone in the
//      outline colour of the area beside it; colour runs shorter than MIN_PATCH take their
//      neighbours' colour, and every colour run is its own chain.
//   4. Areas, largest first. A band of bandRows (1 or 2) rows parallel to the area's outline and to
//      the chains in it (RS computeInwardRingPolygons; rows RING_STEP apart so each nests into the
//      gaps of the one before), each row walked in fine steps and a stone placed wherever it keeps
//      ROW_GAP_MM to everything; the first row lies where an SS6 stone just fits: ROW_GAP_MM from the
//      stones of steps 1-3, half of it from the area's border, inside the subject. Inside the band a
//      honeycomb: SS6 stones on a hexagonal lattice of pitch SS6 + ROW_GAP_MM, its rows along the
//      area's main direction (the principal axis of its cells), at the lattice phase (of
//      HEX_PHASES) that places most stones. bandRows "all" is build 1: rows all the way in. Tone: the
//      map's tone under the stone's centre; black & white halftone: a regular Jet / Crystal pattern
//      of the area's share on the honeycomb's lattice (an ordered 4 x 4 dither of the lattice index;
//      band stones take the index of their nearest lattice point).
//   5. Seams (where the band meets the honeycomb) and other spaces: the hole fill of spec 7.5
//      (holes.findHoles: SS6 where one fits, then SS4, MIN_GAP_MM to everything), each in its
//      neighbours' colour among the area stones
//      (holes.neighbourVote; lines, outline and features do not vote).
//   5b. Settle: the area and seam stones around an empty circle wider than SETTLE_HOLE_MM move
//      towards it as far as the gaps allow (settle below); then the hole fill once more.
//   5c. Holes (build 3, check 4): every empty circle of HOLE_LIMIT_MM or more is targeted by moving
//      the area and seam stones around it (closeHoles below; lines, the outline, brows and features
//      never move), keeping MIN_GAP_MM: closed, or opened until an SS4 stone fits in it.
//   6. Patches: area stones of one colour in a patch of fewer than MIN_PATCH take their neighbours'
//      most common colour within the area (not in halftone areas, whose pattern is meant).
//
// Strands (map.js, build 3): the lines in them are placed like any line (their stones may reach to
// within 0.4 of their radius of the subject's edge, a strand being about one stone wide); the
// outline runs along the subject's body, and no area row or honeycomb goes into a strand (the seam
// fill does, where a stone still fits beside the strand's line or the strand has none).
//
// Stones are plain { x, y, d, color, role, chain, area } in layout mm; role is "feature" (with part),
// "brow", "line", "outline", "area", "hex" (honeycomb) or "seam".

export const RING_STEP_MM = 0.9 * (SS6_MM + ROW_GAP_MM);
export const BREAK_FACTOR = 1.5;
export const PATCH_GAP_MM = 0.6;
export const BAND_ROWS = 2;
// "area": every area packed on its own (band along its outline, its own honeycomb); "shared": the
// areas that touch without a chain between them are packed as one piece (a band along the chains,
// the subject's edge and the face regions, one honeycomb), the colours still those of each area.
export const PACKING = "shared";
export const HEX_PITCH_MM = SS6_MM + ROW_GAP_MM;
export const HEX_PHASES = Object.freeze([0, 1 / 3, 2 / 3].flatMap((i) => [0, 1 / 3, 2 / 3].map((j) => [i, j])));
export const HEX_FIRST = false;
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
export const ditherJet = (i, j, share) => (BAYER4[((i % 4) + 4) % 4][((j % 4) + 4) % 4] + 0.5) / 16 < share;

const HASH_CELL_MM = 5;
const LAB = Object.fromEntries(PALETTE.map((p) => [p.id, p.lab]));
const labOf = (id) => LAB[id];
const CLEAR_CAP_MM = 3;
const SMOOTH = 9;

// Points -> runs, split where two consecutive points lie more than BREAK_FACTOR steps apart, unless
// keep(a, b) says the gap is a crossing.
function splitAtBreaks(points, pitch, keep = null) {
  const runs = [];
  let run = [];
  for (const p of points) {
    const last = run[run.length - 1];
    const gap = last && Math.hypot(p.xMm - last.xMm, p.yMm - last.yMm);
    if (last && gap > BREAK_FACTOR * pitch && !(keep && gap < 3.2 * pitch && keep(last, p))) { runs.push(run); run = []; }
    run.push(p);
  }
  if (run.length) runs.push(run);
  return runs;
}

// Colour runs along a chain: runs shorter than MIN_PATCH take the colour of their longer neighbour.
function calmColours(colours, closed) {
  const out = [...colours];
  for (let round = 0; round < 4; round++) {
    const runs = [];
    for (let i = 0; i < out.length; i++) {
      if (i && out[i] === out[i - 1]) runs[runs.length - 1].n++;
      else runs.push({ c: out[i], start: i, n: 1 });
    }
    if (closed && runs.length > 1 && runs[0].c === runs[runs.length - 1].c) {
      const last = runs.pop();
      runs[0].n += last.n; runs[0].start = last.start;
    }
    if (runs.length < 2) break;
    let changed = false;
    runs.forEach((r, ri) => {
      if (r.n >= MIN_PATCH) return;
      const prev = runs[(ri - 1 + runs.length) % runs.length], next = runs[(ri + 1) % runs.length];
      const pick = (!closed && ri === 0) ? next : (!closed && ri === runs.length - 1) ? prev : prev.n >= next.n ? prev : next;
      if (pick === r) return;
      for (let k = 0; k < r.n; k++) out[(r.start + k) % out.length] = pick.c;
      changed = true;
    });
    if (!changed) break;
  }
  return out;
}

// map (map.js) + today's stones (plain { x, y, d, color } in layout mm) -> { stones, chains, stats }.
// ai: the AI image (holes.findHoles reads the subject from it).
// photoLab: (x, y) -> CIE Lab of the prepared photo there (layout mm), or null (iris colours).
// closeHoles: false skips step 5c (the experiment measures the design without it).
export function placeStones(map, ai, { today = [], debug = null, bandRows = BAND_ROWS, packing = PACKING, hexFirst = HEX_FIRST, photoLab = null, closeHoles: targetHoles = true } = {}) {
  const { grid, subject, subjectDist, regions, areas, areaOf, toneOf, borderDist } = map;
  const protrusion = map.protrusion ?? new Uint8Array(grid.n);
  const body = map.body ?? subject;
  const stones = [];
  const chains = [];
  const hash = createIncrementalHash(HASH_CELL_MM);
  const chainIndex = new Map();
  const cellIndex = new Map();
  const add = (st) => {
    stones.push(st);
    hash.add({ xMm: st.x, yMm: st.y, sizeMm: st.d });
    const ck = `${Math.floor(st.x / HASH_CELL_MM)},${Math.floor(st.y / HASH_CELL_MM)}`;
    if (!cellIndex.has(ck)) cellIndex.set(ck, []);
    cellIndex.get(ck).push(st);
    if (st.chain != null) {
      const key = `${Math.floor(st.x / HASH_CELL_MM)},${Math.floor(st.y / HASH_CELL_MM)}`;
      if (!chainIndex.has(key)) chainIndex.set(key, []);
      chainIndex.get(key).push(st);
    }
    return stones.length - 1;
  };
  // Does a stone of another chain sit between two consecutive candidates (a crossing)?
  const bridged = (a, b, chain) => {
    const mx = (a.xMm + b.xMm) / 2, my = (a.yMm + b.yMm) / 2, reach = Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) / 2;
    const gx = Math.floor(mx / HASH_CELL_MM), gy = Math.floor(my / HASH_CELL_MM);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const st of chainIndex.get(`${gx + i},${gy + j}`) || []) if (st.chain !== chain && Math.hypot(st.x - mx, st.y - my) < reach) return true;
    }
    return false;
  };
  const insideSubject = (x, y, r) => { const k = grid.at(x, y); return k >= 0 && subject[k] && subjectDist[k] >= r; };
  // A line's stone: in a strand it may reach closer to the edge.
  const insideLine = (x, y, r) => { const k = grid.at(x, y); return k >= 0 && subject[k] && subjectDist[k] >= (protrusion[k] ? 0.4 * r : r); };
  const stats = { features: 0, keptToday: 0, brows: 0, lines: 0, lineChains: 0, linePiecesDropped: 0, lineBreaks: 0, crossings: 0, outline: 0, outlineChains: 0, area: 0, hex: 0, seam: 0, recoloured: 0 };

  const chainOf = (kind, colour, d, points, closed, role = kind, part = undefined) => {
    const id = chains.length;
    chains.push({ id, kind, colour, d, closed, stones: [] });
    chains[id].stones = points.map((p) => add({ x: p.xMm, y: p.yMm, d, color: colour, role, chain: id, area: null, ...(part ? { part } : {}) }));
    return id;
  };

  // 1. Features: today's stones in the pupil regions; the landmark faces' features.
  for (const st of today) {
    if (!regions.some((r) => !r.poly && inRegion(r, st.x, st.y))) continue;
    add({ x: st.x, y: st.y, d: st.d, color: st.color, role: "feature", part: "kept", chain: null, area: null });
    stats.keptToday++;
  }
  if (map.faces?.length) {
    const s = Number(map.report.mmPerPx), [ox, oy] = map.report.offsetMm;
    const fits = (x, y, d) => insideSubject(x, y, d / 2 - 0.05) && !hash.overlaps(x, y, d, MIN_GAP_MM);
    const env = {
      mode: map.mode, threshold: map.threshold, discs: map.discs, photoLab, fits,
      put: (x, y, d, colour, part) => { stats.features++; return add({ x, y, d, color: colour, role: "feature", part, chain: null, area: null }); },
      chain: (part, colour, d, pts, closed, minStones = MIN_LINE_STONES) => {
        const pitch = d + ROW_GAP_MM;
        const placed = resampleByChordDistance(pts.map(([x, y]) => ({ xMm: x, yMm: y })), pitch, closed, (p) => fits(p.xMm, p.yMm, d));
        const runs = splitAtBreaks(placed, pitch);
        let n = 0;
        for (const run of runs) {
          if (run.length < minStones) continue;
          const ring = closed && runs.length === 1 && run.length > 2 &&
            Math.hypot(run[0].xMm - run[run.length - 1].xMm, run[0].yMm - run[run.length - 1].yMm) <= BREAK_FACTOR * pitch;
          chainOf(part, colour, d, run, ring, "feature", part);
          n += run.length;
        }
        stats.features += n;
        return n;
      },
      clearance: (x, y) => {
        let m = 6;
        const gx = Math.floor(x / HASH_CELL_MM), gy = Math.floor(y / HASH_CELL_MM);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          for (const st of cellIndex.get(`${gx + a},${gy + b}`) || []) m = Math.min(m, Math.hypot(st.x - x, st.y - y) - st.d / 2);
        }
        return m;
      },
      aiL: (x, y, d) => lightnessOnWhite(ai, (x + ox) / s, (y + oy) / s, d, s),
      aiLab: (x, y, d) => sampleLab(ai, (x + ox) / s, (y + oy) / s, d, s),
      areaColourAt: (x, y) => { const k = grid.at(x, y); return k >= 0 && areaOf[k] >= 0 ? areas[areaOf[k]].tones[Math.max(0, toneOf[k])] : null; },
      areaTonesAt: (x, y) => { const k = grid.at(x, y); return k >= 0 && areaOf[k] >= 0 ? areas[areaOf[k]].tones : null; }
    };
    stats.faces = map.faces.map((face) => buildFace(face, env));
  }

  // 1b. Brows; 2. Lines.
  for (const brow of map.brows || []) {
    for (const row of brow.rows) {
      const pitch = row.d + ROW_GAP_MM;
      const accept = (p) => insideSubject(p.xMm, p.yMm, row.d / 2) && !inAnyRegion(regions, p.xMm, p.yMm, row.d / 2) && !hash.overlaps(p.xMm, p.yMm, row.d, MIN_GAP_MM);
      for (const run of splitAtBreaks(resampleByChordDistance(row.points, pitch, false, accept), pitch)) {
        if (run.length < MIN_LINE_STONES) continue;
        chainOf("brow", brow.colour, row.d, run, false);
        stats.brows += run.length;
      }
    }
  }
  for (const line of [...map.lines].sort((a, b) => b.lengthMm - a.lengthMm)) {
    const pitch = line.d + ROW_GAP_MM;
    const accept = (p) => insideLine(p.xMm, p.yMm, line.d / 2) && !blocksLine(regions, p.xMm, p.yMm, line.d / 2) &&
      !hash.overlaps(p.xMm, p.yMm, line.d, MIN_GAP_MM);
    const placed = resampleByChordDistance(line.points, pitch, line.closed, accept);
    const runs = splitAtBreaks(placed, pitch, (a, b) => { const yes = bridged(a, b, null); if (yes) stats.crossings++; return yes; });
    if (runs.length > 1) stats.lineBreaks += runs.length - 1;
    const whole = runs.length === 1 && line.closed && placed.length > 2 &&
      Math.hypot(placed[0].xMm - placed[placed.length - 1].xMm, placed[0].yMm - placed[placed.length - 1].yMm) <= BREAK_FACTOR * pitch;
    for (const run of runs) {
      if (run.length < MIN_LINE_STONES) { stats.linePiecesDropped++; continue; }
      chainOf("line", line.colour, line.d, run, whole);
      stats.lineChains++;
      stats.lines += run.length;
    }
  }

  // 3. Subject outline.
  const box = { minXmm: grid.x0, minYmm: grid.y0, maxXmm: grid.x0 + grid.w / grid.ppmm, maxYmm: grid.y0 + grid.h / grid.ppmm };
  const r6 = SS6_MM / 2, pitch6 = SS6_MM + ROW_GAP_MM;
  const loops = computeSingleDistanceRing({ insideAt: (x, y) => { const k = grid.at(x, y); return k >= 0 && body[k] === 1; }, boundingBox: box, spacingMm: traceSpacing(box), thresholdMm: r6 + 0.02 });
  const outlineColourAt = (x, y) => { const k = grid.at(x, y); return k >= 0 && areaOf[k] >= 0 ? areas[areaOf[k]].outlineColour : JET; };
  for (const loop of loops) {
    if (loop.length < 8) continue;
    const smooth = smoothPolyline(smoothPolyline(loop, SMOOTH, true), SMOOTH, true);
    const accept = (p) => insideSubject(p.xMm, p.yMm, r6 - 0.05) && !inAnyRegion(regions, p.xMm, p.yMm, r6) && !hash.overlaps(p.xMm, p.yMm, SS6_MM, MIN_GAP_MM);
    let placed = resampleByChordDistance(smooth, pitch6, true, accept);
    if (placed.length < MIN_LINE_STONES) continue;
    // Start at a break, if there is one, so every run is one piece.
    let cut = -1;
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i], b = placed[(i + 1) % placed.length];
      if (Math.hypot(a.xMm - b.xMm, a.yMm - b.yMm) > BREAK_FACTOR * pitch6) { cut = i; break; }
    }
    const closedRing = cut < 0;
    if (!closedRing) placed = [...placed.slice(cut + 1), ...placed.slice(0, cut + 1)];
    for (const run of splitAtBreaks(placed, pitch6)) {
      if (run.length < MIN_LINE_STONES) continue;
      const colours = calmColours(run.map((p) => outlineColourAt(p.xMm, p.yMm)), closedRing);
      // Each colour run is a chain; on a closed ring, the run that wraps around starts the list.
      let start = 0;
      if (closedRing && colours[0] === colours[colours.length - 1] && new Set(colours).size > 1) {
        while (colours[start] === colours[0]) start++;
      }
      const order = [...run.keys()].map((i) => (i + start) % run.length);
      // Colour pieces in ring order; a piece shorter than MIN_LINE_STONES joins the piece before it
      // (or after it, at the start), taking its colour, so every outline chain is a chain.
      const pieces = [];
      for (const i of order) {
        const last = pieces[pieces.length - 1];
        if (last && colours[i] === last.colour) last.members.push(i);
        else pieces.push({ colour: colours[i], members: [i] });
      }
      for (let p = 0; p < pieces.length && pieces.length > 1; p++) {
        if (pieces[p].members.length >= MIN_LINE_STONES) continue;
        const into = p > 0 ? pieces[p - 1] : pieces[1];
        if (p > 0) into.members.push(...pieces[p].members); else into.members.unshift(...pieces[p].members);
        pieces.splice(p, 1);
        p--;
      }
      for (const piece of pieces) {
        chainOf("outline", piece.colour, SS6_MM, piece.members.map((i) => run[i]), closedRing && pieces.length === 1);
        stats.outlineChains++;
        stats.outline += piece.members.length;
      }
    }
  }

  // 4. Areas. free: how far (mm) an SS6 stone centred on the cell could move and still fit.
  // Clearance to the stones so far; a chain counts as its path (a capsule from each stone to the
  // next), so the first row beside it runs parallel to it instead of following each stone.
  const clear = new Float32Array(grid.n).fill(CLEAR_CAP_MM);
  const carve = (a, b, r) => {
    const { i0, i1, j0, j1 } = grid.span((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2 + r + CLEAR_CAP_MM);
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.w + i, px = grid.cx(k), py = grid.cy(k);
        const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
        const c = Math.hypot(px - a.x - t * dx, py - a.y - t * dy) - r;
        if (c < clear[k]) clear[k] = c;
      }
    }
  };
  for (const st of stones) if (st.chain == null) carve(st, st, st.d / 2);
  for (const ch of chains) {
    const m = ch.stones.map((i) => stones[i]);
    m.forEach((st, q) => {
      const next = q + 1 < m.length ? m[q + 1] : ch.closed ? m[0] : st;
      carve(st, next, ch.d / 2);
    });
  }
  const free = new Float32Array(grid.n).fill(-1);
  for (let k = 0; k < grid.n; k++) {
    if (!subject[k] || areaOf[k] < 0 || protrusion[k]) continue;
    const own = Math.min(clear[k] - (r6 + ROW_GAP_MM), subjectDist[k] - r6);
    free[k] = packing === "shared" ? own : Math.min(own, borderDist[k] - (r6 + ROW_GAP_MM / 2));
  }
  for (const reg of regions) {
    const span = grid.span(reg.x, reg.y, Math.max(reg.ax, reg.ay) + r6);
    for (let j = span.j0; j <= span.j1; j++) {
      for (let i = span.i0; i <= span.i1; i++) { const k = j * grid.w + i; if (inRegion(reg, grid.cx(k), grid.cy(k), r6)) free[k] = -1; }
    }
  }
  // The pieces packed one at a time: the areas, or (shared) the connected pieces of the free cells.
  let pack = areaOf, pieces = areas.length;
  if (packing === "shared") {
    pack = new Int32Array(grid.n).fill(-1);
    pieces = 0;
    for (let k0 = 0; k0 < grid.n; k0++) {
      if (free[k0] < 0 || pack[k0] >= 0) continue;
      const stack = [k0];
      pack[k0] = pieces;
      while (stack.length) {
        const c = stack.pop(), i = c % grid.w;
        for (const m of [i > 0 ? c - 1 : -1, i < grid.w - 1 ? c + 1 : -1, c - grid.w, c + grid.w]) {
          if (m >= 0 && m < grid.n && free[m] >= 0 && pack[m] < 0) { pack[m] = pieces; stack.push(m); }
        }
      }
      pieces++;
    }
  }
  const boxes = Array.from({ length: pieces }, () => ({ minXmm: Infinity, minYmm: Infinity, maxXmm: -Infinity, maxYmm: -Infinity, n: 0 }));
  for (let k = 0; k < grid.n; k++) {
    if (free[k] < 0 || pack[k] < 0) continue;
    const b = boxes[pack[k]], x = grid.cx(k), y = grid.cy(k);
    b.n++;
    if (x < b.minXmm) b.minXmm = x;
    if (x > b.maxXmm) b.maxXmm = x;
    if (y < b.minYmm) b.minYmm = y;
    if (y > b.maxYmm) b.maxYmm = y;
  }
  const freeAt = (x, y) => { const k = grid.at(x, y); return k >= 0 ? free[k] : -1; };
  // Depth: how far inside the free region a cell lies (the band's rows and the honeycomb's start).
  const notFree = new Uint8Array(grid.n);
  for (let k = 0; k < grid.n; k++) notFree[k] = free[k] < 0 ? 1 : 0;
  const depth = grid.distanceTo(notFree);
  const depthAt = (x, y) => { const k = grid.at(x, y); return k >= 0 ? depth[k] : 0; };
  const toneAt = (a, x, y) => {
    const votes = new Map();
    const { i0, i1, j0, j1 } = grid.span(x, y, 0.6 * r6);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.w + i;
        if (areaOf[k] !== a.id || Math.hypot(grid.cx(k) - x, grid.cy(k) - y) > 0.6 * r6) continue;
        votes.set(toneOf[k], (votes.get(toneOf[k]) || 0) + 1);
      }
    }
    let best = 0, n = -1;
    for (const [t, c] of votes) if (c > n) { best = t; n = c; }
    return a.tones[Math.max(0, Math.min(a.tones.length - 1, best))];
  };
  const order = boxes.map((_, id) => id).filter((id) => boxes[id].n > 0).sort((p, q) => boxes[q].n - boxes[p].n);
  const areaHere = (x, y) => { const k = grid.at(x, y); return k >= 0 && areaOf[k] >= 0 ? areas[areaOf[k]] : null; };
  const allRows = bandRows === "all";
  const bandDepth = allRows ? Infinity : bandRows * RING_STEP_MM - 0.02;
  for (const id of order) {
    const b = boxes[id];
    const inside = (x, y) => { const k = grid.at(x, y); return k >= 0 && pack[k] === id && free[k] >= 0; };
    const rings = computeInwardRingPolygons({
      insideAt: inside,
      boundingBox: { minXmm: b.minXmm - 0.5, minYmm: b.minYmm - 0.5, maxXmm: b.maxXmm + 0.5, maxYmm: b.maxYmm + 0.5 },
      spacingMm: RING_STEP_MM,
      startOffsetMm: 0.05
    }).filter((ring) => {
      // A ring's depth: the free distance under its vertices (the ring is an iso-line of it).
      const depths = ring.filter((_, i) => i % 7 === 0).map((p) => depthAt(p.xMm, p.yMm)).sort((p, q) => p - q);
      return depths[depths.length >> 1] < bandDepth;
    });
    if (debug) debug.push(...rings.map((r) => ({ area: id, ring: r })));
    const placedHere = [];
    const placeBand = () => {
      for (const ring of rings) {
        let along = 0;
        for (const p of densifyRingForWalk(ring, 0.1)) {
          if (freeAt(p.xMm, p.yMm) < -0.05 || hash.overlaps(p.xMm, p.yMm, SS6_MM, ROW_GAP_MM)) continue;
          const a = areaHere(p.xMm, p.yMm);
          if (!a) continue;
          let color = null;
          if (a.kind === "halftone" && allRows) {
            const row = Math.max(0, Math.round(depthAt(p.xMm, p.yMm) / RING_STEP_MM));
            const phase = (row % 2) * 0.5;
            color = Math.floor((along + 1) * a.share + phase) > Math.floor(along * a.share + phase) ? a.tones[0] : a.tones[1];
          } else if (a.kind !== "halftone") {
            color = toneAt(a, p.xMm, p.yMm);
          }
          placedHere.push(add({ x: p.xMm, y: p.yMm, d: SS6_MM, color, role: "area", chain: null, area: a.id }));
          along++;
          stats.area++;
        }
      }
    };
    if (allRows) { placeBand(); continue; }
    // The honeycomb inside the band, along the area's main direction.
    const lattice = honeycomb(grid, pack, depth, id, b, bandRows);
    let best = null;
    const placeHex = () => {
      for (const [fi, fj] of HEX_PHASES) {
        const pts = lattice.points(fi, fj).filter((p) => !hash.overlaps(p.xMm, p.yMm, SS6_MM, ROW_GAP_MM));
        if (!best || pts.length > best.pts.length) best = { pts, fi, fj };
      }
      for (const p of best.pts) {
        const a = areaHere(p.xMm, p.yMm);
        if (!a || hash.overlaps(p.xMm, p.yMm, SS6_MM, ROW_GAP_MM)) continue;
        const color = a.kind === "halftone" ? (ditherJet(p.i, p.j, a.share) ? a.tones[0] : a.tones[1]) : toneAt(a, p.xMm, p.yMm);
        add({ x: p.xMm, y: p.yMm, d: SS6_MM, color, role: "hex", chain: null, area: a.id });
        stats.hex++;
      }
    };
    if (hexFirst) { placeHex(); placeBand(); } else { placeBand(); placeHex(); }
    for (const i of placedHere) {
      const a = areas[stones[i].area];
      if (a.kind !== "halftone") continue;
      const [li, lj] = lattice.index(stones[i].x, stones[i].y, best.fi, best.fj);
      stones[i].color = ditherJet(li, lj, a.share) ? a.tones[0] : a.tones[1];
    }
  }

  // 5. Seams and other spaces: the hole fill, in the area stones' colours; 5b. settle; then the fill
  // once more for any spot the settling opened.
  const areaAt = (x, y) => { const k = grid.at(x, y); return k >= 0 && areaOf[k] >= 0 ? areaOf[k] : null; };
  const fill = () => {
    const found = findHoles(stones.map((s) => ({ x: s.x, y: s.y, d: s.d })), ai, map.report);
    // The vote runs per area (the area and seam stones of the hole's area), then once more over
    // every area and seam stone for holes with no voter of their own area within reach.
    const holes = found.holes.map((h) => ({ x: h.x, y: h.y, d: h.d, area: areaAt(h.x, h.y) }));
    const colourOfHole = new Map();
    const vote = (voterIdx, holeIdx, reachOnly) => {
      const pool = [...voterIdx.map((i) => stones[i]), ...holeIdx.map((h) => holes[h])];
      const targets = new Set(holeIdx.map((_, k) => voterIdx.length + k));
      if (!targets.size || !voterIdx.length) return;
      const voted = neighbourVote(pool, targets, (st) => st.color);
      holeIdx.forEach((h, k) => {
        const c = voted.get(voterIdx.length + k);
        if (!c) return;
        if (reachOnly) {
          const near = voterIdx.some((i) => Math.hypot(stones[i].x - holes[h].x, stones[i].y - holes[h].y) - (stones[i].d + holes[h].d) / 2 < 1);
          if (!near) return;
        }
        colourOfHole.set(h, c);
      });
    };
    const byArea = new Map();
    stones.forEach((s, i) => { if (s.role === "area" || s.role === "hex" || s.role === "seam") { if (!byArea.has(s.area)) byArea.set(s.area, []); byArea.get(s.area).push(i); } });
    const holesByArea = new Map();
    holes.forEach((h, k) => { if (!holesByArea.has(h.area)) holesByArea.set(h.area, []); holesByArea.get(h.area).push(k); });
    for (const [a, list] of holesByArea) if (a != null && byArea.has(a)) vote(byArea.get(a), list, true);
    const rest = holes.map((_, k) => k).filter((k) => !colourOfHole.has(k));
    vote([...byArea.values()].flat(), rest, false);
    holes.forEach((h, k) => {
      add({ x: h.x, y: h.y, d: h.d, color: colourOfHole.get(k) ?? JET, role: "seam", chain: null, area: h.area });
      stats.seam++;
    });
  };
  fill();
  stats.settled = settle(map, stones);
  fill();
  const beforeHoles = stones.map(({ x, y, d, color, role }) => ({ x, y, d, color, role }));
  if (targetHoles) stats.holes = closeHoles(map, stones, (h) => {
    // An opened spot's SS4: its neighbours' colour among the area stones of its area.
    const a = areaAt(h.x, h.y);
    const voters = stones.filter((s) => (s.role === "area" || s.role === "hex" || s.role === "seam") && Math.hypot(s.x - h.x, s.y - h.y) < 4 && (a == null || s.area === a));
    const colour = voters.length ? neighbourVote([...voters, h], new Set([voters.length]), (st) => st.color).get(voters.length) : null;
    stones.push({ x: h.x, y: h.y, d: h.d, color: colour ?? voters[0]?.color ?? JET, role: "seam", chain: null, area: a });
    stats.seam++;
  });

  // 6. Every area and seam stone takes a tone of the area under its centre (the nearest by ΔE2000 if
  // its colour is not one), then patches below MIN_PATCH within an area take their neighbours' colour.
  for (const s of stones) {
    if (s.role !== "area" && s.role !== "hex" && s.role !== "seam") continue;
    const a = areaAt(s.x, s.y);
    if (a == null) continue;
    s.area = a;
    const tones = areas[a].tones;
    if (tones.includes(s.color)) continue;
    s.color = tones.reduce((p, q) => (deltaE2000(labOf(s.color), labOf(q)) < deltaE2000(labOf(s.color), labOf(p)) ? q : p));
    stats.retoned = (stats.retoned || 0) + 1;
  }
  stats.recoloured = joinPatches(stones, areas);
  return { stones, chains, stats, beforeHoles };
}

// Settle (step 5b): rows nest imperfectly where they bend, and seams leave spots a little too wide
// for an SS4 stone; the area and seam stones around such a spot (an empty circle wider than
// SETTLE_HOLE_MM, measured on the map grid against every stone and the subject's edge) move towards
// its centre, each as far as keeps MIN_GAP_MM to every other stone, the stone inside the subject
// and out of the face regions, at most to close the circle to SETTLE_HOLE_MM. Lines, outline and
// features never move. SETTLE_ROUNDS rounds; returns the number of moves.
export const SETTLE_HOLE_MM = 0.96;
export const SETTLE_ROUNDS = 14;

function settle(map, stones) {
  const { grid, subject, subjectDist, regions } = map;
  const cap = 1.5;
  let moves = 0;
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const clear = new Float32Array(grid.n).fill(cap);
    for (const s of stones) {
      const r = s.d / 2, { i0, i1, j0, j1 } = grid.span(s.x, s.y, r + cap);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * grid.w + i;
          const c = Math.hypot(grid.cx(k) - s.x, grid.cy(k) - s.y) - r;
          if (c < clear[k]) clear[k] = c;
        }
      }
    }
    // Local maxima of the clearance above the limit: the holes' centres.
    const holes = [];
    for (let k = 0; k < grid.n; k++) {
      if (!subject[k]) continue;
      const c = Math.min(clear[k], subjectDist[k]);
      if (c <= SETTLE_HOLE_MM / 2) continue;
      const i = k % grid.w;
      let top = true;
      for (const m of [i > 0 ? k - 1 : -1, i < grid.w - 1 ? k + 1 : -1, k - grid.w, k + grid.w, k - grid.w - 1, k - grid.w + 1, k + grid.w - 1, k + grid.w + 1]) {
        if (m >= 0 && m < grid.n && subject[m] && Math.min(clear[m], subjectDist[m]) > c) { top = false; break; }
      }
      if (top) holes.push({ x: grid.cx(k), y: grid.cy(k), c });
    }
    if (!holes.length) break;
    const cell = 5, index = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    stones.forEach((s, i) => { const k = key(s.x, s.y); if (!index.has(k)) index.set(k, []); index.get(k).push(i); });
    const near = (x, y) => {
      const out = [], gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const i of index.get(`${gx + a},${gy + b}`) || []) out.push(i);
      return out;
    };
    const fits = (i, x, y) => {
      const s = stones[i], k = grid.at(x, y);
      if (k < 0 || !subject[k] || subjectDist[k] < s.d / 2 - 0.05 || inAnyRegion(regions, x, y)) return false;
      for (const j of near(x, y)) {
        if (j === i) continue;
        const o = stones[j];
        if (Math.hypot(o.x - x, o.y - y) - (o.d + s.d) / 2 < MIN_GAP_MM + 1e-6) return false;
      }
      return true;
    };
    let moved = 0;
    holes.sort((p, q) => q.c - p.c);
    for (const h of holes) {
      for (const i of near(h.x, h.y)) {
        const s = stones[i];
        if (s.role !== "area" && s.role !== "hex" && s.role !== "seam") continue;
        const dist = Math.hypot(h.x - s.x, h.y - s.y);
        if (dist - s.d / 2 > h.c + 0.08 || dist < 1e-6) continue;
        const want = h.c - SETTLE_HOLE_MM / 2 + 0.01;
        const ux = (h.x - s.x) / dist, uy = (h.y - s.y) / dist;
        let lo = 0, hi = want;
        if (!fits(i, s.x + ux * 0.005, s.y + uy * 0.005)) continue;
        for (let it = 0; it < 8; it++) {
          const mid = (lo + hi) / 2;
          if (fits(i, s.x + ux * mid, s.y + uy * mid)) lo = mid; else hi = mid;
        }
        if (lo < 0.005) continue;
        const k0 = key(s.x, s.y);
        s.x += ux * lo; s.y += uy * lo;
        const k1 = key(s.x, s.y);
        if (k0 !== k1) {
          index.set(k0, index.get(k0).filter((j) => j !== i));
          if (!index.has(k1)) index.set(k1, []);
          index.get(k1).push(i);
        }
        moved++;
      }
    }
    moves += moved;
    if (!moved) break;
  }
  return moves;
}

// Holes (step 5c, check 4): the empty circles of HOLE_LIMIT_MM or more inside the subject (local
// maxima of the clearance to every stone edge and the subject's edge on the map grid), largest
// first. The area and seam stones whose edge lies within MOVE_REACH_MM of a hole are moved, every
// other stone within reach holding still (lines, outline, brows, features never move), by a few
// rounds of small steps (position-based: a step, then every pair closer than MIN_GAP_MM pushed apart,
// a stone that would leave the subject or enter a face region held back), each stone at most
// MAX_MOVE_MM from where it was:
//
//   close: the stones on the hole's rim step towards its centre until it is below HOLE_LIMIT_MM;
//   open:  an SS4 stone is set at the hole's centre and the stones around it pushed out until it
//          keeps MIN_GAP_MM; it then takes its neighbours' colour (insert).
//
// A try is kept only if every gap is at least MIN_GAP_MM, the hole is gone and the window around it
// (HOLE_WINDOW_MM) holds fewer circles of HOLE_LIMIT_MM or more than before (so moving stones never
// just shifts a hole elsewhere); else every stone goes back. HOLE_ROUNDS passes. -> { targeted,
// closed, opened, left }.
export const HOLE_LIMIT_MM = 1.4;
export const HOLE_ROUNDS = 3;
export const MOVE_REACH_MM = 2.6;
export const MAX_MOVE_MM = 0.6;
export const HOLE_WINDOW_MM = 4;
const MOVABLE = new Set(["area", "hex", "seam"]);

function closeHoles(map, stones, insert) {
  const { grid, subject, subjectDist, regions } = map;
  const limit = HOLE_LIMIT_MM / 2;
  const out = { targeted: 0, closed: 0, opened: 0, left: 0 };
  const sd = (x, y) => { const k = grid.at(x, y); return k >= 0 && subject[k] ? subjectDist[k] : -1; };
  for (let round = 0; round < HOLE_ROUNDS; round++) {
    const cell = 5;
    let index = new Map();
    const reindex = () => {
      index = new Map();
      stones.forEach((st, i) => { const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`; if (!index.has(k)) index.set(k, []); index.get(k).push(i); });
    };
    reindex();
    const near = (x, y, reach) => {
      const r = Math.ceil(reach / cell) + 1, gx = Math.floor(x / cell), gy = Math.floor(y / cell), list = [];
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (const i of index.get(`${gx + a},${gy + b}`) || []) {
        if (Math.hypot(stones[i].x - x, stones[i].y - y) <= reach) list.push(i);
      }
      return list;
    };
    // The largest clearance within radius R of (x, y) (0.1 mm steps), against the given stones.
    const windowMax = (x, y, R, list, extra = null) => {
      let best = 0;
      for (let dy = -R; dy <= R; dy += 0.1) {
        for (let dx = -R; dx <= R; dx += 0.1) {
          if (dx * dx + dy * dy > R * R) continue;
          const px = x + dx, py = y + dy;
          let c = sd(px, py);
          if (c <= best) continue;
          for (const i of list) { const st = stones[i]; c = Math.min(c, Math.hypot(st.x - px, st.y - py) - st.d / 2); if (c <= best) break; }
          if (extra && c > best) c = Math.min(c, Math.hypot(extra.x - px, extra.y - py) - extra.d / 2);
          if (c > best) best = c;
        }
      }
      return best;
    };
    // The circles of `limit` or more within radius R (local maxima of the clearance, 0.1 mm grid).
    const windowHoles = (x, y, R, list, extra = null) => {
      const n = Math.round(R / 0.1), side = 2 * n + 1, val = new Float32Array(side * side).fill(-1);
      for (let b = 0; b < side; b++) {
        for (let a = 0; a < side; a++) {
          const dx = (a - n) * 0.1, dy = (b - n) * 0.1;
          if (dx * dx + dy * dy > R * R) continue;
          const px = x + dx, py = y + dy;
          let c = sd(px, py);
          for (const i of list) { const st = stones[i]; c = Math.min(c, Math.hypot(st.x - px, st.y - py) - st.d / 2); if (c < limit) break; }
          if (extra && c >= limit) c = Math.min(c, Math.hypot(extra.x - px, extra.y - py) - extra.d / 2);
          val[b * side + a] = c;
        }
      }
      let count = 0;
      for (let b = 1; b < side - 1; b++) {
        for (let a = 1; a < side - 1; a++) {
          const k = b * side + a, v = val[k];
          if (v < limit) continue;
          let top = true;
          for (const [m, before] of [[k - side - 1, 1], [k - side, 1], [k - side + 1, 1], [k - 1, 1], [k + 1, 0], [k + side - 1, 0], [k + side, 0], [k + side + 1, 0]]) {
            if (before ? val[m] >= v : val[m] > v) { top = false; break; }
          }
          if (top) count++;
        }
      }
      return count;
    };
    const holes = holeCentres(map, stones, limit);
    if (!holes.length) break;
    for (const h of holes) {
      const list = near(h.x, h.y, h.c + HOLE_WINDOW_MM + 5);
      const c0 = windowMax(h.x, h.y, 0.4, list);
      if (c0 < limit) continue;
      out.targeted++;
      const before = windowHoles(h.x, h.y, HOLE_WINDOW_MM, list);
      let done = null;
      for (const mode of ["close", "open"]) {
        if (tryMove(mode)) { done = mode; break; }
      }
      if (done === "close") out.closed++;
      else if (done === "open") out.opened++;
      if (done) reindex();
      function tryMove(mode) {
        const movable = list.filter((i) => MOVABLE.has(stones[i].role) && Math.hypot(stones[i].x - h.x, stones[i].y - h.y) - stones[i].d / 2 <= h.c + MOVE_REACH_MM);
        if (!movable.length) return false;
        const isMovable = new Set(movable);
        const start = movable.map((i) => [stones[i].x, stones[i].y]);
        const restore = () => movable.forEach((i, q) => { stones[i].x = start[q][0]; stones[i].y = start[q][1]; });
        const ss4 = mode === "open" ? { x: h.x, y: h.y, d: SS4_MM } : null;
        const allowed = (i, x, y) => {
          const q = movable.indexOf(i);
          return sd(x, y) >= stones[i].d / 2 - 0.05 && !inAnyRegion(regions, x, y) && Math.hypot(x - start[q][0], y - start[q][1]) <= MAX_MOVE_MM;
        };
        const gapOk = () => {
          for (const i of movable) {
            const a = stones[i];
            for (const j of list) {
              if (j === i) continue;
              const b = stones[j];
              if (Math.hypot(a.x - b.x, a.y - b.y) - (a.d + b.d) / 2 < MIN_GAP_MM - 1e-9) return false;
            }
            if (ss4 && Math.hypot(a.x - ss4.x, a.y - ss4.y) - (a.d + ss4.d) / 2 < MIN_GAP_MM - 1e-9) return false;
          }
          if (ss4) for (const j of list) {
            if (isMovable.has(j)) continue;
            const b = stones[j];
            if (Math.hypot(b.x - ss4.x, b.y - ss4.y) - (b.d + ss4.d) / 2 < MIN_GAP_MM - 1e-9) return false;
          }
          return true;
        };
        if (ss4 && sd(ss4.x, ss4.y) < ss4.d / 2 - 0.05) return false;
        for (let it = 0; it < 40; it++) {
          if (mode === "close") {
            for (const i of movable) {
              const st = stones[i], dd = Math.hypot(h.x - st.x, h.y - st.y);
              if (dd < 1e-6 || dd - st.d / 2 > h.c + 0.25) continue;
              const want = Math.min(0.04, dd - st.d / 2 - (limit - 0.08));
              if (want <= 0) continue;
              const nx = st.x + ((h.x - st.x) / dd) * want, ny = st.y + ((h.y - st.y) / dd) * want;
              if (allowed(i, nx, ny)) { st.x = nx; st.y = ny; }
            }
          }
          for (let pass = 0; pass < 6; pass++) {
            let moved = false;
            for (const i of movable) {
              const a = stones[i];
              for (const j of ss4 ? [...list, -1] : list) {
                if (j === i) continue;
                const b = j < 0 ? ss4 : stones[j];
                const dx = a.x - b.x, dy = a.y - b.y, dd = Math.hypot(dx, dy);
                const gap = dd - (a.d + b.d) / 2;
                if (gap >= MIN_GAP_MM + 1e-4 || dd < 1e-9) continue;
                const push = MIN_GAP_MM + 2e-4 - gap;
                const share = j >= 0 && isMovable.has(j) ? 0.5 : 1;
                const nx = a.x + (dx / dd) * push * share, ny = a.y + (dy / dd) * push * share;
                if (allowed(i, nx, ny)) { a.x = nx; a.y = ny; moved = true; }
              }
            }
            if (!moved) break;
          }
          if (gapOk() && (ss4 || windowMax(h.x, h.y, 0.4, list) < limit)) break;
        }
        if (gapOk() && windowMax(h.x, h.y, 0.4, list, ss4) < limit && windowHoles(h.x, h.y, HOLE_WINDOW_MM, list, ss4) < before) {
          if (ss4) insert(ss4);
          return true;
        }
        restore();
        return false;
      }
    }
  }
  out.left = holeCentres(map, stones, limit).length;
  return out;
}

// The centres of the empty circles of clearance `limit` or more (local maxima on the map grid),
// largest first: [{ x, y, c }].
function holeCentres(map, stones, limit) {
  const { grid, subject, subjectDist } = map;
  const cap = 2;
  const clear = new Float32Array(grid.n).fill(cap);
  for (const st of stones) {
    const r = st.d / 2, { i0, i1, j0, j1 } = grid.span(st.x, st.y, r + cap);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * grid.w + i;
        const c = Math.hypot(grid.cx(k) - st.x, grid.cy(k) - st.y) - r;
        if (c < clear[k]) clear[k] = c;
      }
    }
  }
  const val = (k) => (subject[k] ? Math.min(clear[k], subjectDist[k]) : -1);
  const out = [];
  for (let k = 0; k < grid.n; k++) {
    const v = val(k);
    if (v < limit) continue;
    const i = k % grid.w;
    let top = true;
    for (const [m, before] of [[k - grid.w - 1, 1], [k - grid.w, 1], [k - grid.w + 1, 1], [k - 1, 1], [k + 1, 0], [k + grid.w - 1, 0], [k + grid.w, 0], [k + grid.w + 1, 0]]) {
      if (m < 0 || m >= grid.n || Math.abs((m % grid.w) - i) > 1) continue;
      const w = val(m);
      if (before ? w >= v : w > v) { top = false; break; }
    }
    if (top) out.push({ x: grid.cx(k), y: grid.cy(k), c: v });
  }
  return out.sort((a, b) => b.c - a.c);
}

// Neighbour lists (rim gap below PATCH_GAP_MM) of the stones at the given indices.
export function neighbourLists(stones, indices, maxGap = PATCH_GAP_MM) {
  const cell = 5;
  const grid = new Map();
  for (const i of indices) {
    const k = `${Math.floor(stones[i].x / cell)},${Math.floor(stones[i].y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const nb = new Map(indices.map((i) => [i, []]));
  for (const i of indices) {
    const s = stones[i], gx = Math.floor(s.x / cell), gy = Math.floor(s.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) || []) {
        if (j <= i) continue;
        const o = stones[j];
        if (Math.hypot(s.x - o.x, s.y - o.y) - (s.d + o.d) / 2 < maxGap) { nb.get(i).push(j); nb.get(j).push(i); }
      }
    }
  }
  return nb;
}

function joinPatches(stones, areas) {
  const idx = [];
  stones.forEach((s, i) => {
    if ((s.role === "area" || s.role === "hex" || s.role === "seam") && s.area != null && areas[s.area].kind !== "halftone") idx.push(i);
  });
  const nb = neighbourLists(stones, idx);
  let recoloured = 0;
  for (let round = 0; round < 6; round++) {
    let changed = false;
    const seen = new Set();
    for (const start of idx) {
      if (seen.has(start)) continue;
      const s0 = stones[start];
      const patch = [start];
      seen.add(start);
      for (let q = 0; q < patch.length; q++) {
        for (const o of nb.get(patch[q])) {
          if (!seen.has(o) && stones[o].area === s0.area && stones[o].color === s0.color) { seen.add(o); patch.push(o); }
        }
      }
      if (patch.length >= MIN_PATCH) continue;
      const inPatch = new Set(patch), around = new Map();
      for (const p of patch) for (const o of nb.get(p)) {
        if (inPatch.has(o) || stones[o].area !== s0.area) continue;
        around.set(stones[o].color, (around.get(stones[o].color) || 0) + 1);
      }
      let best = null, n = 0;
      for (const [c, v] of around) if (v > n || (v === n && c < best)) { best = c; n = v; }
      if (!best || best === s0.color) continue;
      for (const p of patch) stones[p].color = best;
      recoloured += patch.length;
      changed = true;
    }
    if (!changed) break;
  }
  return recoloured;
}

// The honeycomb of area id: a hexagonal lattice of pitch HEX_PITCH_MM whose rows run along the area's
// main direction (the principal axis of its free cells), centred on their centroid. points(fi, fj):
// the lattice points (phase fi, fj of a step) on free cells of the area deep enough to lie inside the
// band (bandRows rows); index(x, y, fi, fj): the lattice index of the point nearest (x, y).
function honeycomb(grid, pack, depth, id, box, bandRows) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  const i0 = Math.max(0, Math.floor((box.minXmm - grid.x0) * grid.ppmm)), i1 = Math.min(grid.w - 1, Math.ceil((box.maxXmm - grid.x0) * grid.ppmm));
  const j0 = Math.max(0, Math.floor((box.minYmm - grid.y0) * grid.ppmm)), j1 = Math.min(grid.h - 1, Math.ceil((box.maxYmm - grid.y0) * grid.ppmm));
  for (let j = j0; j <= j1; j += 2) {
    for (let i = i0; i <= i1; i += 2) {
      const k = j * grid.w + i;
      if (pack[k] !== id || depth[k] <= 0) continue;
      const x = grid.cx(k), y = grid.cy(k);
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
  }
  const cx = n ? sx / n : (box.minXmm + box.maxXmm) / 2, cy = n ? sy / n : (box.minYmm + box.maxYmm) / 2;
  const vxx = n ? sxx / n - cx * cx : 1, vyy = n ? syy / n - cy * cy : 0, vxy = n ? sxy / n - cx * cy : 0;
  const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  const P = HEX_PITCH_MM;
  const e1 = [P * Math.cos(theta), P * Math.sin(theta)], e2 = [P * Math.cos(theta + Math.PI / 3), P * Math.sin(theta + Math.PI / 3)];
  const det = e1[0] * e2[1] - e1[1] * e2[0];
  const toLattice = (x, y) => [((x - cx) * e2[1] - (y - cy) * e2[0]) / det, ((y - cy) * e1[0] - (x - cx) * e1[1]) / det];
  const minDepth = (bandRows - 1) * RING_STEP_MM + 0.9 * P - 0.25;
  return {
    theta,
    index(x, y, fi, fj) {
      const [a, b] = toLattice(x, y);
      return [Math.round(a - fi), Math.round(b - fj)];
    },
    points(fi, fj) {
      const corners = [[box.minXmm, box.minYmm], [box.maxXmm, box.minYmm], [box.minXmm, box.maxYmm], [box.maxXmm, box.maxYmm]].map(([x, y]) => toLattice(x, y));
      const a0 = Math.floor(Math.min(...corners.map((c) => c[0]))) - 1, a1 = Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1;
      const b0 = Math.floor(Math.min(...corners.map((c) => c[1]))) - 1, b1 = Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1;
      const out = [];
      for (let b = b0; b <= b1; b++) {
        for (let a = a0; a <= a1; a++) {
          const x = cx + (a + fi) * e1[0] + (b + fj) * e2[0], y = cy + (a + fi) * e1[1] + (b + fj) * e2[1];
          const k = grid.at(x, y);
          if (k < 0 || pack[k] !== id || depth[k] < minDepth) continue;
          out.push({ xMm: x, yMm: y, i: a, j: b });
        }
      }
      return out;
    }
  };
}
