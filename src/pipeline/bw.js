import { Stone } from "../stones/Stone.js";
import { StoneLayout } from "../stones/StoneLayout.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { lightnessOnWhite, neighbourVote } from "./holes.js";

// Black & white (spec section 7.6, D3), run on the delivered stones (after the cap, the cleanup and
// the hole fill). mapBlackAndWhiteFromImage, what the pipeline uses: each stone's lightness is read
// from the AI image itself, the mean CIE L* of its inner 60 % composited on white
// (holes.lightnessOnWhite): L* < threshold -> Jet, otherwise Crystal. The service's colours are not
// used. The stones whose colour comes from their neighbours (cleanedLayout's voted: the filled
// stones, and with IS_SERVICE_FILL_NEIGHBOURS=1 the service's fill stones) are not read: they take
// the Jet or Crystal of their neighbours by the same vote (holes.neighbourVote), as the AI paints
// its gaps between stones, where they sit. mapBlackAndWhite (before exp-holes; tools only) maps each stone's catalogue colour by the L*
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

// Area shared by two discs (radii r1, r2, centres dist apart).
function overlapArea(r1, r2, dist) {
  if (dist >= r1 + r2) return 0;
  if (dist <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((dist * dist + r1 * r1 - r2 * r2) / (2 * dist * r1));
  const b = r2 * r2 * Math.acos((dist * dist + r2 * r2 - r1 * r1) / (2 * dist * r2));
  return a + b - 0.5 * Math.sqrt((-dist + r1 + r2) * (dist + r1 - r2) * (dist - r1 + r2) * (dist + r1 + r2));
}

// fromDiscs (IS_BW_FROM_DISCS=1, exp-holes): the stone's colour is that of the AI stone disc
// (frame.discsAtMm, [x, y, d] in the layout's mm: the stones the service detected, not the painted
// dots it dropped) it overlaps most, the disc read as a stone at its own centre and size; a stone
// that overlaps none is read as before. The layout moves stones off their discs, partly onto the AI's
// dark gap paint, which then read Jet among Crystal (docs/exp-holes.md section 10).
function discReader(discs, ai, s, offsetMm, threshold) {
  const CELL = 3;
  const grid = new Map();
  discs.forEach(([x, y], k) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  });
  const colour = new Map();
  const colourOf = (k) => {
    if (!colour.has(k)) {
      const [x, y, d] = discs[k];
      colour.set(k, lightnessOnWhite(ai, (x + offsetMm[0]) / s, (y + offsetMm[1]) / s, d, s) < threshold ? BW_DARK : BW_LIGHT);
    }
    return colour.get(k);
  };
  // The colour of the disc a stone at (x, y), diameter d (layout mm) overlaps most, or null.
  return (x, y, d) => {
    let best = 0, at = -1;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      for (const k of grid.get(`${gx + a},${gy + b}`) || []) {
        const area = overlapArea(d / 2, discs[k][2] / 2, Math.hypot(discs[k][0] - x, discs[k][1] - y));
        if (area > best) { best = area; at = k; }
      }
    }
    return at >= 0 ? colourOf(at) : null;
  };
}

// A new StoneLayout with every stone Jet or Crystal by the AI image's lightness under it. frame: {
// mmPerPx, offsetMm } of the layout's report and originMm (cleanedLayout): AI pixel = (stone mm +
// originMm + offsetMm) / mmPerPx; with fromDiscs also the report's discsAtMm (discReader; a frame
// without them reads as before). voted: indices of the stones decided by the neighbour vote.
// Positions and sizes are unchanged. A frame without mmPerPx or offsetMm (every /layout answer has
// them) falls back to mapBlackAndWhite.
export function mapBlackAndWhiteFromImage(layout, ai, { mmPerPx, offsetMm, originMm, discsAtMm }, threshold = DEFAULT_BW_THRESHOLD, voted = [], { fromDiscs = false } = {}) {
  const s = Number(mmPerPx);
  if (!(s > 0) || !Array.isArray(offsetMm) || !Array.isArray(originMm)) return mapBlackAndWhite(layout, threshold);
  const disc = fromDiscs && Array.isArray(discsAtMm) && discsAtMm.length ? discReader(discsAtMm, ai, s, offsetMm, threshold) : null;
  const read = (st) => {
    const x = st.xMm + originMm[0], y = st.yMm + originMm[1];
    return (disc && disc(x, y, st.sizeMm))
      ?? (lightnessOnWhite(ai, (x + offsetMm[0]) / s, (y + offsetMm[1]) / s, st.sizeMm, s) < threshold ? BW_DARK : BW_LIGHT);
  };
  const targets = new Set(voted);
  const plain = layout.stones.map((st) => ({ x: st.xMm, y: st.yMm, d: st.sizeMm }));
  const byVote = targets.size ? neighbourVote(plain, targets, (_, i) => read(layout.stones[i])) : new Map();
  return new StoneLayout({
    layerId: layout.layerId,
    sourceMode: layout.sourceMode,
    stones: layout.stones.map((st, i) => new Stone({
      xMm: st.xMm, yMm: st.yMm, sizeMm: st.sizeMm, layerId: st.layerId, index: st.index, metadata: st.metadata,
      color: byVote.has(i) ? byVote.get(i) : read(st)
    }))
  });
}
