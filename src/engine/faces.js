// Face regions of the engine (exp-engine, docs/exp-engine.md). Two kinds:
//
// - Landmark faces (build 3, concept section 5): a face's MediaPipe Face Mesh V2 landmarks (478
//   points with the irises, in layout mm; tools/exp-engine.mjs finds them as exp-faces did) give
//   its geometry (faceGeometry below: almond eyes, irises, brows, nose, lips) and polygon regions:
//   each eye and the mouth (the path of their outer chains; areas, outline and lines stay out) and
//   the nose (lines stay out; the skin's area runs on under the nose's stones). features.js builds
//   the features in them.
// - Pupil regions (builds 1 and 2), for faces without landmarks (animals; a person in profile):
//   the eyes and the mouth, where the engine keeps today's stones unchanged. They come from the
//   layout service's report alone: its two pupils (report.pupilsAtMm, when report.face is set and
//   there are exactly two) give the face's scale and direction. Each region is an ellipse in units of
//   the pupil distance (IPD), on the axis through the pupils (u, left to right) and its normal (v,
//   downwards):
//
//   eye:   centred on each eye's opening (eyeCentre below), half-axes EYE_U x EYE_V;
//   mouth: people only (report.face "human"), centred MOUTH_V below the pupils' midpoint, half-axes
//          MOUTH_HALF_U x MOUTH_HALF_V.
//
// The sizes cover the eye corners and lids and the lips' corners, top and bottom measured with
// MediaPipe face landmarks on the saved AI images of exp-faces (27 human faces in three styles and
// the RS portraits): eye corners at -0.30 ... +0.34 IPD from the pupil, lids at -0.15 ... +0.18;
// lips at -0.57 ... +0.67 across and +0.68 ... +1.54 below the pupil line, plus margin. An animal
// (report.face "animal") gets its two eye regions, no mouth.

export const EYE_U = 0.42;
export const EYE_V = 0.25;
export const MOUTH_U = 0.05;
export const MOUTH_V = 1.1;
export const MOUTH_HALF_U = 0.66;
export const MOUTH_HALF_V = 0.46;

// An eye region is centred on the eye opening, not on the pupil: with a sideways gaze the pupil sits
// at one end of the opening (rs-woman's far eye: a region on the pupil reached past the face's edge).
// The opening's centre is the midpoint of the pupil and the centroid of the eye-white discs around
// it (within EYE_SEARCH IPD, outside the pupil, white: L* at least WHITE_L and chroma below
// WHITE_CHROMA); with fewer than two such discs, the pupil. Its half-width follows the eye whites'
// reach (see below).
export const EYE_SEARCH = 0.45;
export const WHITE_L = 75;
export const WHITE_CHROMA = 15;
export const EYE_U_MIN = 0.3;
export const EYE_WHITE_REACH = 1;

function eyeCentre([x, y], ipd, pupilD, discs) {
  const whites = discs.filter((d) => {
    const r = Math.hypot(d.x - x, d.y - y);
    return r < EYE_SEARCH * ipd && r > pupilD / 2 + d.d / 2 && d.lab[0] >= WHITE_L && Math.hypot(d.lab[1], d.lab[2]) < WHITE_CHROMA;
  });
  if (whites.length < 2) return { centre: [x, y], halfU: EYE_U * ipd };
  const wx = whites.reduce((s, d) => s + d.x, 0) / whites.length, wy = whites.reduce((s, d) => s + d.y, 0) / whites.length;
  const centre = [(x + wx) / 2, (y + wy) / 2];
  // A foreshortened eye (the far eye of a face turned aside) is narrower: the region reaches
  // the farthest eye white plus 1.5 mm, between EYE_U_MIN and EYE_U IPD.
  const far = Math.max(...whites.map((d) => Math.hypot(d.x - centre[0], d.y - centre[1]) + d.d / 2), Math.hypot(x - centre[0], y - centre[1]) + pupilD / 2);
  return { centre, halfU: Math.min(EYE_U * ipd, Math.max(EYE_U_MIN * ipd, EYE_WHITE_REACH * far + 1.5)) };
}

