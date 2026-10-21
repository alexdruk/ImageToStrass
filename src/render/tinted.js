import { createCanvas } from "@napi-rs/canvas";
import { getCrystalAppearance } from "../stones/CrystalAppearance.js";
import { adjustBrightness, drawCrystalStone } from "../stones/CrystalStoneRenderer.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { getStoneSize } from "../stones/StoneSizes.js";

// The tinted view (spec section 8, D4). It reads the final StoneLayout and never changes it.
//   1. The canvas is the stones' box plus a margin of MARGIN_STONES main-stone diameters.
//   2. A pixel takes the colour of its nearest stone, measured to the stone's edge (distance to
//      the centre minus the radius),
//   3. that is the gap colour of the stone's catalogue fill (gapRgb: darker by a CIE L* step that
//      grows with the fill's lightness, at least lightMinStep for near-white fills; lighter for
//      very dark fills),
//   4. but only if the pixel lies within FILL_MARGIN_MM of that stone's edge, the same margin for
//      every size; elsewhere the background shows (white in the app, transparent in the PNG file).
//   5. The stones are drawn on top with the RS faceted crystal renderer (drawStone: a stone above
//      SS6 with a rim lighter than its fill, i.e. a large Jet stone, gets an SS6 stone's rim width),
//   6. then each stone's lightness is brought to its catalogue fill's L* in two zones (the pixels
//      whose centre lies inside its disc): first the inner INNER_SHARE of the radius (where the
//      renderer puts its highlight) to a mean within STONE_LIGHTNESS.inner, then the whole stone to
//      a mean within STONE_LIGHTNESS.whole, by changing the uniform whole stone when that keeps the
//      inner zone within its tolerance, else only outside the inner zone. A zone too light is
//      darkened (its linear RGB scaled down), one too dark is lightened (screened towards white),
//      so the facets, highlights and sparkle keep their relative contrast; the change fades out
//      over a ring of RAMP_SHARE of the radius, so no edge shows. A stone already within both
//      tolerances is left as drawn.
//
// Nearest-stone search: a pixel can only be filled when its nearest stone's edge is at most
// FILL_MARGIN_MM away, and any stone whose edge is farther than that cannot fill it. So each stone
// writes its edge distance into the pixels within that margin (keeping the smallest), which gives
// exactly the nearest stone of every pixel that can be filled.

export const MARGIN_STONES = 2;
// Step 4 (IS-05c): the fill margin beyond a stone's edge is the one an SS6 stone had with the old
// reach of 1.6 radii, 0.6 x its 1 mm radius, for every size. With 1.6 radii a large pupil (SS20,
// r 2.35 mm) claimed a 1.4 mm ring of its own dark gap colour and sat in a wide black octagon.
export const SS6_RADIUS_MM = getStoneSize("ss6").diameterMm / 2;
export const FILL_MARGIN_MM = 0.6 * SS6_RADIUS_MM;
// Step 6 (IS-05b): the whole stone's mean L* within `whole` of the fill's, the inner zone's within
// `inner` (aims; the spec allows 3 and 5, the rest is left for 8-bit rounding). inner: null keeps
// only the whole-stone step (the renderer of the first IS-05b follow-up; tools only).
export const STONE_LIGHTNESS = Object.freeze({ whole: 2, inner: 4 });
export const STONE_L_TOLERANCE = STONE_LIGHTNESS.whole;
export const INNER_SHARE = 0.6;
export const RAMP_SHARE = 0.2;
// Step 3 (IS-05b, tuned against the AI images, docs/IS-05b-results.md): a fill of lightness L is
// darkened by minStep + slope * max(0, L - fromL) L*, and by at least lightMinStep when L is above
// lightAbove (near-white fills, whose gaps were hard to see); a fill darker than darkBelow is
// lightened by minStep instead.
export const GAP_RULE = Object.freeze({ minStep: 4, slope: 0.05, fromL: 80, darkBelow: 0, lightAbove: 85, lightMinStep: 8 });
export const PREVIEW_LONG_SIDE_PX = 900;
export const FULL_LONG_SIDE_PX = 2400;
export const WATERMARK_OPACITY = 0.18;

// ---- CIE L* of sRGB (D65, Y of white = 1) ----------------------------------------------------

const TO_LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8 = (lin) => {
  const c = lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.max(0, lin) ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};
