import { STONE_COLORS } from "../stones/StoneColors.js";
import { getStoneSize } from "../stones/StoneSizes.js";
import { MIN_GAP_MM } from "./tiers.js";

// Holes (experiment exp-holes, docs/exp-holes.md; off in production). A hole is a spot inside the
// subject where an SS6 stone, or failing that an SS4 stone, fits with at least MIN_GAP_MM (0.1 mm)
// to every stone. The subject is the AI image's alpha mask (alpha >= 128) with small gaps closed: a
// closing with a disc of CLOSE_MM across, then every enclosed transparent area of at most
// ENCLOSED_MAX_MM2 filled.
//
// findHoles() counts them on a grid of GRID_PX_PER_MM in the layout's own mm (the /layout answer's
// stones; AI pixel = (mm + report.offsetMm) / report.mmPerPx): greedily, the free spot farthest
// from everything first, SS6 while one fits, then SS4. The clearance to the stones is exact; to the
// subject's edge it is measured on the grid. fillHoles() places a stone in every hole so found and
// gives it its neighbours' colour (neighbourVote): the colour with the largest weight among the
// stones within VOTE_MM of its edge, each weighing 1 - gap / VOTE_MM, so nearer stones count more; on
// a tie the nearest stone's colour. A hole sits between stones, where the AI painted its gaps, so its
// own pixels say little (dark-spot fix, docs/exp-holes.md section 9). With colours: "pixels" (tools
// only) it reads them instead, as the strass service colours its own fill stones (sample_delivered):
// the mean CIE Lab of the AI pixels (alpha >= 128) within the inner SAMPLE_SHARE of the stone's
// radius, snapped to the catalogue by the service's snap_colours rules (palette PLUS_REAL_SKIN).

export const GRID_PX_PER_MM = 20;
export const CLOSE_MM = 1.0;
export const ENCLOSED_MAX_MM2 = 2 * Math.PI; // two SS6 stones
export const SAMPLE_SHARE = 0.6;
export const FILL_SIZE_IDS = Object.freeze(["ss6", "ss4"]);
// Clearances beyond this are not told apart (only the order of the fill and the largest empty
// circle above 2 * CLEARANCE_CAP_MM depend on it).
export const CLEARANCE_CAP_MM = 4;
export const VOTE_MM = 1.0;

const GAP = MIN_GAP_MM;
const EPS = 1e-9;
const BLOCK = 64;

// --- Colour (as services/strass/strass_layout/colour.py) -------------------------------------

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

// sRGB 0..255 -> CIE Lab (D65), as skimage's rgb2lab.
export function srgbToLab(r8, g8, b8) {
  const r = lin(r8 / 255), g = lin(g8 / 255), b = lin(b8 / 255);
  const x = (0.412453 * r + 0.357580 * g + 0.180423 * b) / 0.95047;
  const y = 0.212671 * r + 0.715160 * g + 0.072169 * b;
  const z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.08883;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// CIE ΔE2000, kL = kC = kH = 1.
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = C2p === 0 ? 0 : (deg(Math.atan2(b2, a2p)) + 360) % 360;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
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
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  const dL = (L2 - L1) / Sl, dC = (C2p - C1p) / Sc, dH = dHp / Sh;
  return Math.sqrt(dL * dL + dC * dC + dH * dH + Rt * dC * dH);
}

