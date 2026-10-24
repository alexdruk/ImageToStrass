// Writes src/pipeline/fake/ai.png, the AI image of IS_FAKE=1: the fake layout's own stones drawn as
// flat discs in their catalogue fill on a transparent frame, at the layout's mmPerPx and offsetMm, so
// the hole fill and the black & white reading (spec 7.5, 7.6) see the image the layout came from.
// No provider image is involved. Run once: node tools/make-fake-ai.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { aiImageForArchive } from "../src/prep/pngmeta.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

const layout = JSON.parse(readFileSync(new URL("../src/pipeline/fake/layout.json", import.meta.url), "utf8"));
const s = layout.report.mmPerPx;
const [ox, oy] = layout.report.offsetMm;
const MARGIN_PX = 20;
const W = Math.ceil((layout.widthMm + ox) / s) + MARGIN_PX, H = Math.ceil((layout.heightMm + oy) / s) + MARGIN_PX;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
for (const [x, y, sizeId, color] of layout.stones) {
  ctx.beginPath();
  ctx.arc((x + ox) / s + 0.5, (y + oy) / s + 0.5, getStoneSize(sizeId).diameterMm / 2 / s, 0, 2 * Math.PI);
  ctx.fillStyle = STONE_COLORS[color].fill;
  ctx.fill();
}
const raw = ctx.getImageData(0, 0, W, H);
const png = await sharp(Buffer.from(raw.data.buffer), { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
// Only the pixel chunks, as an archived AI image (spec 4.2).
writeFileSync(new URL("../src/pipeline/fake/ai.png", import.meta.url), await aiImageForArchive(png));
console.log(`src/pipeline/fake/ai.png ${W} x ${H}`);