// toSrgb8 by lookup: the linear value at each 8-bit rounding boundary (v + 0.5) / 255, searched.
const ROUND_AT = Float64Array.from({ length: 255 }, (_, v) => {
  const c = (v + 0.5) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb8Fast = (lin) => {
  let lo = 0, hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ROUND_AT[mid] <= lin) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
const lumOf = (r, g, b) => 0.212671 * TO_LINEAR[r] + 0.71516 * TO_LINEAR[g] + 0.072169 * TO_LINEAR[b];
export const lightnessOfY = (y) => (y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y);
// L* of Y in 1/LUT_STEPS steps, linearly interpolated (error far below 0.01 L*), for the per-pixel loops.
const LUT_STEPS = 16384;
const L_OF_Y = Float64Array.from({ length: LUT_STEPS + 2 }, (_, i) => lightnessOfY(Math.min(1, i / LUT_STEPS)));
const fastL = (y) => {
  const f = Math.max(0, Math.min(1, y)) * LUT_STEPS, i = Math.floor(f);
  return L_OF_Y[i] + (L_OF_Y[i + 1] - L_OF_Y[i]) * (f - i);
};
const yOfLightness = (l) => (l > 8 ? ((l + 16) / 116) ** 3 : (l * 27) / 24389);

function hexToRgb(hex) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function lightnessOfHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  return lightnessOfY(lumOf(r, g, b));
}

const fillOf = (color) => (STONE_COLORS[color] || STONE_COLORS.crystal).fill;

// The gap colour of a fill (step 3): its linear RGB scaled down (darker) or screened towards white
// (lighter) to the rule's target L*, so its hue is kept. [r, g, b] 0..255.
export function gapRgb(hex, rule = GAP_RULE) {
  const rgb = hexToRgb(hex);
  const lin = rgb.map((v) => TO_LINEAR[v]);
  const y = lumOf(...rgb);
  const l = lightnessOfY(y);
  const lightOf = (out) => lightnessOfY(lumOf(...out));
  if (l < rule.darkBelow) {
    const want = l + rule.minStep;
    let h = (1 - yOfLightness(want)) / (1 - y);
    let out = lin.map((c) => toSrgb8(1 - h * (1 - c)));
    // 8-bit rounding must not eat into the step.
    while (lightOf(out) < want && h > 0) out = lin.map((c) => toSrgb8(1 - (h *= 0.98) * (1 - c)));
    return out;
  }
  let step = rule.minStep + rule.slope * Math.max(0, l - rule.fromL);
  if (rule.lightAbove !== undefined && l > rule.lightAbove) step = Math.max(step, rule.lightMinStep);
  const want = Math.max(0, l - step);
  let k = y > 0 ? yOfLightness(want) / y : 0;
  let out = lin.map((c) => toSrgb8(c * k));
  while (lightOf(out) > want && k > 0) out = lin.map((c) => toSrgb8(c * (k *= 0.98)));
  return out;
}

// The most common stone diameter (SS6 in practice).
export function mainDiameterMm(stones) {
  const counts = new Map();
  for (const s of stones) counts.set(s.sizeMm, (counts.get(s.sizeMm) || 0) + 1);
  let best = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best) || (n === counts.get(best) && d < best)) best = d;
  return best;
}

// The canvas in mm: { minXmm, minYmm, widthMm, heightMm } of the stones' box plus the margin.
export function tintCanvasMm(stoneLayout) {
  const box = stoneLayout.getBoundingBox();
  const m = MARGIN_STONES * mainDiameterMm(stoneLayout.stones);
  return { minXmm: box.minXmm - m, minYmm: box.minYmm - m, widthMm: box.widthMm + 2 * m, heightMm: box.heightMm + 2 * m };
}

// The nearest stone of every pixel that can be filled: owner (stone index or -1) and best (the
// distance from the pixel centre to that stone's edge, px; negative inside the stone), and the
// canvas scale (px per mm).
// fillMarginMm: FILL_MARGIN_MM (tools may try others).
export function nearestStones(stones, { minXmm, minYmm, widthPx, heightPx, scale, fillMarginMm = FILL_MARGIN_MM }) {
  const best = new Float32Array(widthPx * heightPx).fill(Infinity);
  const owner = new Int32Array(widthPx * heightPx).fill(-1);
  const reach = fillMarginMm * scale;

  stones.forEach((s, i) => {
    const cx = (s.xMm - minXmm) * scale;
    const cy = (s.yMm - minYmm) * scale;
    const r = (s.sizeMm / 2) * scale;
    const out = r + reach;
    const x0 = Math.max(0, Math.floor(cx - out)), x1 = Math.min(widthPx - 1, Math.ceil(cx + out));
    const y0 = Math.max(0, Math.floor(cy - out)), y1 = Math.min(heightPx - 1, Math.ceil(cy + out));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const edge = Math.hypot(x + 0.5 - cx, dy) - r;
        const p = y * widthPx + x;
        if (edge <= reach && edge < best[p]) {
          best[p] = edge;
          owner[p] = i;
        }
      }
    }
  });
  return { owner, best, scale };
}

