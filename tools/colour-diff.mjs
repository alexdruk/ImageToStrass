// Colour measurement helpers for the IS-05b diagnosis (tools only, never used by the app):
// sRGB -> CIE Lab (D65, as skimage's rgb2lab), CIE ΔE2000 (Sharma, Wu and Dalal 2005, kL = kC =
// kH = 1), and the mean Lab colour of a disc of an RGBA image.

const D65 = [0.95047, 1.0, 1.08883];

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

// [r, g, b] in 0..255 -> [L, a, b].
export function srgbToLab([r8, g8, b8]) {
  const r = lin(r8 / 255), g = lin(g8 / 255), b = lin(b8 / 255);
  const x = (0.412453 * r + 0.357580 * g + 0.180423 * b) / D65[0];
  const y = (0.212671 * r + 0.715160 * g + 0.072169 * b) / D65[1];
  const z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / D65[2];
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex) {
  const h = hex.replace(/^#/, "");
  return srgbToLab([0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
}

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = C2p === 0 ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hpm = (h1p + h2p) / 2;
    else hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hpm - 30)) + 0.24 * Math.cos(rad(2 * hpm)) + 0.32 * Math.cos(rad(3 * hpm + 6)) -
    0.2 * Math.cos(rad(4 * hpm - 63));
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// Mean Lab of the pixels of an RGBA image ({ data, width, height }) whose centre lies within r px
// of (cx, cy) and whose alpha is at least minAlpha (0..255). null when no pixel qualifies.
export function discLab({ data, width, height }, cx, cy, r, minAlpha = 128) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const p = (y * width + x) * 4;
      if (data[p + 3] < minAlpha) continue;
      const lab = srgbToLab([data[p], data[p + 1], data[p + 2]]);
      sum[0] += lab[0]; sum[1] += lab[1]; sum[2] += lab[2];
      n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