// layout report (+ the map's discs, { x, y, d, lab }; + the landmark faces, faceGeometry) -> regions
// in layout mm. Pupil regions: [{ kind: "eye" | "mouth", x, y, ax, ay, angle, pupil }] (angle: of
// the ellipse's ax axis, radians; pupil: [x, y] of an eye). With landmark faces: their polygon
// regions (landmarkRegions; a kept eye or mouth is an ellipse with keep: true), and pupil regions only
// for service pupils that lie on no landmark eye (no mouth then).
export function faceRegions(report, discs = [], faces = []) {
  // Each landmark region knows its face (not enumerable: the saved map stays plain).
  const fromFaces = faces.flatMap((f) => landmarkRegions(f).map((r) => Object.defineProperty(r, "faceGeo", { value: f, enumerable: false })));
  const pupilRegions = pupilFaceRegions(report, discs);
  if (!faces.length) return pupilRegions;
  const onLandmarkEye = (p) => faces.some((f) => f.eyes.some((e) => Math.hypot(e.iris.c[0] - p[0], e.iris.c[1] - p[1]) < 0.5 * f.ipd));
  return [...fromFaces, ...pupilRegions.filter((r) => r.kind === "eye" && !onLandmarkEye(r.pupil))];
}

function pupilFaceRegions(report, discs) {
  if (!report || report.face == null || !Array.isArray(report.pupilsAtMm) || report.pupilsAtMm.length !== 2) return [];
  const [p, q] = [...report.pupilsAtMm].sort((a, b) => a[0] - b[0]);
  const ipd = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (!(ipd > 0)) return [];
  const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const u = [Math.cos(angle), Math.sin(angle)], v = [-u[1], u[0]];
  const pupilD = Math.max(...(report.pupilsMm || [4]));
  const regions = [p, q].map((pupil) => {
    const { centre: [x, y], halfU } = eyeCentre(pupil, ipd, pupilD, discs);
    return { kind: "eye", x, y, ax: halfU, ay: EYE_V * ipd, angle, pupil };
  });
  if (report.face === "human") {
    const mx = (p[0] + q[0]) / 2 + (MOUTH_U * u[0] + MOUTH_V * v[0]) * ipd;
    const my = (p[1] + q[1]) / 2 + (MOUTH_U * u[1] + MOUTH_V * v[1]) * ipd;
    regions.push({ kind: "mouth", x: mx, y: my, ax: MOUTH_HALF_U * ipd, ay: MOUTH_HALF_V * ipd, angle });
  }
  return regions;
}

// Is layout mm (x, y) inside the region (grown by margin mm)?
export function inRegion(region, x, y, margin = 0) {
  if (region.poly) {
    const b = region.box;
    if (x < b.x0 - margin || x > b.x1 + margin || y < b.y0 - margin || y > b.y1 + margin) return false;
    return insidePolygon([x, y], region.poly) || (margin > 0 && polylineDistance([x, y], region.poly, true) <= margin);
  }
  const c = Math.cos(region.angle), s = Math.sin(region.angle);
  const dx = x - region.x, dy = y - region.y;
  const a = (dx * c + dy * s) / (region.ax + margin), b = (-dx * s + dy * c) / (region.ay + margin);
  return a * a + b * b <= 1;
}

// Regions that keep areas, the outline, brows and settling stones out (every region but the nose).
export const inAnyRegion = (regions, x, y, margin = 0) => regions.some((r) => r.blocksArea !== false && inRegion(r, x, y, margin));

// Regions that keep the map's lines out: a polygon region grown by its own lineMarginMm (the AI's
// lashes, lid and lip strokes, nose line are the features' job), a pupil region by margin.
export const blocksLine = (regions, x, y, margin = 0) => regions.some((r) => inRegion(r, x, y, r.poly ? r.lineMarginMm : margin));

