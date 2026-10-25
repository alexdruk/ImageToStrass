// Face regions of the engine's build 1 (exp-engine, docs/exp-engine.md section 3): the eyes and
// the mouth, where the engine keeps today's stones unchanged (features come in build 2, concept
// section 5). They come from the layout service's report alone: its two pupils (report.pupilsAtMm,
// when report.face is set and there are exactly two) give the face's scale and direction. Each
// region is an ellipse in units of the pupil distance (IPD), on the axis through the pupils (u, left
// to right) and its normal (v, downwards):
//
//   eye:   centred on each eye's opening (eyeCentre below), half-axes EYE_U x EYE_V;
//   mouth: people only (report.face "human"), centred MOUTH_V below the pupils' midpoint, half-axes
//          MOUTH_HALF_U x MOUTH_HALF_V.
//
// The sizes cover the eye corners and lids and the lips' corners, top and bottom measured with
// MediaPipe face landmarks on the saved AI images of exp-faces (27 human faces in three styles and
// the RS portraits): eye corners at -0.30 ... +0.34 IPD from the pupil, lids at -0.15 ... +0.18;
// lips at -0.57 ... +0.67 across and +0.68 ... +1.54 below the pupil line. An animal (report.face
// "animal") gets its two eye regions, no mouth.

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

// layout report (+ the map's discs, { x, y, d, lab }) -> [{ kind: "eye" | "mouth", x, y, ax, ay,
// angle, pupil }] in layout mm (angle: of the ellipse's ax axis, radians; pupil: [x, y] of an eye).
export function faceRegions(report, discs = []) {
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
  const c = Math.cos(region.angle), s = Math.sin(region.angle);
  const dx = x - region.x, dy = y - region.y;
  const a = (dx * c + dy * s) / (region.ax + margin), b = (-dx * s + dy * c) / (region.ay + margin);
  return a * a + b * b <= 1;
}

export const inAnyRegion = (regions, x, y, margin = 0) => regions.some((r) => inRegion(r, x, y, margin));
