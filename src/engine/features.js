import { PALETTE, deltaE2000, snapColour } from "../pipeline/holes.js";
import { MIN_GAP_MM } from "../pipeline/tiers.js";
import { getStoneSize } from "../stones/StoneSizes.js";
import {
  SS4_D, SS6_D, boxOf, centroid, eyeDesign, insidePolygon, lidPaths, lipOutlineD, lipOutlinePath, lowerLidD, mouthDesign,
  polylineDistance
} from "./faces.js";
import { CRYSTAL, JET, ROW_GAP_MM, rampOf } from "./map.js";

// The face features of the design concept (section 5; exp-engine build 3, docs/exp-engine.md), built
// from a landmark face (faces.js faceGeometry) in the placement's first step (place.js). Every stone
// keeps MIN_GAP_MM to every other and lies inside the subject (env.fits); chains are chains as
// everywhere (env.chain: even steps, one colour and size, at least 3 stones).
//
// Build 4: the design of each feature follows its size (faces.js eyeDesign, mouthDesign). Below are
// the full designs; the others:
//
//   Simple eye   (6-10 mm wide) the upper lid a chain of SS4 Jet; the pupil one Jet stone as the full
//                eye's (it may sit up to SIMPLE_PUPIL_DOWN_MM below the iris centre, there being no
//                lower lid); one Crystal white on each side of it along the eye (SS6, else SS4) where
//                it fits; no iris ring, lower lid, catch-light or lashes.
//   Kept eye     (under 6 mm) today's stones (the AI's), cleaned (cleanKept): the pupil kept, every
//                other stone of a colour outside the eye's (Jet, Crystal, the skin's tones and its
//                lower-lid tone) takes the nearest of those (CIEDE2000).
//   Simple mouth (7-14 mm wide) the mouth line as the full mouth's; both lips packed in one lip tone
//                (the AI's lip discs' most common colour); no outline; an open mouth's teeth as the
//                full mouth's.
//   Line mouth   (hair or a beard over the lips, faces.js mouthDesign) the mouth line only, in the
//                darkest colour the AI drew along it (a lip-outline step darker if that is not dark).
//   Kept mouth   (under 7 mm) today's stones, cleaned: colours outside Jet, Crystal, the lips' and
//                the skin's tones take the nearest of those.
//
//   Eye    the upper lid a chain of SS6 Jet along the almond's upper curve, the lower lid a chain of
//          SS4 (SS6 on large eyes, lowerLidD) in a dark tone of the skin ramp, both LID_OFFSET of a
//          stone's radius outside the curves (faces.js lidPaths); the pupil one Jet stone, the
//          largest of PUPIL_SIZES at most half the iris width (both eyes the same size), at the
//          iris centre (or as little off it as fits); the catch-light one Crystal SS4 touching the
//          pupil on the side the light comes from (lightSide; the same side in both eyes); the iris a
//          ring of SS4 in the iris colour around the pupil when the ring fits within RING_ROOM_MM of
//          the iris and a third of it (3 stones at least) shows between the lids, the rest of the
//          iris then SS4 in the iris colour;
//          the eye white Crystal, packed in the rest of the opening; lashes, when the AI drew them
//          (dark beyond the outer half of the upper lid, LASH_*), a chain of 2-5 SS4 Jet from the
//          outer corner, turned up.
//   Nose   no outline; each nostril one dark stone where the AI drew one (NOSTRIL_STEP_L darker than
//          the cheeks); one shadow chain of SS4 one tone darker than the skin from the bridge to the
//          tip, on the darker side, only where the AI drew one (SHADOW_STEP_L).
//   Lips   the outline a closed chain (SS4, SS6 on a wide mouth) in a dark lip tone; the mouth line a
//          chain of SS4 in the darkest lip tone between the lips (open mouth: one along each inner
//          lip); the upper lip packed in a darker lip tone, the lower in a lighter one.
//   Teeth  an open mouth with teeth (AI L* of TEETH_L or more over TEETH_SHARE of the opening):
//          Crystal in rows (a lattice along the mouth) between the two mouth lines, the rest of the
//          opening the mouth's dark; no lines inside.
//
// Colours. Colour: the iris from the photo (the prepared photo's iris ring, else the AI's mid-tone
// iris discs); skin from the map's area at the cheeks and its ramp (map.js RAMPS); the lips from the
// AI's discs on them and their ramp. Black & white: Jet and Crystal only, features never mixed: lids,
// lashes, pupil, iris, nostrils, nose shadow, lip outline, mouth line, upper lip and the mouth's dark
// Jet; eye white, catch-light, lower lip and teeth Crystal.
//
// env (place.js): fits(x, y, d), put(x, y, d, colour, part), chain(part, colour, d, [[x, y]], closed)
// -> stones placed, clearance(x, y) (smallest rim distance to the stones), aiL(x, y, d) (L* of the
// AI image on white over a disc), aiLab(x, y, d), photoLab(x, y) or null, discs (the map's), mode,
// areaColourAt(x, y) (the map's tone there, or null), areaTonesAt(x, y) (that area's tones, or null).

