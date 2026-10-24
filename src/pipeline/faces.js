import { getStoneSize } from "../stones/StoneSizes.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { BW_DARK, BW_LIGHT, lightness } from "./bw.js";
import { deltaE2000, snapColour, srgbToLab } from "./holes.js";
import { MIN_GAP_MM } from "./tiers.js";

// Face features (experiment exp-faces, docs/exp-faces.md; tools only, the app does not call it).
// From a face's landmarks (MediaPipe Face Mesh V2, 478 points with the irises, in the layout's mm)
// it finds the regions of each eye (opening, iris, pupil, upper lid), the lips (upper, lower, the
// line between) and, when the mouth is open, the opening and the teeth in it; then, inside each
// region, it replaces the stones with designed ones. One module for the three styles: "colour",
// "stencil" (black & white, solid areas) and "halftone" (black & white, mixes).
//
//   eyes  E1  the AI's own stones kept, cleaned: in the iris every stone takes the iris colour (a
//             Crystal catch-light at the upper right kept), in the eye white the white colour (dark
//             lash stones at the upper lid kept), and the pupil stone moved to the iris centre.
//             The colours are the AI's: the majority of its stone discs (report.discsAtMm) there
//             (in the white, of its light discs, L* 60 or more; Crystal if there are none).
//         E2  designed: an SS16 Jet pupil at the iris centre, a ring of iris stones around it (the
//             photo's iris colour in colour, Jet in black & white), an SS4 Crystal catch-light at
//             MIN_GAP_MM from the pupil at the upper right, Crystal eye white, and a lid line of
//             SS4 Jet stones along the upper lid.
//         E3  E2 with the pupil a cluster of SS6 Jet stones and the catch-light an SS4 Crystal
//             stone in the cluster's upper right place.
//         In stencil style a band of EYE_BAND_MM around every eye is Crystal (finishFaceFeatures),
//         so a row of Crystal separates the eye from dark shadows and eyebrows.
//   lips  L1  one tone: colour the photo's lip colour; stencil and halftone solid Jet.
//         L2  two tones: colour the upper lip darker than the lower, an SS4 line of a dark lip
//             colour between them; stencil Crystal lips with an SS4 Jet outline and line between;
//             halftone a regular Jet / Crystal mix (upper 2/3 Jet, lower 1/3) and a Jet line.
//   teeth T1  the light part of the open mouth Crystal, the rest the dark of the mouth.
//         T2  T1 and, when upper and lower teeth both show (two light runs with a dark gap between
//             them, column by column: teethRows), an SS4 line along that gap (Silver in colour, Jet
//             in black & white).
//
// Designed stones keep MIN_GAP_MM to every stone. A fixed stone (pupil, catch-light, iris ring,
// lines) removes an outside stone it would come closer to; the packed ones (eye white, lips, teeth)
// only use the free space: SS6 on a hexagonal lattice, then SS6 and SS4 wherever they still fit,
// the free spot farthest from every stone first. The caller then runs the hole fill and the gap
// check as for any design (cleanup.js), and finishFaceFeatures for the stencil eye band.

export const FACE_STYLES = Object.freeze(["colour", "stencil", "halftone"]);
export const EYE_VARIANTS = Object.freeze(["E1", "E2", "E3"]);
export const LIP_VARIANTS = Object.freeze(["L1", "L2"]);
export const TEETH_VARIANTS = Object.freeze(["T1", "T2"]);

// Face Mesh V2 indices. Each eye's opening contour (corner, lower lid, corner, upper lid), its upper
// lid from corner to corner, its iris centre and rim; the lips' outer and inner chains from the
// left corner to the right one.
export const MESH = Object.freeze({
  eyes: [
    { contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], upper: [33, 246, 161, 160, 159, 158, 157, 173, 133], iris: 468, rim: [469, 470, 471, 472] },
    { contour: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398], upper: [362, 398, 384, 385, 386, 387, 388, 466, 263], iris: 473, rim: [474, 475, 476, 477] }
  ],
  upperOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  lowerOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  upperInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  lowerInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
});

