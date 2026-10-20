import sharp from "sharp";

// PNG chunks and metadata (spec section 12: no provider name in any file or its metadata). The AI
// image the provider returns can carry text, XMP, EXIF and C2PA chunks that name the provider; it
// is archived with only the chunks that make up its pixels.

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The chunks a decoder needs for the pixels; every other chunk is metadata.
export const PIXEL_CHUNKS = Object.freeze(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export const isPng = (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);

// PNG bytes -> [{ type, data, start, end }] (start/end: the whole chunk, length to CRC). Throws on
// a file that is not a PNG or is cut short.
export function pngChunks(buf) {
  if (!isPng(buf)) throw new TypeError("not a PNG file");
  const chunks = [];
  let at = 8;
  while (at < buf.length) {
    if (at + 12 > buf.length) throw new RangeError("PNG chunk cut short");
    const length = buf.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buf.length) throw new RangeError("PNG chunk cut short");
    const type = buf.toString("latin1", at + 4, at + 8);
    chunks.push({ type, data: buf.subarray(at + 8, at + 8 + length), start: at, end });
    at = end;
    if (type === "IEND") break;
  }
  return chunks;
}

// The PNG with only its PIXEL_CHUNKS (copied byte for byte, CRCs included): the decoded pixels are
// unchanged.
export function stripPngMetadata(buf) {
  const keep = pngChunks(buf).filter((c) => PIXEL_CHUNKS.includes(c.type));
  return Buffer.concat([PNG_SIGNATURE, ...keep.map((c) => buf.subarray(c.start, c.end))]);
}

// The AI image as archived: a PNG without metadata. Anything that is not a PNG is re-encoded as one
// (sharp writes no metadata unless asked).
export async function aiImageForArchive(buf) {
  return isPng(buf) ? stripPngMetadata(buf) : sharp(buf).png().toBuffer();
}