export const SS10_D = getStoneSize("ss10").diameterMm;
export const SS16_D = getStoneSize("ss16").diameterMm;
export const SS20_D = getStoneSize("ss20").diameterMm;
export const PUPIL_SIZES = Object.freeze([SS20_D, SS16_D, SS10_D, SS6_D]);
export const RING_ROOM_MM = 0.5;
export const LIGHT_SIDE_L = 4;
export const LASH_DARK_SHARE = 0.35;
export const LASH_MARGIN = 0.15;
export const LASH_TURN_DEG = 35;
export const SKIN_DARK_L = 20;
export const NOSTRIL_STEP_L = 6;
export const SHADOW_STEP_L = 8;
export const LIP_STEP_L = 6;
export const LIP_OUTLINE_STEP_L = 10;
export const TEETH_L = 62;
export const TEETH_SHARE = 0.15;
export const EDGE_SLACK_MM = 0.35;
export const SIMPLE_PUPIL_DOWN_MM = 1.0;
export const KEPT_PUPIL_L = 35;

const GAP = MIN_GAP_MM;
const EPS = 1e-6;
const HEX_PITCH = SS6_D + ROW_GAP_MM;
const LAB = Object.fromEntries(PALETTE.map((p) => [p.id, p.lab]));
const L = (id) => LAB[id][0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (a) => { const n = Math.hypot(a[0], a[1]) || 1; return [a[0] / n, a[1] / n]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const rotate = (a, deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [a[0] * c - a[1] * s, a[0] * s + a[1] * c]; };
const round = (v, k = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** k) / 10 ** k);

function majority(ids) {
  const count = new Map();
  for (const id of ids) if (id) count.set(id, (count.get(id) || 0) + 1);
  let best = null, n = 0;
  for (const [id, c] of count) if (c > n || (c === n && id < best)) { best = id; n = c; }
  return best;
}

// Points sampled every step mm inside a polygon.
function samplePolygon(poly, step = 0.4, keep = () => true) {
  const b = boxOf(poly), out = [];
  for (let y = b.y0; y <= b.y1; y += step) for (let x = b.x0; x <= b.x1; x += step) if (insidePolygon([x, y], poly) && keep([x, y])) out.push([x, y]);
  return out;
}

// A ramp's colours from light to dark.
const rampColours = (colour) => [...rampOf([colour]).colours].sort((a, b) => L(b) - L(a));

// The lightest colour of the ramp at least `step` L* darker than `colour`; else the ramp's darkest
// if it is darker at all; else Jet.
function darkerInRamp(colour, step, ramp = rampColours(colour)) {
  const hit = ramp.find((c) => L(c) <= L(colour) - step);
  if (hit) return hit;
  const darkest = ramp[ramp.length - 1];
  return L(darkest) < L(colour) - 1 ? darkest : JET;
}

// --- Light ---------------------------------------------------------------------------------------

// The side the light comes from, from the face's shading in the AI image: the mean L* of the cheek
// band (0.15-1.0 IPD below the eyes, 0.2-0.9 IPD to each side of the midline, away from the lips),
// left against right. A difference of LIGHT_SIDE_L or more decides; else it is unclear and the light
// comes from the upper right. -> { side (+1 right, -1 left), source, diffL, dir (unit vector of the
// catch-light from the pupil: up and towards the light, 45 degrees) }.
export function lightSide(face, aiL) {
  const mid = lerp(face.eyes[0].iris.c, face.eyes[1].iris.c, 0.5);
  const sums = { left: [0, 0], right: [0, 0] };
  for (const p of samplePolygon(face.oval, 0.6)) {
    const rel = [p[0] - mid[0], p[1] - mid[1]];
    const a = dot(rel, face.u) / face.ipd, b = dot(rel, face.v) / face.ipd;
    if (b < 0.15 || b > 1.0 || Math.abs(a) < 0.2 || Math.abs(a) > 0.9) continue;
    if (insidePolygon(p, face.lips.outer) || polylineDistance(p, face.lips.outer, true) < 1.5) continue;
    const l = aiL(p[0], p[1], 0.6);
    if (l == null) continue;
    const s = sums[a < 0 ? "left" : "right"];
    s[0] += l; s[1]++;
  }
  let side = 1, source = "unclear: upper right", diffL = null;
  if (sums.left[1] >= 10 && sums.right[1] >= 10) {
    diffL = sums.right[0] / sums.right[1] - sums.left[0] / sums.left[1];
    if (Math.abs(diffL) >= LIGHT_SIDE_L) { side = Math.sign(diffL); source = "shading"; }
  }
  const dir = unit([side * face.u[0] * Math.SQRT1_2 - face.v[0] * Math.SQRT1_2, side * face.u[1] * Math.SQRT1_2 - face.v[1] * Math.SQRT1_2]);
  return { side, source, diffL: round(diffL, 1), dir };
}

// --- Colours -------------------------------------------------------------------------------------

function faceColours(face, env) {
  const bw = env.mode !== "colour";
  const cheekL = (() => {
    const v = face.cheeks.map(([x, y]) => env.aiL(x, y, 2)).filter((l) => l != null);
    return v.length ? v.reduce((s, l) => s + l, 0) / v.length : 70;
  })();
  if (bw) {
    return { bw, skin: null, skinL: cheekL, lowerLid: JET, shadow: JET, nostril: JET, iris: JET, white: CRYSTAL, catchLight: CRYSTAL,
      lips: { upper: JET, lower: CRYSTAL, outline: JET, line: JET, dark: JET, one: JET, source: "black & white" }, brow: JET, irisSource: "black & white" };
  }
  const skin = majority(face.cheeks.map(([x, y]) => env.areaColourAt(x, y))) ?? snapColour(env.aiLab(...face.cheeks[0], 2));
  const ramp = rampColours(skin);
  // The skin area's own tones (the colours the AI used there), light to dark.
  const tones = [...new Set(face.cheeks.flatMap(([x, y]) => env.areaTonesAt(x, y) ?? []))].sort((a, b) => L(b) - L(a));
  // One tone darker than the skin: the skin area's next darker tone (SHADOW_STEP_L darker at least),
  // else its ramp's; the lower lid and nostrils: a tone SKIN_DARK_L darker, the area's or the ramp's.
  const shadow = tones.find((t) => L(t) <= L(skin) - SHADOW_STEP_L) ?? darkerInRamp(skin, SHADOW_STEP_L, ramp);
  const lowerLid = tones.find((t) => L(t) <= L(skin) - SKIN_DARK_L) ?? darkerInRamp(skin, SKIN_DARK_L, ramp);
  // The lips: the AI's discs on each lip, without its dark outline and line (L* 35 or more).
  const discsIn = (poly) => env.discs.filter((d) => insidePolygon([d.x, d.y], poly) && d.lab[0] >= 35 && L(d.snap) >= 30).map((d) => d.snap);
  const mean = (poly) => {
    const labs = samplePolygon(poly, 0.4).map(([x, y]) => env.aiLab(x, y, 0.6)).filter(Boolean);
    return labs.length ? [0, 1, 2].map((k) => labs.reduce((s, v) => s + v[k], 0) / labs.length) : null;
  };
  const fromDiscs = (poly) => majority(discsIn(poly));
  const one = fromDiscs(face.lips.outer);
  let lower = fromDiscs(face.lips.lower) ?? fromDiscs(face.lips.upper);
  let upper = fromDiscs(face.lips.upper) ?? lower;
  const source = lower ? "AI discs" : "AI pixels";
  if (!lower) lower = upper = snapColour(mean(face.lips.outer) ?? [50, 35, 20]);
  const lipRamp = [...new Set([...rampOf([upper, lower]).colours, upper, lower])].sort((a, b) => L(b) - L(a));
  if (L(upper) > L(lower) - LIP_STEP_L) upper = darkerInRamp(lower, LIP_STEP_L, lipRamp);
  const outline = darkerInRamp(upper, LIP_OUTLINE_STEP_L, lipRamp);
  const line = darkerInRamp(outline, 6, lipRamp);
  return { bw, skin, skinL: L(skin), cheekL, ramp, lowerLid, shadow, nostril: lowerLid, white: CRYSTAL, catchLight: CRYSTAL,
    lips: { upper, lower, outline, line, dark: line, one: one ?? lower, source } };
}

// The iris colour (colour designs): the photo's (the median of the iris ring's samples, not the lid's
// shadow, the lashes or the catch-light), else the AI's mid-tone discs in the iris, else Smoked Topaz.
function irisColour(iris, env) {
  const { c, r } = iris;
  if (env.photoLab) {
    const labs = [];
    for (let k = 0; k < 24; k++) {
      const a = (2 * Math.PI * k) / 24;
      for (const f of [0.55, 0.75, 0.9]) {
        const lab = env.photoLab(c[0] + f * r * Math.cos(a), c[1] + f * r * Math.sin(a));
        if (lab && lab[0] >= 25 && lab[0] <= 85) labs.push(lab);
      }
    }
    if (labs.length >= 6) return { colour: snapColour([0, 1, 2].map((k) => labs.map((v) => v[k]).sort((p, q) => p - q)[labs.length >> 1])), source: "photo" };
  }
  const mid = env.discs.filter((d) => { const q = dist([d.x, d.y], c); return q > 0.45 * r && q <= 1.05 * r && L(d.snap) >= 15 && L(d.snap) <= 75; }).map((d) => d.snap);
  const ai = majority(mid);
  return ai ? { colour: ai, source: "AI discs" } : { colour: "smoked-topaz", source: "default" };
}

// --- Packing -------------------------------------------------------------------------------------

// Packs a region with feature stones: SS6 on a hexagonal lattice along `angle` through `origin`, then
// (sizes) the free spot farthest from every stone first, each stone's centre inside the polygon and
// its edge at most EDGE_SLACK_MM beyond it. -> stones placed.
function pack(env, poly, colourAt, part, { angle = 0, origin = centroid(poly), sizes = [SS6_D, SS4_D], lattice = true, keep = () => true } = {}) {
  const box = boxOf(poly);
  const edge = (p) => polylineDistance(p, poly, true);
  const ok = (p, d) => insidePolygon(p, poly) && keep(p) && edge(p) >= d / 2 - EDGE_SLACK_MM;
  let n = 0;
  if (lattice && sizes.includes(SS6_D)) {
    const e1 = [HEX_PITCH * Math.cos(angle), HEX_PITCH * Math.sin(angle)];
    const e2 = [HEX_PITCH * Math.cos(angle + Math.PI / 3), HEX_PITCH * Math.sin(angle + Math.PI / 3)];
    const reach = Math.ceil(Math.hypot(box.x1 - box.x0, box.y1 - box.y0) / (HEX_PITCH * 0.8)) + 1;
    for (let j = -reach; j <= reach; j++) {
      for (let i = -reach; i <= reach; i++) {
        const p = [origin[0] + i * e1[0] + j * e2[0], origin[1] + i * e1[1] + j * e2[1]];
        if (p[0] < box.x0 || p[0] > box.x1 || p[1] < box.y0 || p[1] > box.y1 || !ok(p, SS6_D) || !env.fits(p[0], p[1], SS6_D)) continue;
        env.put(p[0], p[1], SS6_D, colourAt(p), part);
        n++;
      }
    }
  }
  const cands = [];
  for (let y = box.y0; y <= box.y1; y += 0.1) for (let x = box.x0; x <= box.x1; x += 0.1) if (insidePolygon([x, y], poly) && keep([x, y])) cands.push([x, y]);
  const edges = cands.map(edge);
  for (const d of sizes) {
    const clear = cands.map(([x, y], k) => (edges[k] >= d / 2 - EDGE_SLACK_MM ? env.clearance(x, y) - GAP : -Infinity));
    for (;;) {
      let best = -1, bv = -Infinity;
      for (let k = 0; k < cands.length; k++) if (clear[k] > bv) { bv = clear[k]; best = k; }
      if (best < 0 || bv < d / 2 - EPS) break;
      const [x, y] = cands[best];
      if (!env.fits(x, y, d)) { clear[best] = -Infinity; continue; }
      env.put(x, y, d, colourAt([x, y]), part);
      n++;
      for (let k = 0; k < cands.length; k++) {
        const g = Math.hypot(cands[k][0] - x, cands[k][1] - y) - d / 2 - GAP;
        if (g < clear[k]) clear[k] = g;
      }
    }
  }
  return n;
}

// --- Eyes ----------------------------------------------------------------------------------------

// Where a pupil of diameter d fits: at the iris centre, else moved by as little as fits, up to 0.4
// iris radii (across the eye first). With catchFits, the nearest spot where its catch-light fits
// too, if there is one. -> [x, y] or null.
// down: also as far as that below the iris centre (mm; a simple eye has no lower lid).
function pupilSpot(eye, d, env, catchFits = null, down = 0) {
  const { c, r } = eye.iris;
  const spots = [];
  for (let a = -4; a <= 4; a++) {
    for (let b = -8; b <= 8 + Math.ceil(down / 0.1); b++) {
      const t = b <= 8 ? b * 0.05 * r : 0.4 * r + (b - 8) * 0.1, s = a * 0.1 * r;
      if (Math.hypot(t, s) > Math.max(0.4 * r, down) + EPS || (t > 0.4 * r + EPS && Math.abs(s) > 0.4 * r + EPS)) continue;
      spots.push({ p: [c[0] + t * eye.normal[0] + s * eye.axis[0], c[1] + t * eye.normal[1] + s * eye.axis[1]], off: Math.hypot(t, s) + (a ? 0.01 : 0) });
    }
  }
  spots.sort((p, q) => p.off - q.off);
  let first = null;
  for (const { p } of spots) {
    if (!env.fits(p[0], p[1], d)) continue;
    if (!catchFits || catchFits(p, d)) return p;
    first ??= p;
  }
  return first;
}

// The catch-light's spot beside a pupil at c (diameter d): from 45 degrees up towards the light,
// turning to straight up or down to 30 degrees below the horizontal, always on the light's side.
// -> { p, turn, dir } or null.
function catchSpot(c, d, env, light, u) {
  const reach = d / 2 + GAP + SS4_D / 2 + 0.002;
  for (const turn of [0, -15, 15, -30, 30, -45, 45, -60, -75]) {
    const dir = rotate(light.dir, turn);
    if (dot(dir, u) * light.side < -0.05) continue;
    const p = [c[0] + reach * dir[0], c[1] + reach * dir[1]];
    if (env.fits(p[0], p[1], SS4_D) && Math.hypot(p[0] - c[0], p[1] - c[1]) - (d + SS4_D) / 2 >= GAP - EPS) return { p, turn, dir };
  }
  return null;
}

// Did the AI draw lashes? The share of dark samples (L* below the cheeks by 25, at most 40; black &
// white: below the threshold) 0.8-2.4 mm above the outer half of the upper lid, against the inner
// half; lashes when it is at least LASH_DARK_SHARE and LASH_MARGIN above the inner half's.
function lashes(eye, env, colours) {
  const up = [-eye.normal[0], -eye.normal[1]];
  const dark = (l) => (colours.bw ? l < env.threshold : l < Math.min(40, colours.cheekL - 25));
  const share = (from, to) => {
    let n = 0, k = 0;
    const m = eye.upper.length - 1;
    for (let q = Math.round(from * m); q <= Math.round(to * m); q++) {
      for (const off of [0.8, 1.2, 1.6, 2.0, 2.4]) {
        const p = eye.upper[q];
        const l = env.aiL(p[0] + off * up[0], p[1] + off * up[1], 0.5);
        if (l == null) continue;
        n++;
        if (dark(l)) k++;
      }
    }
    return n ? k / n : 0;
  };
  const outerHalf = eye.outer === 1 ? [0.55, 1] : [0, 0.45], innerHalf = eye.outer === 1 ? [0, 0.45] : [0.55, 1];
  const outer = share(...outerHalf), inner = share(...innerHalf);
  const drawn = outer >= LASH_DARK_SHARE && outer >= inner + LASH_MARGIN;
  return { drawn, share: round(outer), innerShare: round(inner), count: drawn ? Math.max(2, Math.min(5, Math.round(2 + (3 * (outer - LASH_DARK_SHARE)) / 0.4))) : 0 };
}

// The largest pupil size (at most half the iris width, SS6 at least) that fits in every eye of rows.
function commonPupil(rows, env, down = 0) {
  const allowed = (eye) => { const s = PUPIL_SIZES.filter((d) => d <= eye.iris.r + EPS); return s.length ? s : [SS6_D]; };
  const largest = rows.map((r) => allowed(r.eye).find((d) => pupilSpot(r.eye, d, env, null, down)) ?? null);
  return largest.some((d) => d != null) ? Math.min(...largest.filter((d) => d != null)) : null;
}

// Simple eyes (build 4): an SS4 Jet upper lid, a Jet pupil, one Crystal white on each side.
function buildSimpleEyes(rows, env, colours) {
  for (const r of rows) {
    r.out.upperLid = env.chain("upper-lid", JET, SS4_D, lidPaths(r.eye, SS4_D, SS4_D).upper, false);
    r.out.upperLidSize = "ss4";
  }
  const common = commonPupil(rows, env, SIMPLE_PUPIL_DOWN_MM);
  for (const r of rows) {
    let spot = null, d = null;
    for (const s of common == null ? [] : PUPIL_SIZES.filter((q) => q <= common + EPS)) { spot = pupilSpot(r.eye, s, env, null, SIMPLE_PUPIL_DOWN_MM); if (spot) { d = s; break; } }
    if (!spot) { r.out.pupil = null; r.out.pupilMissing = "no room below the lid"; continue; }
    env.put(spot[0], spot[1], d, JET, "pupil");
    r.pupil = { c: spot, d };
    r.out.pupil = { d, offMm: round(dist(spot, r.eye.iris.c)), share: round(d / (2 * r.eye.iris.r)) };
  }
  for (const r of rows) {
    r.out.white = 0;
    if (!r.pupil) continue;
    const { axis, normal, opening } = r.eye;
    r.out.whiteSides = [-1, 1].map((side) => {
      for (const d of [SS6_D, SS4_D]) {
        for (const extra of [0, 0.15, 0.3, 0.5]) {
          for (const shift of [0, -0.2, 0.2, -0.4, 0.4, -0.6, 0.6]) {
            const along = side * (r.pupil.d / 2 + GAP + d / 2 + 0.002 + extra);
            const p = [r.pupil.c[0] + along * axis[0] + shift * normal[0], r.pupil.c[1] + along * axis[1] + shift * normal[1]];
            if (!insidePolygon(p, opening) || polylineDistance(p, opening, true) < d / 2 - EDGE_SLACK_MM || !env.fits(p[0], p[1], d)) continue;
            env.put(p[0], p[1], d, colours.white, "white");
            r.out.white++;
            return d === SS6_D ? "ss6" : "ss4";
          }
        }
      }
      return null;
    });
  }
  return common;
}

function buildEyes(face, env, colours, light) {
  const lowerD = lowerLidD(face.eyes);
  const design = eyeDesign(face);
  const rows = face.eyes.map((eye) => ({
    eye,
    out: { design, widthMm: round(eye.widthMm), heightMm: round(eye.heightMm), irisRMm: round(eye.iris.r), pupilSnapMm: round(eye.snapMm) }
  }));
  const w = face.eyes.map((e) => e.widthMm);
  const summary = { design, widthRatio: round(Math.min(...w) / Math.max(...w)) };
  if (design === "kept") return { eyes: rows.map((r) => r.out), ...summary, pupilSize: null };
  if (design === "simple") return { eyes: rows.map((r) => r.out), ...summary, pupilSize: buildSimpleEyes(rows, env, colours) };
  const built = rows;
  // Lids.
  for (const r of built) {
    const { upper, lower } = lidPaths(r.eye, lowerD);
    r.out.upperLid = env.chain("upper-lid", JET, SS6_D, upper, false);
    r.out.lowerLid = env.chain("lower-lid", colours.lowerLid, lowerD, lower, false);
    r.out.lowerLidSize = lowerD === SS6_D ? "ss6" : "ss4";
  }
  // Pupils: the largest size at most half the iris width (SS6 at least) that fits in both eyes.
  const common = commonPupil(built, env);
  for (const r of built) {
    const sizes = common == null ? [] : PUPIL_SIZES.filter((d) => d <= common + EPS);
    let spot = null, d = null;
    for (const s of sizes) { spot = pupilSpot(r.eye, s, env, (p, dd) => catchSpot(p, dd, env, light, face.u) != null); if (spot) { d = s; break; } }
    if (!spot) { r.out.pupil = null; r.out.pupilMissing = "no room between the lids"; continue; }
    env.put(spot[0], spot[1], d, JET, "pupil");
    r.pupil = { c: spot, d };
    r.out.pupil = { d, offMm: round(dist(spot, r.eye.iris.c)), share: round(d / (2 * r.eye.iris.r)) };
  }
  // Catch-lights, on the light's side in both eyes.
  for (const r of built) {
    if (!r.pupil) continue;
    const spot = catchSpot(r.pupil.c, r.pupil.d, env, light, face.u);
    r.out.catchLight = spot ? { turnDeg: spot.turn } : null;
    if (spot) {
      env.put(spot.p[0], spot.p[1], SS4_D, colours.catchLight, "catch-light");
      r.catchDir = spot.dir;
    } else r.out.catchLightMissing = "no room beside the pupil";
  }
  // Iris rings and the rest of the iris.
  for (const r of built) {
    if (!r.pupil) continue;
    const iris = colours.bw ? { colour: JET, source: "black & white" } : irisColour(r.eye.iris, env);
    r.out.irisColour = iris.colour;
    r.out.irisSource = iris.source;
    const R = r.pupil.d / 2 + GAP + SS4_D / 2 + 0.002;
    const roomy = R + SS4_D / 2 <= r.eye.iris.r + RING_ROOM_MM;
    r.out.ring = 0;
    if (!roomy) { r.out.ringSkipped = "iris too small for a ring"; continue; }
    const n = Math.floor((2 * Math.PI * R) / (SS4_D + ROW_GAP_MM));
    const start = Math.atan2((r.catchDir ?? light.dir)[1], (r.catchDir ?? light.dir)[0]);
    const spots = [];
    for (let k = 0; k < n; k++) {
      const a = start + (2 * Math.PI * k) / n;
      const p = [r.pupil.c[0] + R * Math.cos(a), r.pupil.c[1] + R * Math.sin(a)];
      if (insidePolygon(p, r.eye.opening) && env.fits(p[0], p[1], SS4_D)) spots.push(p);
    }
    // The lids cover part of an iris; the ring is drawn where it shows, if that is a third of it.
    if (spots.length < Math.max(3, Math.ceil(n / 3))) { r.out.ringSkipped = `ring does not fit (${spots.length} of ${n})`; continue; }
    for (const p of spots) if (env.fits(p[0], p[1], SS4_D)) { env.put(p[0], p[1], SS4_D, iris.colour, "iris"); r.out.ring++; }
    r.out.irisFill = pack(env, r.eye.opening, () => iris.colour, "iris", { sizes: [SS4_D], lattice: false, keep: (p) => dist(p, r.pupil.c) <= r.eye.iris.r });
    r.ringed = true;
  }
  // Lashes.
  for (const r of built) {
    const found = lashes(r.eye, env, colours);
    r.out.lashes = { drawn: found.drawn, share: found.share, innerShare: found.innerShare, stones: 0 };
    if (!found.drawn) continue;
    const { upper } = lidPaths(r.eye, lowerD);
    const end = r.eye.outer === 1 ? upper[upper.length - 1] : upper[0];
    const before = r.eye.outer === 1 ? upper[upper.length - 3] : upper[2];
    let dir = unit([end[0] - before[0], end[1] - before[1]]);
    // Turned up, away from the eye.
    const up = [-r.eye.normal[0], -r.eye.normal[1]];
    const turned = [rotate(dir, LASH_TURN_DEG), rotate(dir, -LASH_TURN_DEG)];
    dir = dot(turned[0], up) > dot(turned[1], up) ? turned[0] : turned[1];
    const pitch = SS4_D + ROW_GAP_MM;
    const start = SS6_D / 2 + GAP + SS4_D / 2 + 0.05;
    const path = Array.from({ length: found.count }, (_, k) => {
      const t = start + k * pitch;
      // A slight curl upwards along the lash.
      const bend = rotate(dir, (dot(rotate(dir, 90), up) > 0 ? 1 : -1) * 6 * k);
      return [end[0] + t * bend[0], end[1] + t * bend[1]];
    });
    r.out.lashes.stones = path.length >= 2 ? env.chain("lash", JET, SS4_D, path, false, 2) : 0;
    if (!r.out.lashes.stones) r.out.lashes.why = "no room (outside the subject or against other stones)";
  }
  // Eye whites.
  for (const r of built) {
    const angle = Math.atan2(r.eye.axis[1], r.eye.axis[0]);
    const keep = r.ringed ? (p) => dist(p, r.pupil.c) > r.eye.iris.r : () => true;
    r.out.white = pack(env, r.eye.opening, () => colours.white, "white", { angle, origin: r.pupil?.c ?? r.eye.iris.c, keep });
  }
  return { eyes: rows.map((r) => r.out), ...summary, pupilSize: common };
}

// --- Nose ----------------------------------------------------------------------------------------

function buildNose(face, env, colours) {
  const out = { nostrils: [], shadow: null };
  const ref = colours.bw ? null : colours.cheekL;
  const darkEnough = (l, step) => (colours.bw ? l < env.threshold : l <= ref - step);
  const { base, alae, bridge, tip } = face.nose;
  alae.forEach((alar, k) => {
    const p0 = lerp(base, alar, 0.5);
    let best = null;
    for (let dy = -1.4; dy <= 1.4 + EPS; dy += 0.2) {
      for (let dx = -1.4; dx <= 1.4 + EPS; dx += 0.2) {
        if (Math.hypot(dx, dy) > 1.4 + EPS) continue;
        const p = [p0[0] + dx, p0[1] + dy];
        const l = env.aiL(p[0], p[1], 1.0);
        if (l != null && (!best || l < best.l)) best = { p, l };
      }
    }
    const side = k ? "right" : "left";
    if (!best || !darkEnough(best.l, NOSTRIL_STEP_L)) { out.nostrils.push({ side, placed: false, why: "not drawn darker than the cheeks" }); return; }
    const wide = darkEnough(env.aiL(best.p[0], best.p[1], SS6_D), NOSTRIL_STEP_L);
    const colour = colours.bw || best.l < 25 ? JET : colours.nostril;
    for (const d of wide ? [SS6_D, SS4_D] : [SS4_D]) {
      for (const off of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
        const p = [best.p[0] + off[0], best.p[1] + off[1]];
        if (!env.fits(p[0], p[1], d)) continue;
        env.put(p[0], p[1], d, colour, "nostril");
        out.nostrils.push({ side, placed: true, size: d === SS6_D ? "ss6" : "ss4", colour });
        return;
      }
    }
    out.nostrils.push({ side, placed: false, why: "no room" });
  });
  // The shadow chain: a gentle curve on each side from the bridge to beside the tip; the darker one,
  // if the AI drew it (SHADOW_STEP_L below the cheeks and 3 below the other side).
  const paths = alae.map((alar, k) => {
    const s = (k ? 1 : -1) * 0.1 * face.ipd;
    const a = [bridge[0] + s * face.u[0], bridge[1] + s * face.u[1]];
    const m = lerp(lerp(bridge, alar, 0.55), a, 0.3);
    const b = lerp(tip, alar, 0.45);
    return Array.from({ length: 21 }, (_, q) => {
      const t = q / 20;
      return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * m[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * m[1] + t * t * b[1]];
    });
  });
  const means = paths.map((path) => {
    const v = path.slice(2, -2).map(([x, y]) => env.aiL(x, y, 0.8)).filter((l) => l != null);
    return v.length ? v.reduce((s, l) => s + l, 0) / v.length : Infinity;
  });
  const k = means[0] <= means[1] ? 0 : 1;
  out.shadowL = means.map((m) => round(m, 1));
  if (darkEnough(means[k], SHADOW_STEP_L) && means[k] <= means[1 - k] - 3) {
    const n = env.chain("nose-shadow", colours.shadow, SS4_D, paths[k], false);
    out.shadow = n ? { side: k ? "right" : "left", stones: n, colour: colours.shadow } : null;
    if (!n) out.shadowWhy = "no room";
  } else out.shadowWhy = "not drawn";
  return out;
}

// --- Lips and teeth ------------------------------------------------------------------------------

// The darkest colour the AI drew along the mouth line (its discs within 1 mm), a lip-outline step
// darker in its ramp if that is not dark (L* above 40); Jet in black & white or with no disc there.
function lineColour(lips, env, colours) {
  if (colours.bw) return JET;
  const near = env.discs.filter((d) => polylineDistance([d.x, d.y], lips.line) <= 1.0).map((d) => d.snap).sort((a, b) => L(a) - L(b));
  if (!near.length) return JET;
  return L(near[0]) > 40 ? darkerInRamp(near[0], LIP_OUTLINE_STEP_L) : near[0];
}

function buildMouth(face, env, colours) {
  const lips = face.lips;
  const c = colours.lips;
  const design = mouthDesign(face);
  const angle = Math.atan2(face.u[1], face.u[0]);
  const outlineD = lipOutlineD(lips);
  const out = { design, widthMm: round(lips.widthMm), open: lips.open, hair: lips.hair ? { share: lips.hair.share, under: lips.hair.under } : null };
  if (design === "kept") return out;
  if (design === "line") {
    const colour = lineColour(lips, env, colours);
    out.colours = { line: colour };
    out.line = env.chain("mouth-line", colour, SS4_D, lips.line, false);
    return out;
  }
  out.colours = design === "full" ? { upper: c.upper, lower: c.lower, outline: c.outline, line: c.line } : { lips: c.one, line: c.line };
  out.source = c.source;
  if (design === "full") {
    out.outline = env.chain("lip-outline", c.outline, outlineD, lipOutlinePath(lips), true);
    out.outlineSize = outlineD === SS6_D ? "ss6" : "ss4";
  }
  if (!lips.open) {
    out.line = env.chain("mouth-line", c.line, SS4_D, lips.line, false);
  } else {
    out.line = env.chain("mouth-line", c.line, SS4_D, lips.upperInner, false) + env.chain("mouth-line", c.line, SS4_D, lips.lowerInner, false);
    // Teeth.
    const light = (p) => { const l = env.aiL(p[0], p[1], 0.6); return l != null && l >= TEETH_L; };
    const samples = samplePolygon(lips.opening, 0.3);
    const share = samples.length ? samples.filter(light).length / samples.length : 0;
    const teeth = share >= TEETH_SHARE;
    out.teeth = { share: round(share), visible: teeth };
    out.teeth.stones = pack(env, lips.opening, (p) => (teeth && light(p) ? CRYSTAL : c.dark), teeth ? "teeth" : "mouth", { angle });
  }
  out.upper = pack(env, lips.upper, () => (design === "full" ? c.upper : c.one), "upper-lip", { angle });
  out.lower = pack(env, lips.lower, () => (design === "full" ? c.lower : c.one), "lower-lip", { angle });
  return out;
}

// --- Kept features -------------------------------------------------------------------------------

// The nearest of the allowed colours (CIEDE2000 between catalogue colours).
const nearestOf = (colour, allowed) => allowed.reduce((a, b) => (deltaE2000(LAB[colour], LAB[b]) < deltaE2000(LAB[colour], LAB[a]) ? b : a));

// Today's stones kept in a face's kept eye and mouth regions (env.kept: { stone, region }), cleaned:
// in an eye the pupil (the largest stone of L* KEPT_PUPIL_L or less within the iris, nearest its
// centre on a tie) stays; every other stone of a colour outside the feature's colours takes the
// nearest of them. Black & white designs have only Jet and Crystal already. -> per feature
// { kind, stones, recoloured, pupil }.
function cleanKept(face, env, colours) {
  const out = [];
  const skinTones = colours.bw ? [] : [...new Set(face.cheeks.flatMap(([x, y]) => env.areaTonesAt(x, y) ?? []))];
  for (const region of env.keptRegions.filter((r) => r.faceGeo === face)) {
    const list = env.kept.filter((k) => k.region === region).map((k) => k.stone);
    const row = { kind: region.kind, stones: list.length, recoloured: 0 };
    let pupil = null;
    if (region.kind === "eye") {
      const eye = face.eyes.find((e) => e.iris.c === region.pupil);
      const dark = list.filter((st) => L(st.color) <= KEPT_PUPIL_L && dist([st.x, st.y], eye.iris.c) <= eye.iris.r + st.d / 2);
      pupil = dark.sort((a, b) => b.d - a.d || dist([a.x, a.y], eye.iris.c) - dist([b.x, b.y], eye.iris.c))[0] ?? null;
      row.pupil = pupil ? { d: pupil.d, colour: pupil.color } : null;
    }
    if (!colours.bw) {
      const allowed = [...new Set(region.kind === "eye"
        ? [JET, CRYSTAL, ...skinTones, colours.lowerLid]
        : [JET, CRYSTAL, ...skinTones, colours.lips.upper, colours.lips.lower, colours.lips.outline, colours.lips.line])].filter((id) => LAB[id]);
      for (const st of list) {
        if (st === pupil || allowed.includes(st.color) || !LAB[st.color]) continue;
        st.color = nearestOf(st.color, allowed);
        row.recoloured++;
      }
    }
    out.push(row);
  }
  return out;
}

// A landmark face's features -> its report (what was built, and where a feature could not be, why).
export function buildFace(face, env) {
  const colours = faceColours(face, env);
  const light = lightSide(face, env.aiL);
  const eyes = buildEyes(face, env, colours, light);
  const mouth = buildMouth(face, env, colours);
  const nose = buildNose(face, env, colours);
  const kept = cleanKept(face, env, colours);
  return {
    ipdMm: round(face.ipd, 1), light: { side: light.side > 0 ? "right" : "left", source: light.source, diffL: light.diffL },
    skin: colours.skin, ...eyes, nose, mouth, kept
  };
}