const SS4 = getStoneSize("ss4").diameterMm;
const SS6 = getStoneSize("ss6").diameterMm;
const SS16 = getStoneSize("ss16").diameterMm;
const GAP = MIN_GAP_MM;
const EPS = 1e-6;
const CRYSTAL = BW_LIGHT;
const JET = BW_DARK;
const SILVER = "silver";
// An eye narrower than this (corner to corner) is left as it is: an SS16 pupil would not fit.
export const MIN_EYE_WIDTH_MM = 6;
// Stones within this distance outside an eye's opening belong to the eye (the lids).
export const LID_MARGIN_MM = 1.0;
// Stencil: the band around the eye that is made Crystal (beyond the lid margin: about one row).
export const EYE_BAND_MM = LID_MARGIN_MM + 2.1;
// A mouth is open when its inner lips are this far apart at the centre (and the share of the mouth
// width below).
export const OPEN_MOUTH_MM = 1.0;
export const OPEN_MOUTH_SHARE = 0.08;
// Teeth: AI pixels at least this light (CIE L* on white); teeth show when they cover TEETH_SHARE of
// the opening.
export const TEETH_L = 62;
export const TEETH_SHARE = 0.15;
// Both rows show when at least this share of the columns with teeth (and three) have two rows.
export const TEETH_ROW_SHARE = 0.3;
// Lips L2 in colour: the upper lip at least this many L* darker than the lower; the line this many
// L* darker than the upper lip, in the same hue.
export const LIP_STEP_L = 6;
export const LIP_LINE_STEP_L = 15;
// The AI's pupil (the service's report.pupilsAtMm) within this many iris radii (at least
// PUPIL_SNAP_MIN_MM) of a landmark iris centre is taken as the eye's centre: the landmarks of a
// stone drawing can be off by a few mm, the service's pupils are where the AI drew them.
export const PUPIL_SNAP = 1.5;
export const PUPIL_SNAP_MIN_MM = 1.5;

// --- Geometry ---------------------------------------------------------------------------------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function insidePolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// Distance from p to a polyline (closed: back to its first point).
export function polylineDistance(p, line, closed = false) {
  let best = Infinity;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, segmentDistance(p, line[i], line[(i + 1) % line.length]));
  return best;
}

// Distance from p to the polygon's area: 0 inside.
const outsideDistance = (p, poly) => (insidePolygon(p, poly) ? 0 : polylineDistance(p, poly, true));

// Points along a polyline every `step` mm, from `start` mm on.
function along(line, step, start = step / 2) {
  const out = [];
  let carried = start;
  for (let i = 0; i < line.length - 1; i++) {
    const len = dist(line[i], line[i + 1]);
    let t = carried;
    while (t <= len + EPS) {
      const f = len ? t / len : 0;
      out.push([line[i][0] + f * (line[i + 1][0] - line[i][0]), line[i][1] + f * (line[i + 1][1] - line[i][1])]);
      t += step;
    }
    carried = t - len;
  }
  return out;
}

const lineLength = (line) => line.slice(1).reduce((s, p, i) => s + dist(line[i], p), 0);

// A polyline moved by `by` mm along its normal, to the side away from `from`.
function offsetAway(line, by, from) {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if ((p[0] - from[0]) * nx + (p[1] - from[1]) * ny < 0) { nx = -nx; ny = -ny; }
    return [p[0] + by * nx, p[1] + by * ny];
  });
}

const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

// --- Regions ----------------------------------------------------------------------------------

// 478 landmarks [x, y] (layout mm) -> the face's regions:
// { eyeDistanceMm, eyes: [{ opening, upper, iris: { c, r }, widthMm, heightMm }],
//   lips: { upper, lower, outer, line, open, opening, gapMm, widthMm } }.
// opening, upper, lower, outer: polygons; upper (eye) and line: polylines.
export function faceRegions(points) {
  const at = (ids) => ids.map((i) => points[i]);
  const eyes = MESH.eyes.map((e) => {
    const opening = at(e.contour);
    const c = points[e.iris];
    const r = e.rim.reduce((s, i) => s + dist(points[i], c), 0) / e.rim.length;
    return {
      opening,
      upper: at(e.upper),
      iris: { c, r },
      widthMm: dist(opening[0], opening[8]),
      heightMm: dist(points[e.contour[4]], points[e.contour[12]])
    };
  });
  const upperOuter = at(MESH.upperOuter), lowerOuter = at(MESH.lowerOuter);
  const upperInner = at(MESH.upperInner), lowerInner = at(MESH.lowerInner);
  const widthMm = dist(upperOuter[0], upperOuter[upperOuter.length - 1]);
  const gapMm = dist(points[13], points[14]);
  const open = gapMm >= Math.max(OPEN_MOUTH_MM, OPEN_MOUTH_SHARE * widthMm);
  return {
    eyeDistanceMm: dist(points[468], points[473]),
    eyes,
    lips: {
      upper: [...upperOuter, ...upperInner.slice().reverse()],
      lower: [...lowerOuter, ...lowerInner.slice().reverse()],
      outer: [...upperOuter, ...lowerOuter.slice(1, -1).reverse()],
      line: upperInner.map((p, i) => [(p[0] + lowerInner[i][0]) / 2, (p[1] + lowerInner[i][1]) / 2]),
      open,
      opening: open ? [...upperInner, ...lowerInner.slice(1, -1).reverse()] : null,
      gapMm,
      widthMm
    }
  };
}

