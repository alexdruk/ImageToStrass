import sharp from "sharp";
import { applyAdjustments } from "./adjust.js";

// Server side of spec section 6.3: the same adjust.js the browser runs, on the full image.

export const PREVIEW_LONG_SIDE = 1024;

export async function readRgba(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height
  };
}

export function encodePng({ data, width, height }) {
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.length), {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();
}

// work.png or cutout.png + the buyer's settings → prepared.png.
export async function preparePng(sourcePng, settings) {
  return encodePng(applyAdjustments(await readRgba(sourcePng), settings));
}

// The 1024 px version the browser previews and adjusts live.
export function previewPng(sourcePng) {
  return sharp(sourcePng)
    .resize({ width: PREVIEW_LONG_SIDE, height: PREVIEW_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}
