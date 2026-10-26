import { BRAND } from "../brand.js";
import { stoneLayoutToDxf } from "./DxfExporter.js";

// PN-XXXX-XXXX.dxf (spec section 9): RS stoneLayoutToDxf at the natural size, one layer per colour.
// The writer library names itself in the header variable $LASTSAVEDBY; it is set to PatternNifty
// (no metadata naming anything else, section 9).

const LAST_SAVED_BY = /(\n\$LASTSAVEDBY\n1\n)[^\n]*\n/;

export function designDxf(stoneLayout) {
  const dxf = stoneLayoutToDxf(stoneLayout, { widthMm: stoneLayout.widthMm, heightMm: stoneLayout.heightMm });
  if (!LAST_SAVED_BY.test(dxf)) throw new Error("DXF without $LASTSAVEDBY.");
  return dxf.replace(LAST_SAVED_BY, `$1${BRAND}\n`);
}
