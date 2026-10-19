import { STONE_COLORS } from "../stones/StoneColors.js";
import { PT_PER_MM, PdfDocument } from "./PdfDocument.js";
import { withInfo } from "./pdfInfo.js";

// IS-XXXX-XXXX.ai (spec section 9): one true-size vector PDF page of the stones, the page the design
// plus 10 mm (AI_MARGIN_MM on every side), built with RS PdfDocument. Saved as .ai: Illustrator
// opens a PDF-compatible file. Stones are drawn as the production sheet draws them: catalogue fill,
// catalogue stroke 0.12 mm.

export const AI_MARGIN_MM = 5;
const STROKE_MM = 0.12;

const unitRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255);

export function designAi(stoneLayout, { title } = {}) {
  const widthMm = stoneLayout.widthMm + 2 * AI_MARGIN_MM;
  const heightMm = stoneLayout.heightMm + 2 * AI_MARGIN_MM;
  const doc = new PdfDocument({ widthPt: widthMm * PT_PER_MM, heightPt: heightMm * PT_PER_MM });
  const toPt = (mm) => mm * PT_PER_MM;
  const box = stoneLayout.getBoundingBox();
  doc.setLineWidth(toPt(STROKE_MM));
  for (const stone of stoneLayout.stones) {
    const c = STONE_COLORS[stone.color] || STONE_COLORS.crystal;
    doc.setFillColor(unitRgb(c.fill));
    doc.setStrokeColor(unitRgb(c.stroke));
    const x = stone.xMm - box.minXmm + AI_MARGIN_MM;
    const y = stone.yMm - box.minYmm + AI_MARGIN_MM;
    doc.drawCircle(toPt(x), toPt(heightMm - y), toPt(stone.sizeMm / 2), { fill: true, stroke: true });
  }
  return withInfo(doc.toBytes(), { title });
}