// Steps 1-4: RGBA pixels of the tint at `scale` px per mm, the canvas starting at (minXmm, minYmm).
// Background pixels are `background` ([r, g, b, a]). `near` is nearestStones() of the same canvas.
// fillReach (tools only): the rule before IS-05c, filled up to fillReach radii from the centre;
// `near` must then reach (fillReach - 1) * the largest radius.
export function tintPixels(stones, {
  minXmm, minYmm, widthPx, heightPx, scale, background, rule = GAP_RULE, near = null, fillMarginMm = FILL_MARGIN_MM, fillReach = null
}) {
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  const { owner, best } = near || nearestStones(stones, { minXmm, minYmm, widthPx, heightPx, scale, fillMarginMm });
  const margin = fillMarginMm * scale;
  const tints = new Map();
  const tintOf = (color) => {
    if (!tints.has(color)) tints.set(color, [...gapRgb(fillOf(color), rule), 255]);
    return tints.get(color);
  };
  for (let p = 0; p < owner.length; p++) {
    const s = owner[p] >= 0 ? stones[owner[p]] : null;
    // best is the distance to the stone's edge, in px; filled up to the margin.
    const filled = s && (fillReach ? best[p] <= (fillReach - 1) * (s.sizeMm / 2) * scale : best[p] <= margin);
    data.set(filled ? tintOf(s.color) : background, p * 4);
  }
  return data;
}

// Step 6 on RGBA pixels (in place): each stone's pixels (those whose centre lies inside its disc,
// best <= 0) are brought to the fill's L*: the inner zone to a mean within `inner`, then the whole
// stone to a mean within `whole` (STONE_LIGHTNESS). `near` is nearestStones() of the canvas.
export function keepStoneLightness(data, stones, near, { whole = STONE_LIGHTNESS.whole, inner = STONE_LIGHTNESS.inner } = {}) {
  const { owner, best, scale } = near;
  const count = new Int32Array(stones.length + 1);
  for (let p = 0; p < owner.length; p++) if (owner[p] >= 0 && best[p] <= 0) count[owner[p] + 1]++;
  for (let i = 0; i < stones.length; i++) count[i + 1] += count[i];
  const pix = new Int32Array(count[stones.length]);
  const fillAt = count.slice(0, stones.length);
  for (let p = 0; p < owner.length; p++) if (owner[p] >= 0 && best[p] <= 0) pix[fillAt[owner[p]]++] = p;

  const targets = new Map();
  let ys = new Float64Array(64), ws = new Float64Array(64), alpha = new Float64Array(64), beta = new Float64Array(64);
  let isInner = new Uint8Array(64);
  for (let i = 0; i < stones.length; i++) {
    const from = count[i], n = count[i + 1] - from;
    if (!n) continue;
    const color = stones[i].color;
    if (!targets.has(color)) targets.set(color, lightnessOfHex(fillOf(color)));
    const target = targets.get(color);
    if (ys.length < n) {
      [ys, ws, alpha, beta] = [n, n, n, n].map((k) => new Float64Array(k));
      isInner = new Uint8Array(n);
    }
    // ws: 1 in the inner zone, fading to 0 over the ramp; each pixel's change so far is
    // lin' = alpha * lin + beta, the same on every channel (so on Y too).
    const r = (stones[i].sizeMm / 2) * scale;
    let innerN = 0;
    for (let k = 0; k < n; k++) {
      const p = pix[from + k], q = p * 4;
      ys[k] = lumOf(data[q], data[q + 1], data[q + 2]);
      const rho = (best[p] + r) / r;
      const f = Math.max(0, Math.min(1, (INNER_SHARE + RAMP_SHARE - rho) / RAMP_SHARE));
      isInner[k] = rho <= INNER_SHARE ? 1 : 0;
      ws[k] = isInner[k] ? 1 : f * f * (3 - 2 * f);
      innerN += isInner[k];
      alpha[k] = 1;
      beta[k] = 0;
    }
    // Mean L* of the pixels selected by pick(k) after the change (strength t in [0, 1], t = 1:
    // unchanged; pixel k changed with strength 1 - weight(k) * (1 - t)): darkening scales by it,
    // lightening screens by it.
    const meanAt = (t, darken, weight, pick) => {
      let sum = 0, m = 0;
      for (let k = 0; k < n; k++) {
        if (!pick(k)) continue;
        const tk = 1 - weight(k) * (1 - t);
        sum += fastL(darken ? tk * ys[k] : 1 - tk * (1 - ys[k]));
        m++;
      }
      return m ? sum / m : target;
    };
    const meanOf = (pick) => meanAt(1, true, () => 0, pick);
    // Bring the mean of pick's pixels to within tol of the target by changing them with weight;
    // false if even full strength (t = 0) does not get there.
    const solve = (tol, weight, pick) => {
      const mean = meanOf(pick);
      if (Math.abs(mean - target) <= tol) return true;
      const darken = mean > target;
      const want = darken ? target + tol : target - tol;
      if ((meanAt(0, darken, weight, pick) > want) === darken) return false;
      let lo = 0, hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if ((meanAt(mid, darken, weight, pick) > want) === darken) hi = mid;
        else lo = mid;
      }
      const t = (lo + hi) / 2;
      for (let k = 0; k < n; k++) {
        const tk = 1 - weight(k) * (1 - t);
        if (tk === 1) continue;
        if (darken) {
          ys[k] *= tk; alpha[k] *= tk; beta[k] *= tk;
        } else {
          ys[k] = 1 - tk * (1 - ys[k]); alpha[k] *= tk; beta[k] = 1 - tk * (1 - beta[k]);
        }
      }
      return true;
    };
    const all = () => true;
    const inInner = (k) => isInner[k] === 1;
    if (inner !== null && innerN) solve(inner, (k) => ws[k], inInner);
    const innerOk = () => inner === null || !innerN || Math.abs(meanOf(inInner) - target) <= inner + 0.25;
    if (Math.abs(meanOf(all) - target) > whole) {
      const saved = [ys.slice(0, n), alpha.slice(0, n), beta.slice(0, n)];
      solve(whole, () => 1, all);
      if (!innerOk()) {
        ys.set(saved[0]); alpha.set(saved[1]); beta.set(saved[2]);
        if (!solve(whole, (k) => 1 - ws[k], all)) solve(whole, () => 1, all);
      }
    }
    for (let k = 0; k < n; k++) {
      if (alpha[k] === 1 && beta[k] === 0) continue;
      const q = pix[from + k] * 4;
      for (let c = 0; c < 3; c++) data[q + c] = toSrgb8Fast(alpha[k] * TO_LINEAR[data[q + c]] + beta[k]);
    }
  }
}

