import { createCanvas } from "@napi-rs/canvas";
import { getCrystalAppearance } from "../stones/CrystalAppearance.js";
import { drawCrystalStone } from "../stones/CrystalStoneRenderer.js";
import { STONE_COLORS } from "../stones/StoneColors.js";

// The tinted view (spec section 8, D4). It reads the final StoneLayout and never changes it.
//   1. The canvas is the stones' box plus a margin of MARGIN_STONES main-stone diameters.
//   2. A pixel takes the colour of its nearest stone, measured to the stone's edge (distance to
//      the centre minus the radius),
//   3. that is the stone's catalogue fill darkened to TINT_BRIGHTNESS,
//   4. but only if the pixel lies within FILL_REACH radii of that stone's centre; elsewhere the
//      background shows (white in the app, transparent in the PNG file).
//   5. The stones are drawn on top with the RS faceted crystal renderer.
//
// Nearest-stone search: a pixel can only be filled when its nearest stone's edge is at most
// (FILL_REACH - 1) * r <= (FILL_REACH - 1) * rMax away, and any stone whose edge is farther than
// that cannot fill it. So each stone writes its edge distance into the pixels within that reach
// (keeping the smallest), which gives exactly the nearest stone of every pixel that can be filled.

export const MARGIN_STONES = 2;
export const TINT_BRIGHTNESS = 0.85;
export const FILL_REACH = 1.6;
export const PREVIEW_LONG_SIDE_PX = 900;
export const FULL_LONG_SIDE_PX = 2400;
export const WATERMARK_OPACITY = 0.18;

function hexToRgb(hex) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
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

// Steps 1-4: RGBA pixels of the tint at `scale` px per mm, the canvas starting at (minXmm, minYmm).
// Background pixels are `background` ([r, g, b, a]).
export function tintPixels(stones, { minXmm, minYmm, widthPx, heightPx, scale, background }) {
  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  const best = new Float32Array(widthPx * heightPx).fill(Infinity);
  const owner = new Int32Array(widthPx * heightPx).fill(-1);
  let rMax = 0;
  for (const s of stones) rMax = Math.max(rMax, s.sizeMm / 2);
  const reachMm = (FILL_REACH - 1) * rMax;

  stones.forEach((s, i) => {
    const cx = (s.xMm - minXmm) * scale;
    const cy = (s.yMm - minYmm) * scale;
    const r = (s.sizeMm / 2) * scale;
    const reach = reachMm * scale;
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

  const tints = new Map();
  const tintOf = (color) => {
    if (!tints.has(color)) {
      const c = STONE_COLORS[color] || STONE_COLORS.crystal;
      tints.set(color, hexToRgb(c.fill).map((v) => Math.round(v * TINT_BRIGHTNESS)));
    }
    return tints.get(color);
  };
  for (let p = 0; p < owner.length; p++) {
    const s = owner[p] >= 0 ? stones[owner[p]] : null;
    // edge + r is the distance to the centre, in px; filled up to FILL_REACH * r.
    const r = s ? (s.sizeMm / 2) * scale : 0;
    const rgba = s && best[p] + r <= FILL_REACH * r ? [...tintOf(s.color), 255] : background;
    data.set(rgba, p * 4);
  }
  return data;
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
export function renderTinted(stoneLayout, { longSidePx = FULL_LONG_SIDE_PX, background = "transparent", watermark = null } = {}) {
  if (!stoneLayout?.stones?.length) throw new TypeError("renderTinted requires a StoneLayout with stones.");
  const box = tintCanvasMm(stoneLayout);
  const scale = longSidePx / Math.max(box.widthMm, box.heightMm);
  const widthPx = Math.round(box.widthMm * scale);
  const heightPx = Math.round(box.heightMm * scale);
  const bg = background === "white" ? [255, 255, 255, 255] : [0, 0, 0, 0];

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  const pixels = tintPixels(stoneLayout.stones, { minXmm: box.minXmm, minYmm: box.minYmm, widthPx, heightPx, scale, background: bg });
  const image = ctx.createImageData(widthPx, heightPx);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);

  for (const stone of stoneLayout.stones) {
    const x = (stone.xMm - box.minXmm) * scale;
    const y = (stone.yMm - box.minYmm) * scale;
    drawCrystalStone(ctx, x, y, (stone.sizeMm / 2) * scale, stone.color, getCrystalAppearance(stone));
  }
  if (watermark) drawWatermark(ctx, widthPx, heightPx, watermark);
  return { png: canvas.toBuffer("image/png"), widthPx, heightPx, scale };
}

// The two renders of section 8: the full one (archive and ZIP, transparent) and the preview the
// browser gets (white, watermarked with the code).
export const renderFull = (stoneLayout) => renderTinted(stoneLayout, { longSidePx: FULL_LONG_SIDE_PX, background: "transparent" });
export const renderPreview = (stoneLayout, code) => renderTinted(stoneLayout, { longSidePx: PREVIEW_LONG_SIDE_PX, background: "white", watermark: code });
