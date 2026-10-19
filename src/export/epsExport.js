import { STONE_COLORS } from "../stones/StoneColors.js";

// IS-XXXX-XXXX.eps (spec section 9): EPSF-3.0 written directly from the final StoneLayout. The
// bounding box is the design's natural size in points, origin bottom-left (y flipped); one filled
// circle per stone in its catalogue fill colour, the stones grouped by colour. The header names IS
// and the design only (section 12).

const PT_PER_MM = 72 / 25.4;
const pt = (mm) => (Math.round(mm * PT_PER_MM * 1000) / 1000).toString();
const unit = (v) => (Math.round(v * 10000) / 10000).toString();
const rgb = (hex) => [0, 2, 4].map((i) => unit(parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255)).join(" ");

// DSC text values: printable ASCII only.
const dscText = (s) => String(s).replace(/[^\x20-\x7e]/g, "?");

export function designEps(stoneLayout, { title = "IS design" } = {}) {
  const box = stoneLayout.getBoundingBox();
  const { widthMm, heightMm } = stoneLayout;
  const groups = new Map();
  for (const stone of stoneLayout.stones) {
    if (!groups.has(stone.color)) groups.set(stone.color, []);
    groups.get(stone.color).push(stone);
  }
  const lines = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    `%%BoundingBox: 0 0 ${Math.ceil(widthMm * PT_PER_MM - 1e-6)} ${Math.ceil(heightMm * PT_PER_MM - 1e-6)}`,
    `%%HiResBoundingBox: 0 0 ${pt(widthMm)} ${pt(heightMm)}`,
    "%%Creator: IS",
    `%%Title: ${dscText(title)}`,
    "%%LanguageLevel: 2",
    "%%Pages: 1",
    "%%DocumentData: Clean7Bit",
    "%%EndComments",
    "%%BeginProlog",
    "/C { newpath 0 360 arc closepath fill } bind def",
    "%%EndProlog",
    "%%Page: 1 1",
    "gsave"
  ];
  for (const [color, stones] of groups) {
    const c = STONE_COLORS[color] || STONE_COLORS.crystal;
    lines.push(`% ${dscText(c.name)}`, `${rgb(c.fill)} setrgbcolor`);
    for (const s of stones) {
      lines.push(`${pt(s.xMm - box.minXmm)} ${pt(heightMm - (s.yMm - box.minYmm))} ${pt(s.sizeMm / 2)} C`);
    }
  }
  lines.push("grestore", "showpage", "%%Trailer", "%%EOF", "");
  return Buffer.from(lines.join("\n"), "latin1");
}