// --- Stones -----------------------------------------------------------------------------------

// A spatial index of stones for gap queries; removed stones are skipped.
function stoneIndex(stones) {
  const cell = 3;
  const grid = new Map();
  const key = (gx, gy) => `${gx},${gy}`;
  const add = (i) => {
    const k = key(Math.floor(stones[i].x / cell), Math.floor(stones[i].y / cell));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  };
  stones.forEach((_, i) => add(i));
  const near = (x, y, reach) => {
    const out = [];
    const r = Math.ceil(reach / cell);
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      for (const i of grid.get(key(gx + a, gy + b)) || []) if (!stones[i].removed) out.push(i);
    }
    return out;
  };
  return {
    push(stone) { stones.push(stone); add(stones.length - 1); return stones.length - 1; },
    // The smallest rim gap of a stone of diameter d at (x, y) to the stones (Infinity if none near).
    minGap(x, y, d) {
      let m = Infinity;
      for (const i of near(x, y, d / 2 + 6)) m = Math.min(m, Math.hypot(stones[i].x - x, stones[i].y - y) - (stones[i].d + d) / 2);
      return m;
    },
    conflicts(x, y, d) {
      return near(x, y, d / 2 + 6).filter((i) => Math.hypot(stones[i].x - x, stones[i].y - y) - (stones[i].d + d) / 2 < GAP - EPS);
    }
  };
}

// A working copy: { stones (with .removed and .designed marks), index, removeWhere, fixed, pack }.
function workspace(input) {
  const stones = input.map((s) => ({ x: s.x, y: s.y, d: s.d, color: s.color }));
  const index = stoneIndex(stones);
  return {
    stones,
    removeWhere(test, which = () => true) {
      let n = 0;
      for (const s of stones) if (!s.removed && !s.designed && test([s.x, s.y]) && which(s)) { s.removed = true; n++; }
      return n;
    },
    // A fixed designed stone: placed where asked, any undesigned stone it would touch removed. A
    // designed stone in the way keeps it out (returns false).
    fixed(x, y, d, color) {
      const hit = index.conflicts(x, y, d);
      if (hit.some((i) => stones[i].designed)) return false;
      for (const i of hit) stones[i].removed = true;
      index.push({ x, y, d, color, designed: true });
      return true;
    },
    // Packs a region (inside(p) true) with designed stones coloured by colourAt([x, y]): SS6 on a
    // hexagonal lattice through `origin`, then SS6 and SS4 wherever they fit, the free spot
    // farthest from every stone first (candidates every 0.1 mm). Returns the number placed.
    pack(inside, colourAt, box, origin) {
      let n = 0;
      const pitch = SS6 + GAP, rowH = pitch * Math.sqrt(3) / 2;
      const [ox, oy] = origin;
      const j0 = Math.floor((box.y0 - oy) / rowH) - 1, j1 = Math.ceil((box.y1 - oy) / rowH) + 1;
      for (let j = j0; j <= j1; j++) {
        const shift = (j & 1) * pitch / 2;
        const i0 = Math.floor((box.x0 - ox - shift) / pitch) - 1, i1 = Math.ceil((box.x1 - ox - shift) / pitch) + 1;
        for (let i = i0; i <= i1; i++) {
          const p = [ox + shift + i * pitch, oy + j * rowH];
          if (!inside(p) || index.minGap(p[0], p[1], SS6) < GAP - EPS) continue;
          index.push({ x: p[0], y: p[1], d: SS6, color: colourAt(p), designed: true });
          n++;
        }
      }
      const step = 0.1;
      const cands = [];
      for (let y = box.y0; y <= box.y1; y += step) for (let x = box.x0; x <= box.x1; x += step) if (inside([x, y])) cands.push([x, y]);
      for (const d of [SS6, SS4]) {
        const clear = cands.map(([x, y]) => index.minGap(x, y, 0) - GAP);
        for (;;) {
          let best = -1, bv = -Infinity;
          for (let k = 0; k < cands.length; k++) if (clear[k] > bv) { bv = clear[k]; best = k; }
          if (best < 0 || bv < d / 2 - EPS) break;
          const [x, y] = cands[best];
          index.push({ x, y, d, color: colourAt([x, y]), designed: true });
          n++;
          for (let k = 0; k < cands.length; k++) {
            const g = Math.hypot(cands[k][0] - x, cands[k][1] - y) - d / 2 - GAP;
            if (g < clear[k]) clear[k] = g;
          }
        }
      }
      return n;
    }
  };
}