export const PALETTE = Object.entries(STONE_COLORS).map(([id, c]) => {
  const h = c.fill.replace(/^#/, "");
  const lab = srgbToLab(...[0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
  return { id, lab, chroma: Math.hypot(lab[1], lab[2]) };
});
const WARM_BLOCK = new Set(["indian-siam"]);
const NO_LOW_HUE = new Set(["gold", "citrine", "peridot"]);

// The catalogue id for a Lab colour by snap_colours (palette PLUS_REAL_SKIN: every catalogue colour,
// real fills, Indian Siam blocked for warm tones of hue 30 degrees or more).
export function snapColour(lab) {
  const chroma = Math.hypot(lab[1], lab[2]);
  const hue = (deg(Math.atan2(lab[2], lab[1])) % 360 + 360) % 360;
  const warm = hue >= 25 && hue <= 78 && chroma < 65 && chroma > 8;
  let best = null, bestD = Infinity;
  for (const p of PALETTE) {
    let d = deltaE2000(lab, p.lab);
    if (chroma >= 18 && p.chroma < 8) d += 1000;
    if (!warm) d += 0.5 * Math.max(0, 0.9 * chroma - p.chroma);
    if (warm && p.chroma < 8) d += 1000;
    if (NO_LOW_HUE.has(p.id) && hue < 80 && chroma > 8) d += 1000;
    if (p.id === "topaz" && warm && chroma < 50) d += 1000;
    if (WARM_BLOCK.has(p.id) && warm && hue >= 30) d += 1000;
    if (p.id === "hyacinth" && chroma < 60) d += 1000;
    if (d < bestD) { bestD = d; best = p.id; }
  }
  return best;
}

// The Lab colour of a stone of diameter dMm at AI pixel (cx, cy) (pixel-index coordinates, as the
// service's), from its inner SAMPLE_SHARE: stone_colours with mean on.
export function sampleLab(ai, cx, cy, dMm, mmPerPx) {
  const { data, width, height } = ai;
  const r = SAMPLE_SHARE * 0.5 * dMm / mmPerPx;
  const pixels = (radius, opaque) => {
    const out = [];
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
        if (Math.hypot(y - cy, x - cx) > radius) continue;
        const p = (y * width + x) * 4;
        if (opaque && data[p + 3] < 128) continue;
        out.push(srgbToLab(data[p], data[p + 1], data[p + 2]));
      }
    }
    return out;
  };
  const disc = pixels(Math.max(2, r), true);
  if (disc.length >= 3) return [0, 1, 2].map((k) => disc.reduce((s, v) => s + v[k], 0) / disc.length);
  // Fallback of stone_colours: the median of the darker 85 % of the core.
  const R = Math.max(2, 0.65 * r);
  let px = pixels(R, true);
  if (px.length < 3) px = pixels(R, false);
  if (!px.length) return [50, 0, 0];
  const Ls = px.map((v) => v[0]).sort((a, b) => a - b);
  const q = quantile(Ls, 0.85);
  const kept = px.filter((v) => v[0] <= q);
  const use = kept.length >= 3 ? kept : px;
  return [0, 1, 2].map((k) => median(use.map((v) => v[k])));
}

// The mean CIE L* of the AI pixels composited on white within the inner SAMPLE_SHARE of a stone of
// diameter dMm at AI pixel (cx, cy) (pixel-index coordinates); at least 2 px of radius, as the
// service reads colours. A stone with no pixel there (beyond the image's edge) reads the nearest one.
export function lightnessOnWhite(ai, cx, cy, dMm, mmPerPx) {
  const { data, width, height } = ai;
  const radius = Math.max(2, SAMPLE_SHARE * 0.5 * dMm / mmPerPx);
  const onWhite = (p) => {
    const a = data[p + 3] / 255;
    return srgbToLab(...[0, 1, 2].map((k) => data[p + k] * a + 255 * (1 - a)))[0];
  };
  let sum = 0, n = 0;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
      if (Math.hypot(y - cy, x - cx) > radius) continue;
      sum += onWhite((y * width + x) * 4);
      n++;
    }
  }
  if (n) return sum / n;
  const x = Math.round(Math.min(Math.max(cx, 0), width - 1)), y = Math.round(Math.min(Math.max(cy, 0), height - 1));
  return onWhite((y * width + x) * 4);
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

// --- Subject mask ---------------------------------------------------------------------------

// Squared Euclidean distance transform (Felzenszwalb and Huttenlocher): out[i] = squared distance
// from pixel i to the nearest pixel with feature[i] set (Infinity if there is none).
export function squaredEdt(feature, w, h) {
  const BIG = 1e20;
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = feature[i] ? 0 : BIG;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len, base, step) => {
    for (let q = 0; q < len; q++) f[q] = out[base + q * step];
    let k = 0;
    v[0] = 0; z[0] = -BIG; z[1] = BIG;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
    for (let q = 0; q < len; q++) out[base + q * step] = d[q];
  };
  for (let x = 0; x < w; x++) pass(h, x, w);
  for (let y = 0; y < h; y++) pass(w, y * w, 1);
  for (let i = 0; i < w * h; i++) if (out[i] >= BIG / 2) out[i] = Infinity;
  return out;
}

