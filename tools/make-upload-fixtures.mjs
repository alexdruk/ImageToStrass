// Writes tools/fixtures/upload/: one small file per accepted format, plus the edge cases the
// decoder must handle and malicious SVGs it must refuse. Run once; the output is committed.
//   node tools/make-upload-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bmp from "bmp-js";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "fixtures", "upload");
const source = path.join(here, "..", "services", "strass", "tests", "fixtures", "photos", "cat.jpg");

mkdirSync(out, { recursive: true });

const W = 240;
const H = 180;
const rgb = await sharp(source).resize(W, H).removeAlpha().raw().toBuffer();

// RGBA with a transparent left quarter, to check alpha survives.
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i += 1) {
  rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4);
  rgba[i * 4 + 3] = i % W < W / 4 ? 0 : 255;
}

const raw = () => sharp(rgba, { raw: { width: W, height: H, channels: 4 } });
const write = (name, data) => writeFileSync(path.join(out, name), data);

write("photo.png", await raw().png().toBuffer());
write("photo-16bit.png", await raw().toColourspace("rgb16").png().toBuffer());
write("photo.jpg", await raw().flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer());
// Stored sideways with EXIF orientation 6: decoders must turn it back to 240 × 180.
write("photo-exif6.jpg", await raw().flatten({ background: "#ffffff" }).rotate(-90)
  .jpeg({ quality: 85 }).withMetadata({ orientation: 6 }).toBuffer());
write("photo-cmyk.jpg", await raw().flatten({ background: "#ffffff" }).toColourspace("cmyk")
  .jpeg({ quality: 85 }).toBuffer());
write("photo.tif", await raw().tiff({ compression: "lzw" }).toBuffer());
write("photo.webp", await raw().webp({ quality: 85 }).toBuffer());
write("photo.avif", await raw().avif({ quality: 60 }).toBuffer());

// Animated WebP, two frames: the first is the photo, the second solid red.
const red = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i += 1) red.set([255, 0, 0, 255], i * 4);
const frames = await Promise.all([rgba, red].map((data) =>
  sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()));
write("animated.webp", await sharp(frames, { join: { animated: true } })
  .webp({ quality: 85, loop: 0, delay: [500, 500] }).toBuffer());

// 24-bit BMP from bmp-js (ABGR input).
const abgr = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i += 1) {
  abgr[i * 4] = 255;
  abgr[i * 4 + 1] = rgba[i * 4 + 2];
  abgr[i * 4 + 2] = rgba[i * 4 + 1];
  abgr[i * 4 + 3] = rgba[i * 4];
}
write("photo.bmp", bmp.encode({ data: abgr, width: W, height: H }).data);

// 32-bit BITMAPV5 BMP with BGRA bit fields and alpha, top-down, as image editors write it.
function bmpV5() {
  const pixels = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    pixels.set([rgba[i * 4 + 2], rgba[i * 4 + 1], rgba[i * 4], rgba[i * 4 + 3]], i * 4);
  }
  const header = Buffer.alloc(14 + 124);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(124, 14);
  header.writeInt32LE(W, 18);
  header.writeInt32LE(-H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(pixels.length, 34);
  header.writeUInt32LE(0x00ff0000, 54);
  header.writeUInt32LE(0x0000ff00, 58);
  header.writeUInt32LE(0x000000ff, 62);
  header.writeUInt32LE(0xff000000, 66);
  header.write("BGRs", 70, "latin1");
  return Buffer.concat([header, pixels]);
}
write("photo-v5.bmp", bmpV5());

const SVG_BODY = '<rect width="120" height="90" fill="#1d3fa8"/><circle cx="60" cy="45" r="30" fill="#f4c20d"/>';

write("drawing.svg",
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a test drawing -->\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="90" viewBox="0 0 120 90">` +
  `<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>` +
  `${SVG_BODY}<use xlink:href="#g"/><rect width="10" height="10" fill="url(#g)"/></svg>\n`);

const MALICIOUS = {
  "script": `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90">${SVG_BODY}<script>alert(1)</script></svg>`,
  "script-prefixed": `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="120" height="90"><svg:script>alert(1)</svg:script></svg:svg>`,
  "foreign-object": `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>`,
  "onload": `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" onload="alert(1)">${SVG_BODY}</svg>`,
  "external-href": `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="90"><image xlink:href="https://example.com/x.png" width="10" height="10"/></svg>`,
  "file-href": `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><image href="file:///etc/passwd" width="10" height="10"/></svg>`,
  "css-url": `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><style>rect{fill:url(https://example.com/a.svg#p)}</style>${SVG_BODY}</svg>`,
  "entity": `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><text>&b;</text></svg>`
};

for (const [name, text] of Object.entries(MALICIOUS)) {
  write(`malicious-${name}.svg`, `${text}\n`);
}

// Not images: a text file named .png, and a PNG signature followed by junk.
write("not-an-image.png", "hello, this is text\n");
write("broken.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]));

console.log(`Fixtures written to ${out}`);