const boxOf = (poly, margin = 0) => ({
  x0: Math.min(...poly.map((p) => p[0])) - margin, x1: Math.max(...poly.map((p) => p[0])) + margin,
  y0: Math.min(...poly.map((p) => p[1])) - margin, y1: Math.max(...poly.map((p) => p[1])) + margin
});

// --- Colours ----------------------------------------------------------------------------------

const labOfId = (id) => {
  const h = STONE_COLORS[id].fill.replace("#", "");
  return srgbToLab(...[0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
};
const bw = (L, threshold = 55) => (L < threshold ? JET : CRYSTAL);
const mean = (labs) => (labs.length ? [0, 1, 2].map((k) => labs.reduce((s, v) => s + v[k], 0) / labs.length) : null);
const median = (labs) => (labs.length ? [0, 1, 2].map((k) => labs.map((v) => v[k]).sort((a, b) => a - b)[Math.floor(labs.length / 2)]) : null);
const lightOf = (id) => lightness(STONE_COLORS[id].fill);
const midTone = (id) => lightOf(id) >= 15 && lightOf(id) <= 75;

function majority(ids) {
  const count = new Map();
  for (const id of ids) count.set(id, (count.get(id) || 0) + 1);
  let best = null, n = 0;
  for (const [id, c] of count) if (c > n) { best = id; n = c; }
  return best;
}

// The catalogue colour at least `step` L* darker than a Lab colour, nearest (ΔE2000) to it made
// `step` darker: the darker tone of the same hue the catalogue has. A coloured source (chroma above
// 15) takes no near-neutral colour (chroma below 10); when the catalogue has no coloured stone that
// much darker, the step shrinks (to 4 L* at least) before a neutral one is taken.
function darker(lab, step) {
  const coloured = Math.hypot(lab[1], lab[2]) > 15;
  const pick = (k, neutralOk) => {
    const target = [Math.max(8, lab[0] - k), lab[1], lab[2]];
    let best = null, bd = Infinity;
    for (const id of Object.keys(STONE_COLORS)) {
      const c = labOfId(id);
      if (c[0] > lab[0] - k || (!neutralOk && Math.hypot(c[1], c[2]) < 10)) continue;
      const d = deltaE2000(target, c);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  if (coloured) for (let k = step; k >= 4; k -= 2) { const id = pick(k, false); if (id) return id; }
  return pick(step, true) ?? JET;
}

// Lab samples of a reader over the points of a region (every 0.4 mm).
function sampleRegion(read, inside, box) {
  if (!read) return [];
  const out = [];
  for (let y = box.y0; y <= box.y1; y += 0.4) for (let x = box.x0; x <= box.x1; x += 0.4) {
    if (!inside([x, y])) continue;
    const lab = read(x, y);
    if (lab) out.push(lab);
  }
  return out;
}

// --- Features ---------------------------------------------------------------------------------

// The colour of the AI's stone discs in a zone (majority), or null: each disc read as a stone.
// keep: which colours may be the zone's colour (the eye white: light ones only).
function discColour(discs, inside, readStone, keep = () => true) {
  const ids = discs.filter(([x, y]) => inside([x, y])).map(([x, y, d]) => readStone(x, y, d)).filter(Boolean);
  return { colour: majority(ids.filter(keep)), discs: ids.length, colours: [...new Set(ids)] };
}

// The eye moved to where the AI drew its pupil (PUPIL_SNAP): { eye, snapMm } (snapMm null if not).
function snapEye(eye, pupils = []) {
  const reach = Math.max(PUPIL_SNAP_MIN_MM, PUPIL_SNAP * eye.iris.r);
  const near = pupils.map((p) => [p, dist(p, eye.iris.c)]).filter(([, d]) => d <= reach).sort((a, b) => a[1] - b[1])[0];
  if (!near) return { eye, snapMm: null };
  const [dx, dy] = [near[0][0] - eye.iris.c[0], near[0][1] - eye.iris.c[1]];
  const move = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
  return { eye: { ...eye, opening: move(eye.opening), upper: move(eye.upper), iris: { c: [...near[0]], r: eye.iris.r } }, snapMm: near[1] };
}

function designEye(ws, landmarkEye, variant, style, ctx) {
  const { eye, snapMm } = snapEye(landmarkEye, ctx.pupils);
  const { opening, iris } = eye;
  const info = { widthMm: round(eye.widthMm), heightMm: round(eye.heightMm), irisRMm: round(iris.r), pupilSnapMm: snapMm == null ? null : round(snapMm) };
  if (eye.widthMm < MIN_EYE_WIDTH_MM) return { ...info, skipped: "eye too small" };
  const inEye = (p) => outsideDistance(p, opening) <= LID_MARGIN_MM;
  const inIris = (p) => dist(p, iris.c) <= iris.r && insidePolygon(p, opening);
  const ai = {
    iris: discColour(ctx.discs, inIris, ctx.readStone, midTone),
    white: discColour(ctx.discs, (p) => insidePolygon(p, opening) && dist(p, iris.c) > iris.r, ctx.readStone, (id) => lightness(STONE_COLORS[id].fill) >= 60),
    lid: discColour(ctx.discs, (p) => !insidePolygon(p, opening) && inEye(p), ctx.readStone)
  };
  info.ai = { iris: ai.iris, white: ai.white, lid: ai.lid };
  // The iris colour: the photo's; without a photo the AI's mid-tone iris discs (L* 15 to 75, not
  // the pupil or the catch-light), else the AI's mean colour in the iris ring.
  const ringZone = (p) => { const r = dist(p, iris.c); return r >= 0.55 * iris.r && r <= 0.95 * iris.r && insidePolygon(p, opening); };
  const aiRing = ctx.aiLabMean ? ctx.aiLabMean(ringZone, boxOf([[iris.c[0] - iris.r, iris.c[1] - iris.r], [iris.c[0] + iris.r, iris.c[1] + iris.r]])) : null;
  const irisColour = style === "colour" ? (ctx.irisColour(iris) ?? ai.iris.colour ?? (aiRing ? snapColour(aiRing) : "smoked-topaz")) : JET;
  const upRight = [Math.SQRT1_2, -Math.SQRT1_2];

  if (variant === "E1") {
    // The AI's stones, cleaned. The pupil: the largest dark stone (L* below 30) whose centre lies
    // in the iris, on equal size the one nearest the iris centre.
    const inside = ws.stones.map((s, i) => i).filter((i) => !ws.stones[i].removed && !ws.stones[i].designed && inEye([ws.stones[i].x, ws.stones[i].y]));
    const pupil = inside
      .filter((i) => inIris([ws.stones[i].x, ws.stones[i].y]) && lightness(STONE_COLORS[ws.stones[i].color].fill) < 30)
      .sort((a, b) => ws.stones[b].d - ws.stones[a].d || dist([ws.stones[a].x, ws.stones[a].y], iris.c) - dist([ws.stones[b].x, ws.stones[b].y], iris.c))[0];
    const whiteColour = style === "colour" ? (ai.white.colour ?? CRYSTAL) : CRYSTAL;
    const aiIris = style === "colour" ? (ai.iris.colour ?? irisColour) : JET;
    let recoloured = 0, moved = 0;
    const set = (s, c) => { if (s.color !== c) { s.color = c; recoloured++; } };
    // The iris as the AI drew it: the centre of its mid-tone discs around the pupil (at least four),
    // else the eye's centre.
    const ring = ctx.discs.filter(([x, y]) => { const r = dist([x, y], iris.c); return r > 0.45 * iris.r && r <= 1.1 * iris.r; })
      .filter(([x, y, d]) => { const id = ctx.readStone(x, y, d); return id && midTone(id); });
    const centre = ring.length >= 4 ? centroid(ring) : iris.c;
    if (pupil !== undefined) {
      const p = ws.stones[pupil];
      const shift = dist([p.x, p.y], centre);
      p.removed = true;
      if (ws.fixed(centre[0], centre[1], p.d, JET)) moved = round(shift);
      else p.removed = false;
    }
    let catchLight = false;
    for (const i of inside) {
      const s = ws.stones[i];
      if (s.removed || s.designed) continue;
      const p = [s.x, s.y];
      if (inIris(p)) {
        const ur = (s.x - iris.c[0]) * upRight[0] + (s.y - iris.c[1]) * upRight[1];
        if (s.color === CRYSTAL && !catchLight && ur > 0) { catchLight = true; continue; }
        set(s, aiIris);
      } else if (insidePolygon(p, opening)) {
        const lash = polylineDistance(p, eye.upper) <= 0.8 && lightness(STONE_COLORS[s.color].fill) < 40;
        if (!lash) set(s, whiteColour);
      }
    }
    return { ...info, variant, recoloured, pupilMovedMm: pupil === undefined ? null : moved, catchLight };
  }

  // E2 and E3: everything in the eye replaced, and the AI's large dark stones (its pupils) near it.
  const removed = ws.removeWhere(inEye) + ws.removeWhere((p) => dist(p, iris.c) <= 2 * iris.r + SS16, (s) => s.d > SS6 + EPS && lightOf(s.color) < 30);
  const [cx, cy] = iris.c;
  let pupilR;
  if (variant === "E2") {
    ws.fixed(cx, cy, SS16, JET);
    pupilR = SS16 / 2;
    ws.fixed(cx + upRight[0] * (pupilR + GAP + SS4 / 2), cy + upRight[1] * (pupilR + GAP + SS4 / 2), SS4, CRYSTAL);
  } else {
    // A cluster of SS6 Jet stones about the size of an SS16 stone (four in a square; seven in a
    // hexagon for an iris wide enough), its upper right place an SS4 Crystal catch-light.
    const p = SS6 + GAP;
    const spots = iris.r >= 2 * p
      ? [[0, 0], ...[0, 1, 2, 3, 4, 5].map((k) => [p * Math.cos(Math.PI / 3 * k + Math.PI / 6), p * Math.sin(Math.PI / 3 * k + Math.PI / 6)])]
      : [[-p / 2, -p / 2], [p / 2, -p / 2], [-p / 2, p / 2], [p / 2, p / 2]];
    const catchAt = spots.reduce((b, s) => (s[0] * upRight[0] + s[1] * upRight[1] > b[0] * upRight[0] + b[1] * upRight[1] ? s : b));
    for (const s of spots) {
      if (s === catchAt) ws.fixed(cx + s[0], cy + s[1], SS4, CRYSTAL);
      else ws.fixed(cx + s[0], cy + s[1], SS6, JET);
    }
    pupilR = Math.max(...spots.map((s) => Math.hypot(...s))) + SS6 / 2;
  }
  // The iris ring, where its stones fall inside the opening.
  const ringD = iris.r - pupilR >= SS6 + GAP ? SS6 : SS4;
  const ringR = pupilR + GAP + ringD / 2;
  const count = Math.floor((2 * Math.PI * ringR) / (ringD + GAP));
  let ring = 0;
  for (let k = 0; k < count; k++) {
    const a = (2 * Math.PI * k) / count;
    const p = [cx + ringR * Math.cos(a), cy + ringR * Math.sin(a)];
    if (insidePolygon(p, opening) && ws.fixed(p[0], p[1], ringD, irisColour)) ring++;
  }
  // The lid line: SS4 Jet along the upper lid, half a stone outside the opening.
  const lid = offsetAway(eye.upper, SS4 / 2, centroid(opening));
  let lidStones = 0;
  for (const p of along(lid, SS4 + GAP + 0.02)) if (ws.fixed(p[0], p[1], SS4, JET)) lidStones++;
  // The eye white: the rest of the opening, Crystal.
  const white = ws.pack((p) => insidePolygon(p, opening), () => CRYSTAL, boxOf(opening), iris.c);
  return { ...info, variant, removed, ring, ringSize: ringD === SS6 ? "ss6" : "ss4", lidStones, white, irisColour };
}

function designLips(ws, lips, variant, style, ctx) {
  const inLips = (p) => (insidePolygon(p, lips.upper) || insidePolygon(p, lips.lower) || polylineDistance(p, lips.outer, true) <= 0.3)
    && !(lips.opening && insidePolygon(p, lips.opening));
  const removed = ws.removeWhere(inLips);
  const box = boxOf(lips.outer, 0.3);
  const origin = centroid(lips.outer);
  const upperOf = (p) => insidePolygon(p, lips.upper) || (!insidePolygon(p, lips.lower) && p[1] < polylineY(lips.line, p[0]));
  const info = { variant, removed, open: lips.open };
  const photo = (inside) => mean(sampleRegion(ctx.photoLab, inside, box));
  const lineStones = (line, colour) => {
    let n = 0;
    for (const p of along(line, SS4 + GAP + 0.02)) if (ws.fixed(p[0], p[1], SS4, colour)) n++;
    return n;
  };
  if (style === "colour") {
    // The lip colours the AI drew: the majority of its stone discs (not the dark line, L* 20 or
    // more); without discs the photo's mean colour (in shadow it snaps to browns), else the AI's.
    const drawn = (inside) => majority(ctx.discs.filter(([x, y]) => inside([x, y])).map(([x, y, d]) => ctx.readStone(x, y, d)).filter((id) => id && lightOf(id) >= 20));
    const either = (p) => insidePolygon(p, lips.upper) || insidePolygon(p, lips.lower);
    const tone = (inside) => drawn(inside) ?? snapColour(photo(inside) ?? ctx.aiLabMean(inside, box) ?? [45, 40, 15]);
    if (variant === "L1") {
      const c = tone(either);
      return { ...info, colours: [c], packed: ws.pack(inLips, () => c, box, origin) };
    }
    const lower = tone((p) => insidePolygon(p, lips.lower));
    let upper = tone((p) => insidePolygon(p, lips.upper));
    if (labOfId(upper)[0] > labOfId(lower)[0] - LIP_STEP_L) upper = darker(labOfId(lower), LIP_STEP_L);
    const lineColour = darker(labOfId(upper), LIP_LINE_STEP_L);
    const line = lips.open ? 0 : lineStones(lips.line, lineColour);
    const packed = ws.pack(inLips, (p) => (upperOf(p) ? upper : lower), box, origin);
    return { ...info, colours: [upper, lower, lineColour], line, packed };
  }
  if (variant === "L1") return { ...info, colours: [JET], packed: ws.pack(inLips, () => JET, box, origin) };
  if (style === "stencil") {
    const outline = lineStones([...lips.outer, lips.outer[0]], JET);
    const line = lips.open ? lineStones(lips.opening ? [...lips.opening, lips.opening[0]] : lips.line, JET) : lineStones(lips.line, JET);
    return { ...info, colours: [CRYSTAL, JET], outline, line, packed: ws.pack(inLips, () => CRYSTAL, box, origin) };
  }
  // Halftone L2: a regular mix by lattice position (rows of SS6 pitch), upper 2/3 Jet, lower 1/3.
  const line = lips.open ? 0 : lineStones(lips.line, JET);
  const pitch = SS6 + GAP, rowH = pitch * Math.sqrt(3) / 2;
  const mix = (p) => {
    const j = Math.round((p[1] - origin[1]) / rowH);
    const i = Math.round((p[0] - origin[0]) / pitch - (j & 1) / 2);
    const k = (((i + 2 * j) % 3) + 3) % 3;
    return k < (upperOf(p) ? 2 : 1) ? JET : CRYSTAL;
  };
  return { ...info, colours: [JET, CRYSTAL], line, packed: ws.pack(inLips, mix, box, origin) };
}

// The y of a polyline (ordered left to right) at x, clamped to its ends.
function polylineY(line, x) {
  if (x <= line[0][0]) return line[0][1];
  for (let i = 0; i < line.length - 1; i++) {
    const [x1, y1] = line[i], [x2, y2] = line[i + 1];
    if (x <= x2) return x2 === x1 ? y1 : y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return line[line.length - 1][1];
}

// The teeth rows in the open mouth, column by column (every 0.3 mm across, 0.15 mm down): the light
// runs (AI L* at least TEETH_L) in each column. Both rows show where a column has two light runs
// with a dark gap between them; the line between them runs through the middles of those gaps.
// -> { share (light share of the opening), both, line (polyline, left to right) }.
function teethRows(opening, light) {
  const box = boxOf(opening);
  let n = 0, nLight = 0, lit = 0;
  const gaps = [];
  for (let x = box.x0; x <= box.x1; x += 0.3) {
    const runs = [];
    let run = null, prev = null, any = false;
    for (let y = box.y0; y <= box.y1; y += 0.15) {
      if (!insidePolygon([x, y], opening)) continue;
      const l = light([x, y]);
      n++; nLight += l; any ||= l;
      if (l && !run) run = { y0: y, y1: y };
      else if (l) run.y1 = y;
      else if (run) { runs.push(run); run = null; }
      prev = y;
    }
    if (run) runs.push(run);
    if (any) lit++;
    if (runs.length >= 2) {
      // The widest dark gap between consecutive runs.
      let best = null;
      for (let k = 0; k + 1 < runs.length; k++) {
        const g = runs[k + 1].y0 - runs[k].y1;
        if (!best || g > best.g) best = { g, y: (runs[k + 1].y0 + runs[k].y1) / 2 };
      }
      gaps.push([x, best.y]);
    }
    void prev;
  }
  return { share: n ? nLight / n : 0, both: lit > 0 && gaps.length >= TEETH_ROW_SHARE * lit && gaps.length >= 3, line: gaps };
}

function designTeeth(ws, lips, variant, style, ctx) {
  if (!lips.open) return { variant, skipped: "mouth closed" };
  const opening = lips.opening;
  const inside = (p) => insidePolygon(p, opening);
  const box = boxOf(opening);
  const light = (p) => ctx.aiLightness(p[0], p[1]) >= TEETH_L;
  const rows = teethRows(opening, light);
  const info = { variant, areaMm2: round(polygonArea(opening)), teethShare: round(rows.share) };
  if (rows.share < TEETH_SHARE) return { ...info, skipped: "no teeth visible" };
  const removed = ws.removeWhere(inside);
  const dark = style === "colour"
    ? snapColour(ctx.aiLabMean((p) => inside(p) && !light(p), box) ?? [20, 10, 5])
    : JET;
  let line = 0;
  if (variant === "T2" && rows.both) {
    const colour = style === "colour" ? SILVER : JET;
    for (const p of along(rows.line, SS4 + GAP + 0.02)) if (inside(p) && ws.fixed(p[0], p[1], SS4, colour)) line++;
  }
  const packed = ws.pack(inside, (p) => (light(p) ? CRYSTAL : dark), box, centroid(opening));
  return { ...info, removed, bothRows: rows.both, line, dark, packed };
}

// stones: plain { x, y, d, color } in the layout's mm (the delivered design in its style's
// colours). faces: landmark sets (478 [x, y], layout mm). options: { style, eyes, lips, teeth } (a
// variant name or null to leave that feature as it is) and the readers:
//   discs        report.discsAtMm, the AI's stone discs [x, y, d]
//   pupils       report.pupilsAtMm, where the AI drew the pupils (PUPIL_SNAP)
//   readStone    (x, y, d) -> the colour id the AI shows for a stone there (as the style reads it)
//   photoLab     (x, y) -> CIE Lab of the photo there (mapped into the layout's mm), or null
//   aiLabMean    (inside, box) -> mean CIE Lab of the AI pixels in a region, or null
//   aiLightness  (x, y) -> CIE L* of the AI image on white there
// -> { stones (plain, designed ones marked), faces: per face { regions summary, eyes, lips, teeth } }.
export function designFaceFeatures(stones, faces, { style, eyes = null, lips = null, teeth = null, ...ctx }) {
  if (!FACE_STYLES.includes(style)) throw new RangeError(`style must be one of ${FACE_STYLES.join(", ")}`);
  const ws = workspace(stones);
  const reports = [];
  const irisColour = ({ c, r }) => {
    if (!ctx.photoLab) return null;
    const labs = [];
    for (let k = 0; k < 24; k++) {
      const a = (2 * Math.PI * k) / 24;
      for (const f of [0.55, 0.75, 0.9]) {
        const lab = ctx.photoLab(c[0] + f * r * Math.cos(a), c[1] + f * r * Math.sin(a));
        // Not the lid's shadow, the lashes or the catch-light.
        if (lab && lab[0] >= 25 && lab[0] <= 85) labs.push(lab);
      }
    }
    return labs.length >= 6 ? snapColour(median(labs)) : null;
  };
  const full = { discs: [], readStone: () => null, irisColour, ...ctx };
  for (const points of faces) {
    const regions = faceRegions(points);
    const r = { eyeDistanceMm: round(regions.eyeDistanceMm), mouthOpen: regions.lips.open, mouthGapMm: round(regions.lips.gapMm) };
    if (eyes) r.eyes = regions.eyes.map((e) => designEye(ws, e, eyes, style, full));
    if (lips) r.lips = designLips(ws, regions.lips, lips, style, full);
    if (teeth) r.teeth = designTeeth(ws, regions.lips, teeth, style, full);
    reports.push(r);
  }
  const out = ws.stones.filter((s) => !s.removed).map(({ x, y, d, color, designed }) => (designed ? { x, y, d, color, designed: true } : { x, y, d, color }));
  return { stones: out, faces: reports };
}

// After the hole fill: in stencil style every undesigned Jet stone within EYE_BAND_MM of an eye's
// opening (and not in it) becomes Crystal, so Crystal separates the eye from dark shadows and
// eyebrows; with E1, whose lids are the AI's own stones, only beyond LID_MARGIN_MM. pupils: as for
// designFaceFeatures (the eyes moved the same way). Other styles:
// unchanged. -> { stones, crystal (count) }.
export function finishFaceFeatures(stones, faces, { style, eyes = null, pupils = [] }) {
  if (style !== "stencil" || !eyes) return { stones, crystal: 0 };
  const openings = faces.flatMap((points) => faceRegions(points).eyes.filter((e) => e.widthMm >= MIN_EYE_WIDTH_MM).map((e) => snapEye(e, pupils).eye.opening));
  let crystal = 0;
  const out = stones.map((s) => {
    if (s.designed || s.color !== JET) return s;
    const near = openings.some((o) => {
      const dd = outsideDistance([s.x, s.y], o);
      return dd > (eyes === "E1" ? LID_MARGIN_MM : 0) && dd <= EYE_BAND_MM;
    });
    if (!near) return s;
    crystal++;
    return { ...s, color: CRYSTAL };
  });
  return { stones: out, crystal };
}

// Lab of a catalogue colour and ΔE between colours (for reports).
export const colourDistance = (a, b) => deltaE2000(labOfId(a), labOfId(b));
export { bw as bwOfLightness };

function round(v) {
  return Math.round(v * 100) / 100;
}