// --- Landmark faces (build 3) --------------------------------------------------------------------
//
// Face Mesh V2 indices and the polygon helpers are taken from the exp-faces experiment (branch
// exp-faces, src/pipeline/faces.js at 6ea392b): each eye's opening contour (corner, lower lid,
// corner, upper lid), its iris centre and rim; the lips' outer and inner chains from the left corner
// to the right one. New here: the brows (upper and lower edge, outer to inner), the nose, the face
// oval, the almond fit of the eyes and the regions.
export const MESH = Object.freeze({
  eyes: [
    { contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246], iris: 468, rim: [469, 470, 471, 472],
      brow: { upper: [70, 63, 105, 66, 107], lower: [46, 53, 52, 65, 55] } },
    { contour: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398], iris: 473, rim: [474, 475, 476, 477],
      brow: { upper: [300, 293, 334, 296, 336], lower: [276, 283, 282, 295, 285] } }
  ],
  upperOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  lowerOuter: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  upperInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  lowerInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
  nose: { bridge: 6, tip: 1, base: 2, alae: [98, 327] },
  cheeks: [50, 280, 101, 330, 205, 425],
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
});

// The AI's pupil (the service's report.pupilsAtMm) within PUPIL_SNAP iris radii (at least
// PUPIL_SNAP_MIN_MM) of a landmark iris centre is the eye's centre, and the whole eye moves with
// it: the landmarks of a stone drawing can be a few mm off, the service's pupils are where the AI
// drew them (exp-faces).
export const PUPIL_SNAP = 1.5;
export const PUPIL_SNAP_MIN_MM = 1.5;
// A mouth is open when its inner lips are this far apart at the centre (and this share of its width).
export const OPEN_MOUTH_MM = 1.0;
export const OPEN_MOUTH_SHARE = 0.08;
// Samples along each fitted eye curve (corner to corner).
export const EYE_SAMPLES = 24;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

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

export const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
export const boxOf = (poly, margin = 0) => ({
  x0: Math.min(...poly.map((p) => p[0])) - margin, x1: Math.max(...poly.map((p) => p[0])) + margin,
  y0: Math.min(...poly.map((p) => p[1])) - margin, y1: Math.max(...poly.map((p) => p[1])) + margin
});

// A polyline moved by `by` mm along its normal, to the side of `towards` (a unit vector).
export function offsetLine(line, by, towards) {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (nx * towards[0] + ny * towards[1] < 0) { nx = -nx; ny = -ny; }
    return [p[0] + by * nx, p[1] + by * ny];
  });
}

// A closed polygon grown by `by` mm (each vertex moved away from the centroid along its normal).
function growPolygon(poly, by) {
  const c = centroid(poly);
  return poly.map((p, i) => {
    const a = poly[(i - 1 + poly.length) % poly.length], b = poly[(i + 1) % poly.length];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if ((p[0] - c[0]) * nx + (p[1] - c[1]) * ny < 0) { nx = -nx; ny = -ny; }
    return [p[0] + by * nx, p[1] + by * ny];
  });
}

// An eye's lids as an almond: in the frame of its corners (s along corner A -> B, t across, positive
// downwards), each lid is t(s) = s (w - s) (a + b (s - w / 2)) / w^2 fitted to its landmarks (least
// squares), so both lids meet at the corners and bulge smoothly, the bulge free to lean to one end;
// the upper lid is kept above the corner line and the lower below.
function fitLid(local, w) {
  const f = (s) => [s * (w - s) / (w * w), s * (w - s) * (s - w / 2) / (w * w * w)];
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const [s, t] of local) {
    const [f1, f2] = f(s);
    a11 += f1 * f1; a12 += f1 * f2; a22 += f2 * f2; b1 += f1 * t; b2 += f2 * t;
  }
  const det = a11 * a22 - a12 * a12;
  const [a, b] = Math.abs(det) > 1e-12 ? [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det] : [a11 ? b1 / a11 : 0, 0];
  return (s) => { const [f1, f2] = f(s); return a * f1 + b * f2; };
}