// The subject at AI pixels: Uint8Array (1 = subject) of width x height.
export function subjectMask(ai, mmPerPx) {
  const { data, width: w, height: h } = ai;
  const n = w * h;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  // Closing with a disc of CLOSE_MM across.
  const r2 = (CLOSE_MM / 2 / mmPerPx) ** 2;
  const toSubject = squaredEdt(m, w, h);
  const dilated = new Uint8Array(n);
  for (let i = 0; i < n; i++) dilated[i] = toSubject[i] <= r2 ? 1 : 0;
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = dilated[i] ? 0 : 1;
  const toOutside = squaredEdt(outside, w, h);
  const closed = new Uint8Array(n);
  for (let i = 0; i < n; i++) closed[i] = toOutside[i] > r2 ? 1 : 0;
  // Enclosed transparent areas (not reached from the border, 4-connected) of at most ENCLOSED_MAX_MM2.
  const maxPx = ENCLOSED_MAX_MM2 / (mmPerPx * mmPerPx);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const flood = (start) => {
    const members = [];
    let top = 0, border = false;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      members.push(i);
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !closed[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    return { members, border };
  };
  for (let i = 0; i < n; i++) {
    if (closed[i] || seen[i]) continue;
    const { members, border } = flood(i);
    if (!border && members.length <= maxPx) for (const j of members) closed[j] = 1;
  }
  return closed;
}

// --- Holes ----------------------------------------------------------------------------------

// The grid over the subject in layout mm: { ppmm, x0, y0, w, h, maskClear } where grid pixel (i, j)
// has its centre at layout mm (x0 + (i + 0.5) / ppmm, y0 + (j + 0.5) / ppmm), and maskClear is the
// distance (mm) from that centre to the nearest grid pixel outside the subject (0 outside).
function subjectGrid(ai, report, ppmm = GRID_PX_PER_MM) {
  const s = Number(report.mmPerPx);
  const [ox, oy] = report.offsetMm;
  const mask = subjectMask(ai, s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, area = 0;
  for (let y = 0; y < ai.height; y++) {
    for (let x = 0; x < ai.width; x++) {
      if (!mask[y * ai.width + x]) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const x0 = (minX - 1) * s - ox, y0 = (minY - 1) * s - oy;
  const w = Math.ceil((maxX - minX + 3) * s * ppmm), h = Math.ceil((maxY - minY + 3) * s * ppmm);
  const inside = new Uint8Array(w * h);
  const outside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const py = Math.round((y0 + (j + 0.5) / ppmm + oy) / s);
    for (let i = 0; i < w; i++) {
      const px = Math.round((x0 + (i + 0.5) / ppmm + ox) / s);
      const on = px >= 0 && py >= 0 && px < ai.width && py < ai.height && mask[py * ai.width + px];
      inside[j * w + i] = on ? 1 : 0;
      outside[j * w + i] = on ? 0 : 1;
    }
  }
  const d2 = squaredEdt(outside, w, h);
  const maskClear = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) maskClear[k] = inside[k] ? Math.sqrt(d2[k]) / ppmm : 0;
  return { ppmm, x0, y0, w, h, maskClear, subjectAreaMm2: area * s * s, mask, s, ox, oy };
}

// Clearance of every grid pixel to the stones: min over stones of (distance to centre - radius -
// extra), capped at CLEARANCE_CAP_MM.
function stoneClearance(grid, stones, extra) {
  const { ppmm, x0, y0, w, h } = grid;
  const out = new Float32Array(w * h).fill(CLEARANCE_CAP_MM);
  for (const st of stones) carve(out, grid, st.x, st.y, st.d / 2 + extra);
  return out;
}

// out = min(out, distance to (x, y) - radius) over the pixels where that is below the cap.
function carve(out, { ppmm, x0, y0, w, h }, x, y, radius) {
  const reach = radius + CLEARANCE_CAP_MM;
  const i0 = Math.max(0, Math.floor((x - reach - x0) * ppmm)), i1 = Math.min(w - 1, Math.ceil((x + reach - x0) * ppmm));
  const j0 = Math.max(0, Math.floor((y - reach - y0) * ppmm)), j1 = Math.min(h - 1, Math.ceil((y + reach - y0) * ppmm));
  for (let j = j0; j <= j1; j++) {
    const dy = y0 + (j + 0.5) / ppmm - y;
    for (let i = i0; i <= i1; i++) {
      const dx = x0 + (i + 0.5) / ppmm - x;
      const c = Math.sqrt(dx * dx + dy * dy) - radius;
      const k = j * w + i;
      if (c < out[k]) out[k] = c;
    }
  }
  return { i0, i1, j0, j1 };
}

// Spatial hash of plain stones for the exact gap test.
function stoneIndex(stones) {
  const cell = 5;
  const map = new Map();
  const add = (st) => {
    const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(st);
  };
  stones.forEach(add);
  const minGap = (x, y, d) => {
    let min = Infinity;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const o of map.get(`${gx + a},${gy + b}`) || []) min = Math.min(min, Math.hypot(o.x - x, o.y - y) - (o.d + d) / 2);
      }
    }
    return min;
  };
  return { add, minGap };
}

