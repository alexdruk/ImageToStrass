// The two small example pictures of the Black & white styles on the Prepare screen (IS-07b, spec
// 6.4 and 10): public/examples/bw-bold.png ("Bold", bwStyle stencil) and bw-shaded.png ("Shaded",
// bwStyle halftone). Tools only; run again only to change the pictures.
//
//   node tools/make-bw-examples.mjs
//
// PN-04b: crops of the mastiff's face from the PN-04a listing designs mastiff-bw-stencil and
// mastiff-bw-halftone (their full-size tinted.png and stats.json in data/listing/designs/, git-ignored;
// docs/listing/README.md), no provider call. Both crops are the same part of the dog: the same
// fractions of each design's stones' box, which is the same part of the same prepared photo. Shown
// on white. The pictures carry no metadata (sharp writes none).
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { MARGIN_STONES } from "../src/render/tinted.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

const ROOT = new URL("../", import.meta.url).pathname;
const FULL = path.join(ROOT, "data/listing/designs");
const OUT = path.join(ROOT, "public/examples");
const WIDTH_PX = 320, HEIGHT_PX = 269;
// The face (eyes, nose and mouth), as fractions of the stones' box: centre and width.
const FACE = { cx: 0.555, cy: 0.52, w: 0.62 };

async function picture(id, file) {
  const dir = path.join(FULL, id);
  const stats = JSON.parse(readFileSync(path.join(dir, "stats.json"), "utf8"));
  const tinted = path.join(dir, "tinted.png");
  const { width, height } = await sharp(tinted).metadata();
  // renderTinted's canvas: the stones' box plus MARGIN_STONES main-stone diameters on each side.
  const main = Object.entries(stats.bySize).sort((a, b) => b[1] - a[1])[0][0];
  const m = MARGIN_STONES * getStoneSize(main).diameterMm;
  const scale = Math.max(width, height) / (Math.max(stats.widthMm, stats.heightMm) + 2 * m);
  const w = FACE.w * stats.widthMm * scale, h = w * HEIGHT_PX / WIDTH_PX;
  const left = Math.round((m + FACE.cx * stats.widthMm) * scale - w / 2);
  const top = Math.round((m + FACE.cy * stats.heightMm) * scale - h / 2);
  await sharp(tinted)
    .extract({ left, top, width: Math.round(w), height: Math.round(h) })
    .resize(WIDTH_PX, HEIGHT_PX, { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9, palette: true, colours: 64 })
    .toFile(path.join(OUT, file));
}

await picture("mastiff-bw-stencil", "bw-bold.png");
await picture("mastiff-bw-halftone", "bw-shaded.png");
console.log("public/examples/bw-bold.png, public/examples/bw-shaded.png");