function eyeGeometry(points, m, frame, pupils) {
  const contour = m.contour.map((i) => points[i]);
  const A = contour[0], B = contour[8];
  const w = dist(A, B);
  const e = [(B[0] - A[0]) / w, (B[1] - A[1]) / w];
  let n = [-e[1], e[0]];
  if (dot(n, frame.v) < 0) n = [-n[0], -n[1]];
  const local = (p) => [dot([p[0] - A[0], p[1] - A[1]], e), dot([p[0] - A[0], p[1] - A[1]], n)];
  let upperPts = contour.slice(9).map(local), lowerPts = contour.slice(1, 8).map(local);
  const meanT = (pts) => pts.reduce((s, p) => s + p[1], 0) / pts.length;
  if (meanT(upperPts) > meanT(lowerPts)) [upperPts, lowerPts] = [lowerPts, upperPts];
  const up = fitLid(upperPts, w), low = fitLid(lowerPts, w);
  const at = (s, t) => [A[0] + s * e[0] + t * n[0], A[1] + s * e[1] + t * n[1]];
  const samples = Array.from({ length: EYE_SAMPLES + 1 }, (_, k) => (w * k) / EYE_SAMPLES);
  let upper = samples.map((s) => at(s, Math.min(0, up(s))));
  let lower = samples.map((s) => at(s, Math.max(0, low(s))));
  let c = points[m.iris];
  const r = m.rim.reduce((sum, i) => sum + dist(points[i], c), 0) / m.rim.length;
  // Snap to the service's pupil.
  const reach = Math.max(PUPIL_SNAP_MIN_MM, PUPIL_SNAP * r);
  const near = pupils.map((p) => [p, dist(p, c)]).filter(([, d]) => d <= reach).sort((a, b) => a[1] - b[1])[0];
  let snapMm = null, delta = [0, 0];
  if (near) {
    delta = [near[0][0] - c[0], near[0][1] - c[1]];
    snapMm = near[1];
    c = [near[0][0], near[0][1]];
  }
  const move = (pts) => pts.map(([x, y]) => [x + delta[0], y + delta[1]]);
  upper = move(upper); lower = move(lower);
  const heightMm = Math.max(...samples.map((s) => Math.max(0, low(s)) - Math.min(0, up(s))));
  return {
    corners: [upper[0], upper[upper.length - 1]], axis: e, normal: n, widthMm: w, heightMm,
    upper, lower, opening: [...upper, ...lower.slice(1, -1).reverse()],
    iris: { c, r }, snapMm, brow: m.brow
  };
}

// 478 landmarks [x, y] (layout mm) + the service's pupils -> the face's geometry:
// { points, ipd, u, v (unit vectors: left to right between the irises, and downwards), eyes (left
// to right in the image; each { corners, outer (index of the outer corner), axis, normal, widthMm,
// heightMm, upper, lower (polylines corner to corner), opening (polygon), iris { c, r }, snapMm,
// brow }), lips { upperOuter, lowerOuter, upperInner, lowerInner, outer, upper, lower (polygons),
// line, open, opening, gapMm, widthMm }, nose { bridge, tip, base, alae }, oval, cheeks }.
export function faceGeometry(points, { pupils = [] } = {}) {
  let [i0, i1] = [MESH.eyes[0].iris, MESH.eyes[1].iris];
  let order = [0, 1];
  if (points[i1][0] < points[i0][0]) { order = [1, 0]; [i0, i1] = [i1, i0]; }
  const ipd = dist(points[i0], points[i1]);
  const u = [(points[i1][0] - points[i0][0]) / ipd, (points[i1][1] - points[i0][1]) / ipd];
  const frame = { u, v: [-u[1], u[0]] };
  const eyes = order.map((k) => eyeGeometry(points, MESH.eyes[k], frame, pupils));
  eyes.forEach((eye, k) => {
    const other = eyes[1 - k].iris.c;
    eye.outer = dist(eye.corners[0], other) > dist(eye.corners[1], other) ? 0 : 1;
  });
  const at = (ids) => ids.map((i) => points[i]);
  let [upperOuter, lowerOuter, upperInner, lowerInner] = [MESH.upperOuter, MESH.lowerOuter, MESH.upperInner, MESH.lowerInner].map(at);
  if (dot([upperOuter[upperOuter.length - 1][0] - upperOuter[0][0], upperOuter[upperOuter.length - 1][1] - upperOuter[0][1]], u) < 0) {
    [upperOuter, lowerOuter, upperInner, lowerInner] = [upperOuter, lowerOuter, upperInner, lowerInner].map((l) => l.slice().reverse());
  }
  const widthMm = dist(upperOuter[0], upperOuter[upperOuter.length - 1]);
  const gapMm = dist(points[13], points[14]);
  const open = gapMm >= Math.max(OPEN_MOUTH_MM, OPEN_MOUTH_SHARE * widthMm);
  const nose = MESH.nose;
  const alae = nose.alae.map((i) => points[i]).sort((a, b) => dot(a, u) - dot(b, u));
  return {
    points, ipd, u, v: frame.v, eyes,
    lips: {
      upperOuter, lowerOuter, upperInner, lowerInner,
      upper: [...upperOuter, ...upperInner.slice().reverse()],
      lower: [...lowerOuter, ...lowerInner.slice().reverse()],
      outer: [...upperOuter, ...lowerOuter.slice(1, -1).reverse()],
      line: upperInner.map((p, i) => [(p[0] + lowerInner[i][0]) / 2, (p[1] + lowerInner[i][1]) / 2]),
      open, opening: open ? [...upperInner, ...lowerInner.slice(1, -1).reverse()] : null, gapMm, widthMm
    },
    nose: { bridge: points[nose.bridge], tip: points[nose.tip], base: points[nose.base], alae },
    oval: at(MESH.oval),
    cheeks: at(MESH.cheeks)
  };
}