// Step 5: one stone, drawn by the RS renderer (CrystalStoneRenderer.js, unchanged). The RS renderer
// strokes a stone's outer edge in its catalogue stroke colour, max(0.45 px, 0.09 r) wide. Jet's
// stroke is light grey, so a large Jet stone (a pupil) had a light ring as wide, in mm, as its size
// (SS20: 0.21 mm, SS6: 0.09 mm). IS-05c: a stone above SS6 whose stroke is lighter than its fill
// gets the rim an SS6 stone has: the RS edge band is painted over (inside the stone with its edge
// colour, the accent; outside with its gap colour) and the edge stroked again at an SS6 stone's
// width. Every other stone is drawn as RS draws it.
const TAU = Math.PI * 2;
const RS_EDGE = { share: 0.09, minPx: 0.45 };
const lightRim = new Map();
function hasLightRim(color) {
  if (!lightRim.has(color)) {
    const c = STONE_COLORS[color] || STONE_COLORS.crystal;
    lightRim.set(color, lightnessOfHex(c.stroke) > lightnessOfHex(c.fill));
  }
  return lightRim.get(color);
}

function drawStone(ctx, stone, x, y, r, scale, rule, ss6Rim = true) {
  const appearance = getCrystalAppearance(stone);
  drawCrystalStone(ctx, x, y, r, stone.color, appearance);
  const r6 = SS6_RADIUS_MM * scale;
  if (!ss6Rim || r <= r6 * (1 + 1e-9) || !hasLightRim(stone.color)) return;
  const c = STONE_COLORS[stone.color] || STONE_COLORS.crystal;
  const wide = Math.max(RS_EDGE.minPx, r * RS_EDGE.share), narrow = Math.max(RS_EDGE.minPx, r6 * RS_EDGE.share);
  const band = (from, to) => {
    ctx.beginPath();
    ctx.arc(x, y, to, 0, TAU);
    ctx.arc(x, y, from, 0, TAU, true);
  };
  ctx.save();
  band(r - wide / 2 - 0.5, r);
  ctx.fillStyle = adjustBrightness(c.accent, appearance.brightness);
  ctx.fill();
  band(r, r + wide / 2 + 0.5);
  ctx.fillStyle = `rgb(${gapRgb(c.fill, rule).join(",")})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.lineWidth = narrow;
  ctx.strokeStyle = c.stroke;
  ctx.stroke();
  ctx.restore();
}

// The watermark of every preview the browser receives: "IS · PREVIEW · <code>", tiled diagonally.
function drawWatermark(ctx, widthPx, heightPx, code) {
  const text = `IS · PREVIEW · ${code}`;
  const sizePx = Math.max(12, Math.round(Math.max(widthPx, heightPx) / 28));
  ctx.save();
  ctx.globalAlpha = WATERMARK_OPACITY;
  ctx.font = `bold ${sizePx}px Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0b1f4d";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1, sizePx / 12);
  ctx.translate(widthPx / 2, heightPx / 2);
  ctx.rotate(-Math.PI / 6);
  const diagonal = Math.hypot(widthPx, heightPx);
  const stepX = ctx.measureText(text).width + sizePx * 2;
  const stepY = sizePx * 4;
  for (let row = 0, y = -diagonal / 2; y <= diagonal / 2; row++, y += stepY) {
    for (let x = -diagonal / 2 - (row % 2) * (stepX / 2); x <= diagonal / 2; x += stepX) {
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

// StoneLayout -> { png, widthPx, heightPx, scale } with the long side at longSidePx. background
// "white" (the app) or "transparent" (the PNG file); watermark: the code to tile over it, or null.
// rule and stoneLightness: the rules of steps 3 and 6; fillReach and ss6Rim: steps 4 and 5 before
// IS-05c are { fillReach: 1.6, ss6Rim: false } (tools only; the app always uses GAP_RULE,
// STONE_LIGHTNESS, FILL_MARGIN_MM and the SS6 rim).
export function renderTinted(stoneLayout, {
  longSidePx = FULL_LONG_SIDE_PX, background = "transparent", watermark = null, rule = GAP_RULE, stoneLightness = STONE_LIGHTNESS,
  fillReach = null, ss6Rim = true
} = {}) {
  if (!stoneLayout?.stones?.length) throw new TypeError("renderTinted requires a StoneLayout with stones.");
  const box = tintCanvasMm(stoneLayout);
  const scale = longSidePx / Math.max(box.widthMm, box.heightMm);
  const widthPx = Math.round(box.widthMm * scale);
  const heightPx = Math.round(box.heightMm * scale);
  const bg = background === "white" ? [255, 255, 255, 255] : [0, 0, 0, 0];
  const fillMarginMm = fillReach ? (fillReach - 1) * Math.max(...stoneLayout.stones.map((s) => s.sizeMm / 2)) : FILL_MARGIN_MM;
  const geometry = { minXmm: box.minXmm, minYmm: box.minYmm, widthPx, heightPx, scale, fillMarginMm };
  const near = nearestStones(stoneLayout.stones, geometry);

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  const tint = ctx.createImageData(widthPx, heightPx);
  tint.data.set(tintPixels(stoneLayout.stones, { ...geometry, background: bg, rule, near, fillReach }));
  ctx.putImageData(tint, 0, 0);

  for (const stone of stoneLayout.stones) {
    const x = (stone.xMm - box.minXmm) * scale;
    const y = (stone.yMm - box.minYmm) * scale;
    drawStone(ctx, stone, x, y, (stone.sizeMm / 2) * scale, scale, rule, ss6Rim);
  }
  const drawn = ctx.getImageData(0, 0, widthPx, heightPx);
  keepStoneLightness(drawn.data, stoneLayout.stones, near, stoneLightness);
  ctx.putImageData(drawn, 0, 0);
  if (watermark) drawWatermark(ctx, widthPx, heightPx, watermark);
  return { png: canvas.toBuffer("image/png"), widthPx, heightPx, scale };
}

// The two renders of section 8: the full one (archive and ZIP, transparent) and the preview the
// browser gets (white, watermarked with the code).
export const renderFull = (stoneLayout) => renderTinted(stoneLayout, { longSidePx: FULL_LONG_SIDE_PX, background: "transparent" });
export const renderPreview = (stoneLayout, code) => renderTinted(stoneLayout, { longSidePx: PREVIEW_LONG_SIDE_PX, background: "white", watermark: code });