// The greedy hole search on plain { x, y, d } stones (layout mm). Returns { holes: [{ x, y, d,
// sizeId }], ss6, ss4, areaShare, largestEmptyMm, subjectAreaMm2, grid }.
export function findHoles(stones, ai, report) {
  const grid = subjectGrid(ai, report);
  if (!grid) return { holes: [], ss6: 0, ss4: 0, areaShare: 0, largestEmptyMm: 0, subjectAreaMm2: 0, grid: null };
  const { w, h, ppmm, x0, y0, maskClear } = grid;
  const n = w * h;
  // Largest empty circle: the subject's pixels farthest from every stone's edge and from the outside.
  const bare = stoneClearance(grid, stones, 0);
  let largest = 0, largestAt = null;
  for (let k = 0; k < n; k++) {
    const c = Math.min(maskClear[k], bare[k]);
    if (c > largest) { largest = c; largestAt = k; }
  }
  const clear = stoneClearance(grid, stones, GAP);
  for (let k = 0; k < n; k++) clear[k] = Math.min(clear[k], maskClear[k]);
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
  const blockMax = new Float32Array(bw * bh).fill(-Infinity);
  const refresh = (bi, bj) => {
    let m = -Infinity;
    for (let j = bj * BLOCK; j < Math.min(h, (bj + 1) * BLOCK); j++) {
      for (let i = bi * BLOCK; i < Math.min(w, (bi + 1) * BLOCK); i++) if (clear[j * w + i] > m) m = clear[j * w + i];
    }
    blockMax[bj * bw + bi] = m;
  };
  for (let bj = 0; bj < bh; bj++) for (let bi = 0; bi < bw; bi++) refresh(bi, bj);
  const argmax = () => {
    let b = 0;
    for (let k = 1; k < blockMax.length; k++) if (blockMax[k] > blockMax[b]) b = k;
    const bi = b % bw, bj = (b - bi) / bw;
    let best = -1, bv = -Infinity;
    for (let j = bj * BLOCK; j < Math.min(h, (bj + 1) * BLOCK); j++) {
      for (let i = bi * BLOCK; i < Math.min(w, (bi + 1) * BLOCK); i++) if (clear[j * w + i] > bv) { bv = clear[j * w + i]; best = j * w + i; }
    }
    return { k: best, value: bv };
  };
  const index = stoneIndex(stones);
  const holes = [];
  for (const sizeId of FILL_SIZE_IDS) {
    const d = getStoneSize(sizeId).diameterMm;
    for (;;) {
      const { k, value } = argmax();
      if (k < 0 || value < d / 2 - EPS) break;
      const i = k % w, j = (k - i) / w;
      const x = Math.round((x0 + (i + 0.5) / ppmm) * 1000) / 1000, y = Math.round((y0 + (j + 0.5) / ppmm) * 1000) / 1000;
      if (index.minGap(x, y, d) < GAP - EPS) {
        clear[k] = -1;
        refresh(Math.floor(i / BLOCK), Math.floor(j / BLOCK));
        continue;
      }
      const hole = { x, y, d, sizeId };
      holes.push(hole);
      index.add(hole);
      const box = carve(clear, grid, x, y, d / 2 + GAP);
      for (let bj = Math.floor(box.j0 / BLOCK); bj <= Math.floor(box.j1 / BLOCK); bj++) {
        for (let bi = Math.floor(box.i0 / BLOCK); bi <= Math.floor(box.i1 / BLOCK); bi++) refresh(bi, bj);
      }
    }
  }
  const holeArea = holes.reduce((sum, o) => sum + Math.PI * (o.d / 2) ** 2, 0);
  const li = largestAt % w, lj = (largestAt - li) / w;
  return {
    holes,
    ss6: holes.filter((o) => o.sizeId === "ss6").length,
    ss4: holes.filter((o) => o.sizeId === "ss4").length,
    areaShare: holeArea / grid.subjectAreaMm2,
    largestEmptyMm: 2 * largest,
    largestEmptyAt: largestAt == null ? null : [x0 + (li + 0.5) / ppmm, y0 + (lj + 0.5) / ppmm],
    subjectAreaMm2: grid.subjectAreaMm2,
    grid
  };
}

