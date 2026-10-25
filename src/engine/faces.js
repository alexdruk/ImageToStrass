// Face regions of the engine's build 1 (exp-engine, docs/exp-engine.md section 3): the eyes and
// the mouth, where the engine keeps today's stones unchanged (features come in build 2, concept
// section 5). They come from the layout service's report alone: its two pupils (report.pupilsAtMm,
// when report.face is set and there are exactly two) give the face's scale and direction. Each
// region is an ellipse in units of the pupil distance (IPD), on the axis through the pupils (u, left
// to right) and its normal (v, downwards):
//
//   eye:   centred on each pupil, half-axes EYE_U x EYE_V;
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

// layout report -> [{ kind: "eye" | "mouth", x, y, ax, ay, angle }] in layout mm (angle: of the
// ellipse's ax axis, radians).
export function faceRegions(report) {
  if (!report || report.face == null || !Array.isArray(report.pupilsAtMm) || report.pupilsAtMm.length !== 2) return [];
  const [p, q] = [...report.pupilsAtMm].sort((a, b) => a[0] - b[0]);
  const ipd = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (!(ipd > 0)) return [];
  const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const u = [Math.cos(angle), Math.sin(angle)], v = [-u[1], u[0]];
  const regions = [p, q].map(([x, y]) => ({ kind: "eye", x, y, ax: EYE_U * ipd, ay: EYE_V * ipd, angle }));
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