// Feature designs by size (build 4, concept section 5): most eyes on the family photos are 6 to 10 mm
// wide, too small for the concept's full eye. By the eye's width (corner to corner):
//   "full"   FULL_EYE_MM or more: the concept's full eye (features.js);
//   "simple" SIMPLE_EYE_MM or more: Jet pupil, one Crystal white on each side, an SS4 Jet upper lid;
//   "kept"   smaller: the AI's own eye stones (today's), cleaned (place.js), in a pupil region.
// Both eyes of a face get one design, the smaller eye's (both eyes use a similar size).
// The mouth by its width (corner to corner): "full" from FULL_MOUTH_MM, "simple" (a mouth line and
// one lip tone, no outline) from SIMPLE_MOUTH_MM, else "kept"; "line" (the mouth line only) when
// hair or beard tones lie where the lips would go (lipsUnderHair, map.js), for full and simple mouths.
export const FULL_EYE_MM = 10;
export const SIMPLE_EYE_MM = 6;
export const FULL_MOUTH_MM = 14;
export const SIMPLE_MOUTH_MM = 7;

export function eyeDesign(face) {
  const w = Math.min(...face.eyes.map((e) => e.widthMm));
  return w >= FULL_EYE_MM ? "full" : w >= SIMPLE_EYE_MM ? "simple" : "kept";
}

export function mouthDesign(face) {
  const w = face.lips.widthMm;
  const bySize = w >= FULL_MOUTH_MM ? "full" : w >= SIMPLE_MOUTH_MM ? "simple" : "kept";
  return bySize !== "kept" && face.lips.underHair ? "line" : bySize;
}

// Around the mouth line, the region of a "line" mouth (the hair's area runs on beside it).
export const MOUTH_LINE_REGION_MM = 1.2;

// Where the feature chains run (features.js uses the same paths): the lids, LID_OFFSET of their
// stone's radius outside the eye's curves (a whole radius on an eye lower than SMALL_EYE_MM, so its
// opening keeps room for the white), and the lip outline likewise outside the lips.
export const LID_OFFSET = 0.5;
export const SMALL_EYE_MM = 6;
export const SS4_D = 1.5;
export const SS6_D = 2;
export const lowerLidD = (eyes) => (Math.min(...eyes.map((e) => e.widthMm)) >= 18 ? SS6_D : SS4_D);
export const lipOutlineD = (lips) => (lips.widthMm >= 35 ? SS6_D : SS4_D);