// Plain { x, y, d, color } stones (layout mm, after the overlap cleanup) + the AI image ({ data,
// width, height } RGBA) + the layout's report -> { stones (the given ones, then one per hole),
// added, before (findHoles' numbers) }. colours: "neighbours" (the pipeline) or "pixels" (tools).
// A report without the frame (mmPerPx, offsetMm; every /layout answer has them) gets no fill.
export function fillHoles(stones, ai, report, { colours = "neighbours" } = {}) {
  if (!(Number(report?.mmPerPx) > 0) || !Array.isArray(report?.offsetMm)) return { stones, added: [], before: null };
  const found = findHoles(stones, ai, report);
  const s = Number(report.mmPerPx);
  const [ox, oy] = report.offsetMm;
  let added = found.holes.map(({ x, y, d }) => ({ x, y, d, color: snapColour(sampleLab(ai, (x + ox) / s, (y + oy) / s, d, s)) }));
  if (colours === "neighbours") {
    const all = [...stones, ...added];
    const voted = neighbourVote(all, new Set(added.map((_, k) => stones.length + k)), (st) => st.color);
    added = added.map((st, k) => ({ ...st, color: voted.get(stones.length + k) }));
  }
  return { stones: [...stones, ...added], added, before: found };
}

// Colours by the neighbour vote for the stones at the indices in targets (a Set) of plain { x, y, d }
// stones; colourOf(stone, index) gives the others' colours. Targets are decided in rounds: a target
// with a decided stone within VOTE_MM of its edge takes the colour with the largest summed weight (1 -
// gap / VOTE_MM) among them, on a tie the nearest one's; the round's results vote in the next round
// (holes next to holes). A target with no decided stone within reach after that takes the nearest
// decided stone's colour. Returns Map(index -> colour).
export function neighbourVote(stones, targets, colourOf) {
  const cell = 5;
  const grid = new Map();
  stones.forEach((st, i) => {
    const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const colour = new Map();
  stones.forEach((st, i) => { if (!targets.has(i)) colour.set(i, colourOf(st, i)); });
  const out = new Map();
  let open = [...targets];
  const gapOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) - (a.d + b.d) / 2;
  const near = (i, reach) => {
    const st = stones[i], r = Math.ceil((reach + 4) / cell);
    const gx = Math.floor(st.x / cell), gy = Math.floor(st.y / cell);
    const found = [];
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) || []) {
        if (j === i || !colour.has(j)) continue;
        const gap = gapOf(st, stones[j]);
        if (gap < reach) found.push({ j, gap });
      }
    }
    return found;
  };
  while (open.length) {
    const decided = [];
    const still = [];
    for (const i of open) {
      const voters = near(i, VOTE_MM);
      if (!voters.length) { still.push(i); continue; }
      const weight = new Map();
      for (const { j, gap } of voters) weight.set(colour.get(j), (weight.get(colour.get(j)) || 0) + 1 - Math.max(0, gap) / VOTE_MM);
      const top = Math.max(...weight.values());
      const tied = new Set([...weight].filter(([, w]) => w >= top - 1e-9).map(([c]) => c));
      const nearest = voters.filter((v) => tied.has(colour.get(v.j))).sort((p, q) => p.gap - q.gap || p.j - q.j)[0];
      decided.push([i, colour.get(nearest.j)]);
    }
    if (!decided.length) {
      // Nothing decided within reach: the nearest decided stone anywhere.
      for (const i of still) {
        let best = null;
        colour.forEach((c, j) => {
          const gap = gapOf(stones[i], stones[j]);
          if (!best || gap < best.gap) best = { gap, c };
        });
        out.set(i, best ? best.c : colourOf(stones[i], i));
      }
      break;
    }
    for (const [i, c] of decided) { colour.set(i, c); out.set(i, c); }
    open = still;
  }
  return out;
}
