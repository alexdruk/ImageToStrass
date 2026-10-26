import { findStoneSizeByDiameterMm } from "../stones/StoneSizes.js";
import { stoneLayoutToSvg } from "./SvgExporter.js";

// PN-XXXX-XXXX.svg (spec section 9): RS stoneLayoutToSvg at true size (width/height in mm), in its
// grouped form, every colour-and-size group a <g> with an id such as "jet-ss6". IS has no traced
// regions, so the empty regions group is left out.

const EMPTY_REGIONS = '<g id="regions">\n</g>\n';
const GROUP = /<g data-layer="([^"]*)" data-color="([^"]*)" data-size="([^"]*)">/g;

export function designSvg(stoneLayout) {
  const svg = stoneLayoutToSvg(stoneLayout, { widthMm: stoneLayout.widthMm, heightMm: stoneLayout.heightMm }, { regions: [] });
  return svg.replace(EMPTY_REGIONS, "").replace(GROUP, (match, layer, color, size) => {
    const sizeId = findStoneSizeByDiameterMm(Number(size))?.id ?? `${size}mm`;
    return `<g id="${color}-${sizeId}" data-layer="${layer}" data-color="${color}" data-size="${size}">`;
  });
}
