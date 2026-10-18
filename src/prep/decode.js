import bmp from "bmp-js";
import sharp from "sharp";
import { svgProblem } from "./svg.js";

// Decoding to work.png (spec section 6.1): sRGB, RGBA, long side at most 2048 px, EXIF rotation
// applied, all metadata stripped, first frame of animated images. sharp decodes everything
// except BMP (bmp-js → raw RGBA → sharp). SVG is sanitised, then rasterised by sharp at 2048 px.

export const WORK_LONG_SIDE = 2048;
export const MAX_INPUT_PIXELS = 100_000_000;

// The upload is not an image IS can use. message is for the local log only.
export class BadFile extends Error {
  constructor(message) {
    super(message);
    this.code = "bad-file";
  }
}

// detectFormat name → the format name sharp reports for it.
const SHARP_FORMATS = { png: "png", jpeg: "jpeg", tiff: "tiff", webp: "webp", avif: "heif" };

const SHARP_INPUT = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", pages: 1, page: 0 };

const BI_RGB = 0;
const BI_BITFIELDS = 3;
const BGRA_MASKS = [0x00ff0000, 0x0000ff00, 0x000000ff];

// bmp-js reads the palette right after a 40-byte header and the pixels right after the palette;
// it ignores the header size and the pixel offset. Rebuild the file in that plain layout, so
// BITMAPV4/V5 files (with padding before the pixels) decode correctly. 32-bit BI_BITFIELDS with
// the standard BGRA masks becomes BI_RGB, which bmp-js reads in that byte order.
function plainBmp(buffer) {
  if (buffer.length < 54) {
    throw new BadFile("BMP header is truncated");
  }

  const headerSize = buffer.readUInt32LE(14);
  const pixelOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const height = buffer.readInt32LE(22);
  const bitPP = buffer.readUInt16LE(28);
  let compress = buffer.readUInt32LE(30);

  if (width <= 0 || height === 0 || width * Math.abs(height) > MAX_INPUT_PIXELS) {
    throw new BadFile(`BMP size ${width} x ${height} is out of range`);
  }

  if (compress === BI_BITFIELDS) {
    // Right after the 40-byte core: inside V2+ headers, or following a 40-byte header.
    const masksAt = 14 + 40;
    const masks = [0, 1, 2].map((i) => buffer.readUInt32LE(masksAt + i * 4));

    if (bitPP !== 32 || masks.some((m, i) => m !== BGRA_MASKS[i])) {
      throw new BadFile("BMP bit fields other than 32-bit BGRA are not supported");
    }

    compress = BI_RGB;
  }

  const colours = buffer.readUInt32LE(46);
  const paletteBytes = bitPP < 15 ? (colours || 2 ** bitPP) * 4 : 0;
  const paletteAt = 14 + headerSize;

  if (pixelOffset > buffer.length || paletteAt + paletteBytes > buffer.length) {
    throw new BadFile("BMP offsets point past the end of the file");
  }

  const header = Buffer.alloc(54);
  buffer.copy(header, 0, 0, 54);
  header.writeUInt32LE(40, 14);
  header.writeUInt32LE(compress, 30);
  header.writeUInt32LE(54 + paletteBytes, 10);

  return {
    bitPP,
    file: Buffer.concat([
      header,
      buffer.subarray(paletteAt, paletteAt + paletteBytes),
      buffer.subarray(pixelOffset)
    ])
  };
}

function decodeBmp(buffer) {
  const { bitPP, file } = plainBmp(buffer);
  let decoded;

  try {
    decoded = bmp.decode(file);
  } catch (error) {
    throw new BadFile(`BMP could not be decoded: ${error.message}`);
  }

  const { width, height, data } = decoded;
  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;

  // bmp-js gives ABGR; alpha is only meaningful for 32-bit files, and an all-zero alpha
  // channel there means "unused" (X8R8G8B8), so the image is opaque.
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = data[i + 3];
    rgba[i + 1] = data[i + 2];
    rgba[i + 2] = data[i + 1];
    rgba[i + 3] = data[i];
    anyAlpha ||= data[i] !== 0;
  }

  if (bitPP !== 32 || !anyAlpha) {
    for (let i = 3; i < rgba.length; i += 4) {
      rgba[i] = 255;
    }
  }

  return sharp(rgba, { raw: { width, height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS });
}

async function decodeSvg(buffer) {
  const problem = svgProblem(buffer.toString("utf8"));

  if (problem) {
    throw new BadFile(`SVG refused: ${problem}`);
  }

  // At 72 dpi sharp reports the SVG's own size; scale the density so the long side is 2048 px.
  const { width, height } = await sharp(buffer, SHARP_INPUT).metadata();

  if (!width || !height) {
    throw new BadFile("SVG has no size");
  }

  const density = Math.min(100_000, Math.max(1, (72 * WORK_LONG_SIDE) / Math.max(width, height)));

  return sharp(buffer, { ...SHARP_INPUT, density })
    .resize({ width: WORK_LONG_SIDE, height: WORK_LONG_SIDE, fit: "inside" });
}

// buffer + format (from detectFormat) → { png, width, height }. Throws BadFile.
export async function decodeToWork(buffer, format) {
  try {
    let image;

    if (format === "bmp") {
      image = decodeBmp(buffer);
    } else if (format === "svg") {
      image = await decodeSvg(buffer);
    } else if (SHARP_FORMATS[format]) {
      image = sharp(buffer, SHARP_INPUT);

      // sharp sniffs the type itself; it must agree with the signature check.
      if ((await image.metadata()).format !== SHARP_FORMATS[format]) {
        throw new BadFile("decoder disagrees with the file signature");
      }

      image = image.autoOrient();
    } else {
      throw new BadFile(`unsupported format ${format}`);
    }

    const { data, info } = await image
      .resize({ width: WORK_LONG_SIDE, height: WORK_LONG_SIDE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });

    return { png: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof BadFile) {
      throw error;
    }

    throw new BadFile(`decoding failed: ${error.message}`);
  }
}
