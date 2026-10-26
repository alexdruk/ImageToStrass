import { Resvg } from "@resvg/resvg-js";
import zlib from "node:zlib";

// PN-XXXX-XXXX.png (spec section 9): the SVG rendered at PNG_DPI with a transparent background
// (the SVG's white background rectangle is left out), so the PNG prints at true size. resvg writes
// no metadata; a pHYs chunk records the resolution.

export const PNG_DPI = 300;
const CSS_DPI = 96;
const WHITE_BACKGROUND = '<rect width="100%" height="100%" fill="white"/>\n';

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// PNG bytes -> the same with a pHYs chunk (dpi, in pixels per metre) right after IHDR.
export function withDpi(png, dpi = PNG_DPI) {
  const ppm = Math.round(dpi / 0.0254);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data[8] = 1; // unit: metre
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk("pHYs", data), png.subarray(ihdrEnd)]);
}

// The design's SVG (svgExport.js) -> { png, width, height }; width and height are the SVG's mm
// size at PNG_DPI, rounded.
export function designPng(svg) {
  const transparent = svg.replace(WHITE_BACKGROUND, "");
  const rendered = new Resvg(transparent, { fitTo: { mode: "zoom", value: PNG_DPI / CSS_DPI }, font: { loadSystemFonts: false } }).render();
  return { png: withDpi(rendered.asPng()), width: rendered.width, height: rendered.height };
}
