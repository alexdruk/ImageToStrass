import { createCanvas } from "@napi-rs/canvas";
import { getCrystalAppearance } from "../stones/CrystalAppearance.js";
import { drawCrystalStone } from "../stones/CrystalStoneRenderer.js";
import { STONE_COLORS } from "../stones/StoneColors.js";

// The tinted view (spec section 8, D4). It reads the final StoneLayout and never changes it.
//   1. The canvas is the stones' box plus a margin of MARGIN_STONES main-stone diameters.
//   2. A pixel takes the colour of its nearest stone, measured to the stone's edge (distance to
//      the centre minus the radius),
//   3. that is the gap colour of the stone's catalogue fill (gapRgb: darker by a CIE L* step that
//      grows with the fill's lightness; lighter for very dark fills),
//   4. but only if the pixel lies within FILL_REACH radii of that stone's centre; elsewhere the
//      background shows (white in the app, transparent in the PNG file).
//   5. The stones are drawn on top with the RS faceted crystal renderer,
//   6. then each stone's mean L* (over the pixels whose centre lies inside its disc) is brought to
//      within STONE_L_TOLERANCE of its catalogue fill's L*: a stone too light is darkened (its
//      linear RGB scaled down), one too dark is lightened (screened towards white), so the facets,
//      highlights and sparkle keep their relative contrast. A stone already within the tolerance is
//      left as drawn.
//
// Nearest-stone search: a pixel can only be filled when its nearest stone's edge is at most
// (FILL_REACH - 1) * r <= (FILL_REACH - 1) * rMax away, and any stone whose edge is farther than
// that cannot fill it. So each stone writes its edge distance into the pixels within that reach
// (keeping the smallest), which gives exactly the nearest stone of every pixel that can be filled.

export const MARGIN_STONES = 2;
export const FILL_REACH = 1.6;
export const STONE_L_TOLERANCE = 2;
// Step 3 (IS-05b, tuned against the AI images, docs/IS-05b-results.md): a fill of lightness L is
// darkened by minStep + slope * max(0, L - fromL) L*; a fill darker than darkBelow is lightened by
// minStep instead.
export const GAP_RULE = Object.freeze({ minStep: 4, slope: 0.05, fromL: 80, darkBelow: 0 });
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
  const want = Math.max(0, l - rule.minStep - rule.slope * Math.max(0, l - rule.fromL));
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
// distance from the pixel centre to that stone's edge, px; negative inside the stone).
// fillReach: FILL_REACH (tools may try others).
export function nearestStones(stones, { minXmm, minYmm, widthPx, heightPx, scale, fillReach = FILL_REACH }) {
  const best = new Float32Array(widthPx * heightPx).fill(Infinity);
  const owner = new Int32Array(widthPx * heightPx).fill(-1);
  let rMax = 0;
  for (const s of stones) rMax = Math.max(rMax, s.sizeMm / 2);
  const reach = (fillReach - 1) * rMax * scale;

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
  return { owner, best };
}

// Steps 1-4: RGBA pixels of the tint at `scale` px per mm, the canvas starting at (minXmm, minYmm).
// Background pixels are `background` ([r, g, b, a]). `near` is nearestStones() of the same canvas.
export function tintPixels(stones, { minXmm, minYmm, widthPx, heightPx, scale, background, rule = GAP_RULE, near = null }) {
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  const { owner, best } = near || nearestStones(stones, { minXmm, minYmm, widthPx, heightPx, scale });
  const tints = new Map();
  const tintOf = (color) => {
    if (!tints.has(color)) tints.set(color, [...gapRgb(fillOf(color), rule), 255]);
    return tints.get(color);
  };
  for (let p = 0; p < owner.length; p++) {
    const s = owner[p] >= 0 ? stones[owner[p]] : null;
    // edge + r is the distance to the centre, in px; filled up to FILL_REACH * r.
    const r = s ? (s.sizeMm / 2) * scale : 0;
    data.set(s && best[p] + r <= FILL_REACH * r ? tintOf(s.color) : background, p * 4);
  }
  return data;
}

