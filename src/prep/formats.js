// Upload type from the file signature, never from the name (spec section 6.1).
// Accepted: PNG, JPEG, BMP, TIFF, WebP, AVIF, SVG. Returns null for anything else.

export const FORMATS = {
  png: { ext: "png" },
  jpeg: { ext: "jpg" },
  bmp: { ext: "bmp" },
  tiff: { ext: "tif" },
  webp: { ext: "webp" },
  avif: { ext: "avif" },
  svg: { ext: "svg" }
};

// Bytes of the file head that detectFormat needs at most.
export const SIGNATURE_BYTES = 4096;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AVIF_BRANDS = new Set(["avif", "avis"]);

function startsWith(head, bytes, offset = 0) {
  return head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
}

function ascii(head, start, end) {
  return head.subarray(start, end).toString("latin1");
}

// ISO BMFF "ftyp" box whose major or compatible brands include avif / avis.
function isAvif(head) {
  if (head.length < 16 || ascii(head, 4, 8) !== "ftyp") {
    return false;
  }

  const size = Math.min(head.readUInt32BE(0), head.length);

  if (AVIF_BRANDS.has(ascii(head, 8, 12))) {
    return true;
  }

  for (let at = 16; at + 4 <= size; at += 4) {
    if (AVIF_BRANDS.has(ascii(head, at, at + 4))) {
      return true;
    }
  }

  return false;
}

// "BM", reserved fields zero, a known DIB header size, sane pixel offset.
function isBmp(head) {
  if (head.length < 30 || !startsWith(head, [0x42, 0x4d])) {
    return false;
  }

  const offset = head.readUInt32LE(10);
  const headerSize = head.readUInt32LE(14);

  return head.readUInt32LE(6) === 0 &&
    [40, 52, 56, 108, 124].includes(headerSize) &&
    offset >= 14 + headerSize;
}

// Text that, after an optional BOM, XML declaration, comments and doctype, opens with <svg.
// The doctype may carry an internal subset and the root a namespace prefix: the sanitiser
// (svg.js) refuses those cases, so they must be recognised as SVG here.
const SVG_START = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+(?:[\w.-]+:)?svg[^>[]*(?:\[[\s\S]*?\])?\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?svg[\s>/]/i;

function isSvg(head) {
  return SVG_START.test(head.subarray(0, SIGNATURE_BYTES).toString("utf8"));
}

export function detectFormat(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) {
    return null;
  }

  if (startsWith(head, PNG)) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "webp";
  if (isAvif(head)) return "avif";
  if (isBmp(head)) return "bmp";
  if (isSvg(head)) return "svg";

  return null;
}