export function lidPaths(eye, lowerD, upperD = SS6_D) {
  const up = [-eye.normal[0], -eye.normal[1]];
  const share = eye.heightMm < SMALL_EYE_MM ? 1 : LID_OFFSET;
  return {
    upper: offsetLine(eye.upper, share * upperD / 2, up),
    lower: offsetLine(eye.lower, share * lowerD / 2, eye.normal)
  };
}

export const lipOutlinePath = (lips) => growPolygon(lips.outer, LID_OFFSET * lipOutlineD(lips) / 2);

const polyRegion = (kind, poly, lineMarginMm, blocksArea, extra = {}) => {
  const [x, y] = centroid(poly);
  return { kind, poly, box: boxOf(poly), x, y, ax: Math.max(...poly.map((p) => dist(p, [x, y]))), ay: 0, angle: 0, lineMarginMm, blocksArea, ...extra };
};

// The polygon regions of a landmark face, by its designs: a full eye the path of its lid chains; a
// simple eye its upper lid chain's path and the lower lid's curve LOWER_ROOM_MM further down (room
// for the pupil, whose skin the area fills beyond); a kept eye a pupil region (an ellipse around it,
// today's stones kept, keep: true). The mouth: full and simple the path of the outline chain; line a
// band of MOUTH_LINE_REGION_MM around the mouth line; kept an ellipse around the lips (today's stones
// kept). The nose (bridge, alae and base, grown by a little).
export const LOWER_ROOM_MM = 0.4;

export function landmarkRegions(face) {
  const out = [];
  const lowerD = lowerLidD(face.eyes);
  const eyes = eyeDesign(face), mouth = mouthDesign(face);
  for (const eye of face.eyes) {
    if (eyes === "kept") {
      const angle = Math.atan2(eye.axis[1], eye.axis[0]);
      const [x, y] = centroid(eye.opening);
      out.push({ kind: "eye", x, y, ax: eye.widthMm / 2 + 1.5, ay: eye.heightMm / 2 + 1.5, angle, pupil: eye.iris.c, small: true, keep: true, design: "kept" });
      continue;
    }
    if (eyes === "simple") {
      const { upper } = lidPaths(eye, SS4_D, SS4_D);
      const lower = offsetLine(eye.lower, LOWER_ROOM_MM, eye.normal);
      out.push(polyRegion("eye", [...upper, ...lower.slice(1, -1).reverse()], 2.0, true, { pupil: eye.iris.c, design: "simple" }));
      continue;
    }
    const { upper, lower } = lidPaths(eye, lowerD);
    out.push(polyRegion("eye", [...upper, ...lower.slice(1, -1).reverse()], 2.5, true, { pupil: eye.iris.c, design: "full" }));
  }
  const lips = face.lips;
  if (mouth === "kept") {
    const angle = Math.atan2(face.u[1], face.u[0]);
    const [x, y] = centroid(lips.outer);
    const h = Math.max(...lips.outer.map((p) => Math.abs((p[0] - x) * face.v[0] + (p[1] - y) * face.v[1])));
    out.push({ kind: "mouth", x, y, ax: lips.widthMm / 2 + 1.0, ay: h + 1.0, angle, keep: true, design: "kept" });
  } else if (mouth === "line") {
    const r = MOUTH_LINE_REGION_MM;
    out.push(polyRegion("mouth", [...offsetLine(lips.line, r, [-face.v[0], -face.v[1]]), ...offsetLine(lips.line, r, face.v).reverse()], 1.0, true, { design: "line" }));
  } else {
    out.push(polyRegion("mouth", lipOutlinePath(lips), 1.5, true, { design: mouth }));
  }
  const { bridge, alae, base, tip } = face.nose;
  const side = face.u.map((c) => c * 0.12 * face.ipd);
  const nose = [[bridge[0] - side[0], bridge[1] - side[1]], [bridge[0] + side[0], bridge[1] + side[1]], alae[1], base, alae[0]];
  out.push(polyRegion("nose", growPolygon(nose, 1.0), 0.8, false, { tip }));
  return out;
}