// Step 6 on RGBA pixels (in place): each stone's pixels (those whose centre lies inside its disc,
// best <= 0) are brought to a mean L* within STONE_L_TOLERANCE of the stone's fill L*.
export function keepStoneLightness(data, stones, { owner, best }) {
  const count = new Int32Array(stones.length + 1);
  for (let p = 0; p < owner.length; p++) if (owner[p] >= 0 && best[p] <= 0) count[owner[p] + 1]++;
  for (let i = 0; i < stones.length; i++) count[i + 1] += count[i];
  const pix = new Int32Array(count[stones.length]);
  const fillAt = count.slice(0, stones.length);
  for (let p = 0; p < owner.length; p++) if (owner[p] >= 0 && best[p] <= 0) pix[fillAt[owner[p]]++] = p;

  const targets = new Map();
  let ys = new Float64Array(64);
  for (let i = 0; i < stones.length; i++) {
    const from = count[i], n = count[i + 1] - from;
    if (!n) continue;
    const color = stones[i].color;
    if (!targets.has(color)) targets.set(color, lightnessOfHex(fillOf(color)));
    const target = targets.get(color);
    if (ys.length < n) ys = new Float64Array(n);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const q = pix[from + k] * 4;
      ys[k] = lumOf(data[q], data[q + 1], data[q + 2]);
      sum += fastL(ys[k]);
    }
    const mean = sum / n;
    if (Math.abs(mean - target) <= STONE_L_TOLERANCE) continue;
    const darken = mean > target;
    const want = darken ? target + STONE_L_TOLERANCE : target - STONE_L_TOLERANCE;
    // Mean L* after the change with strength t in [0, 1] (t = 1: unchanged), increasing in t when
    // darkening (scale by t) and decreasing when lightening (screen by t).
    const meanAt = (t) => {
      let s = 0;
      for (let k = 0; k < n; k++) s += fastL(darken ? t * ys[k] : 1 - t * (1 - ys[k]));
      return s / n;
    };
    let lo = 0, hi = 1;
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if ((meanAt(mid) > want) === darken) hi = mid;
      else lo = mid;
    }
    const t = (lo + hi) / 2;
    for (let k = 0; k < n; k++) {
      const q = pix[from + k] * 4;
      for (let c = 0; c < 3; c++) {
        const lin = TO_LINEAR[data[q + c]];
        data[q + c] = toSrgb8Fast(darken ? t * lin : 1 - t * (1 - lin));
      }
    }
  }
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
// rule: the gap rule of step 3 (tools only; the app always uses GAP_RULE).
export function renderTinted(stoneLayout, { longSidePx = FULL_LONG_SIDE_PX, background = "transparent", watermark = null, rule = GAP_RULE } = {}) {
  if (!stoneLayout?.stones?.length) throw new TypeError("renderTinted requires a StoneLayout with stones.");
  const box = tintCanvasMm(stoneLayout);
  const scale = longSidePx / Math.max(box.widthMm, box.heightMm);
  const widthPx = Math.round(box.widthMm * scale);
  const heightPx = Math.round(box.heightMm * scale);
  const bg = background === "white" ? [255, 255, 255, 255] : [0, 0, 0, 0];
  const geometry = { minXmm: box.minXmm, minYmm: box.minYmm, widthPx, heightPx, scale };
  const near = nearestStones(stoneLayout.stones, geometry);

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  const tint = ctx.createImageData(widthPx, heightPx);
  tint.data.set(tintPixels(stoneLayout.stones, { ...geometry, background: bg, rule, near }));
  ctx.putImageData(tint, 0, 0);

  for (const stone of stoneLayout.stones) {
    const x = (stone.xMm - box.minXmm) * scale;
    const y = (stone.yMm - box.minYmm) * scale;
    drawCrystalStone(ctx, x, y, (stone.sizeMm / 2) * scale, stone.color, getCrystalAppearance(stone));
  }
  const drawn = ctx.getImageData(0, 0, widthPx, heightPx);
  keepStoneLightness(drawn.data, stoneLayout.stones, near);
  ctx.putImageData(drawn, 0, 0);
  if (watermark) drawWatermark(ctx, widthPx, heightPx, watermark);
  return { png: canvas.toBuffer("image/png"), widthPx, heightPx, scale };
}

// The two renders of section 8: the full one (archive and ZIP, transparent) and the preview the
// browser gets (white, watermarked with the code).
export const renderFull = (stoneLayout) => renderTinted(stoneLayout, { longSidePx: FULL_LONG_SIDE_PX, background: "transparent" });
export const renderPreview = (stoneLayout, code) => renderTinted(stoneLayout, { longSidePx: PREVIEW_LONG_SIDE_PX, background: "white", watermark: code });
