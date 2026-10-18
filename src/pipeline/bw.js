import { Stone } from "../stones/Stone.js";
import { StoneLayout } from "../stones/StoneLayout.js";
import { STONE_COLORS } from "../stones/StoneColors.js";

// Black & white mapping (spec section 7.6, D3), run after the natural layout. Every stone colour is mapped by
// the CIE L* of its catalogue fill: L* < threshold -> Jet, otherwise Crystal. "Crystal" is the
// catalogue colour named Crystal (id crystal-clear, #f5f5f5), the one the prompt's Appendix A and
// the catch-light rule name; id "crystal" is Crystal AB.

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
