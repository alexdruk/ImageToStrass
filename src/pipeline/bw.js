import { Stone } from "../stones/Stone.js";
import { StoneLayout } from "../stones/StoneLayout.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { lightnessOnWhite } from "./holes.js";

// Black & white (spec section 7.6, D3), run on the delivered stones (after the cap, the cleanup and
// the hole fill). mapBlackAndWhiteFromImage, what the pipeline uses: each stone's lightness is read
// from the AI image itself, the mean CIE L* of its inner 60 % composited on white
// (holes.lightnessOnWhite): L* < threshold -> Jet, otherwise Crystal. The service's colours are not
// used. mapBlackAndWhite (before exp-holes; tools only) maps each stone's catalogue colour by the L*
// of its fill instead. "Crystal" is the catalogue colour named Crystal (id crystal-clear, #f5f5f5),
// the one the prompt's Appendix A and the catch-light rule name; id "crystal" is Crystal AB.

export const DEFAULT_BW_THRESHOLD = 55;
export const BW_DARK = "jet";
export const BW_LIGHT = "crystal-clear";

function linear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// CIE L* (D65) of an sRGB hex colour, "#rgb" or "#rrggbb".
export function lightness(hex) {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => linear(parseInt(h.slice(i, i + 2), 16)));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

export function bwColour(colorId, threshold = DEFAULT_BW_THRESHOLD) {
  const colour = STONE_COLORS[colorId];
  if (!colour) throw new Error(`Unknown stone colour: ${colorId}`);
  return lightness(colour.fill) < threshold ? BW_DARK : BW_LIGHT;
}

// A new StoneLayout with every colour mapped; positions and sizes are unchanged.
export function mapBlackAndWhite(layout, threshold = DEFAULT_BW_THRESHOLD) {
  return new StoneLayout({
    layerId: layout.layerId,
    sourceMode: layout.sourceMode,
    stones: layout.stones.map((s) => new Stone({
      xMm: s.xMm, yMm: s.yMm, sizeMm: s.sizeMm, layerId: s.layerId, index: s.index, metadata: s.metadata,
      color: bwColour(s.color, threshold)
    }))
  });
}

// A new StoneLayout with every stone Jet or Crystal by the AI image's lightness under it. frame: {
// mmPerPx, offsetMm } of the layout's report and originMm (cleanedLayout): AI pixel = (stone mm +
// originMm + offsetMm) / mmPerPx. Positions and sizes are unchanged. A frame without mmPerPx or
// offsetMm (every /layout answer has them) falls back to mapBlackAndWhite.
export function mapBlackAndWhiteFromImage(layout, ai, { mmPerPx, offsetMm, originMm }, threshold = DEFAULT_BW_THRESHOLD) {
  const s = Number(mmPerPx);
  if (!(s > 0) || !Array.isArray(offsetMm) || !Array.isArray(originMm)) return mapBlackAndWhite(layout, threshold);
  return new StoneLayout({
    layerId: layout.layerId,
    sourceMode: layout.sourceMode,
    stones: layout.stones.map((st) => new Stone({
      xMm: st.xMm, yMm: st.yMm, sizeMm: st.sizeMm, layerId: st.layerId, index: st.index, metadata: st.metadata,
      color: lightnessOnWhite(ai, (st.xMm + originMm[0] + offsetMm[0]) / s, (st.yMm + originMm[1] + offsetMm[1]) / s, st.sizeMm, s) < threshold
        ? BW_DARK
        : BW_LIGHT
    }))
  });
}
