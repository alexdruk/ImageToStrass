// The two small example pictures of the Black & white styles on the Prepare screen (IS-07b, spec
// 6.4 and 10): public/examples/bw-bold.png ("Bold", bwStyle stencil) and bw-shaded.png ("Shaded",
// bwStyle halftone). Tools only; run again only to change the pictures.
//
//   node tools/make-bw-examples.mjs
//
// Made from the CC0 cat (tools/fixtures/is03b-ai/cat-rule-output.png and its layout
// tools/fixtures/is03b/cat-rule.json; photo source in tools/fixtures/is03b-ai/README.md), with no
// provider call: the same stones, coloured Jet or Crystal from the image's lightness in the two
// ways the styles draw, and shown with the tinted renderer (BW_GAP crystal, as the app).
// - Bold: each stone's own lightness against a threshold, then a stone that at least 3 in 4 of its
//   neighbours outvote takes their colour (twice), so dark and light come in solid areas.
// - Shaded: each stone's own lightness, ordered-dithered (4 x 4 Bayer matrix on the stone pitch), so
//   mid-tones are Jet and Crystal mixed.
// The pictures carry no metadata (sharp writes none).
import { mkdirSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { BW_DARK, BW_LIGHT } from "../src/pipeline/bw.js";
import { lightnessOnWhite } from "../src/pipeline/holes.js";
import { LAYOUT_TARGET_PITCH_MM } from "../src/pipeline/layout.js";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const OUT = new URL("../public/examples/", import.meta.url);
const LAYOUT = JSON.parse(readFileSync(new URL("is03b/cat-rule.json", FIXTURES), "utf8"));
const AI = new URL("is03b-ai/cat-rule-output.png", FIXTURES).pathname;
// The cat's face (its two pupils are at about (92, 65) and (129, 71) mm), and the picture's size.
const VIEW = { x0: 52, y0: 18, w: 114, h: 96 };
const WIDTH_PX = 320;
const PX_PER_MM = 8;
const BOLD_THRESHOLD = 62;
const BOLD_NEAR_MM = 2.6;
const BOLD_OUTVOTE = 0.75;
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const SHADE = { dark: 30, light: 80 };

const { data, info } = await sharp(AI).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ai = { data, width: info.width, height: info.height };
const { mmPerPx, offsetMm } = LAYOUT.report;
const stones = LAYOUT.stones
  .map(([x, y, size, color]) => ({ x, y, d: getStoneSize(size).diameterMm, color }))
  .filter((s) => s.x > VIEW.x0 - 5 && s.x < VIEW.x0 + VIEW.w + 5 && s.y > VIEW.y0 - 5 && s.y < VIEW.y0 + VIEW.h + 5);
const lightnessAt = (s, dMm) => lightnessOnWhite(ai, (s.x + offsetMm[0]) / mmPerPx, (s.y + offsetMm[1]) / mmPerPx, dMm, mmPerPx);
// The service's pupils stay Jet in both styles.
const pupil = (s) => s.d > getStoneSize("ss16").diameterMm;

function bold() {
  let colours = stones.map((s) => (pupil(s) || lightnessAt(s, s.d) < BOLD_THRESHOLD ? BW_DARK : BW_LIGHT));
  const neighbours = stones.map((s, i) => stones.flatMap((o, j) => (j !== i && Math.hypot(o.x - s.x, o.y - s.y) < BOLD_NEAR_MM ? [j] : [])));
  for (let pass = 0; pass < 2; pass++) {
    colours = colours.map((c, i) => {
      if (pupil(stones[i]) || neighbours[i].length < 3) return c;
      const share = neighbours[i].filter((j) => colours[j] === BW_DARK).length / neighbours[i].length;
      return share >= BOLD_OUTVOTE ? BW_DARK : 1 - share >= BOLD_OUTVOTE ? BW_LIGHT : c;
    });
  }
  return colours;
}

function shaded() {
  return stones.map((s) => {
    if (pupil(s)) return BW_DARK;
    const tone = Math.min(1, Math.max(0, (lightnessAt(s, s.d) - SHADE.dark) / (SHADE.light - SHADE.dark)));
    const i = Math.round(s.x / LAYOUT_TARGET_PITCH_MM), j = Math.round(s.y / LAYOUT_TARGET_PITCH_MM);
    return tone > (BAYER[j % 4][i % 4] + 0.5) / 16 ? BW_LIGHT : BW_DARK;
  });
}

async function picture(colours, file) {
  const layout = new StoneLayout({
    layerId: "design", sourceMode: "is",
    stones: stones.map((s, index) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: colours[index], layerId: "design", index }))
  });
  const box = tintCanvasMm(layout);
  const { png, scale } = renderTinted(layout, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * PX_PER_MM), background: "white", bwGap: "crystal" });
  const left = Math.round((VIEW.x0 - box.minXmm) * scale), top = Math.round((VIEW.y0 - box.minYmm) * scale);
  await sharp(png)
    .extract({ left, top, width: Math.round(VIEW.w * scale), height: Math.round(VIEW.h * scale) })
    .resize({ width: WIDTH_PX })
    .png({ compressionLevel: 9, palette: true, colours: 64 })
    .toFile(new URL(file, OUT).pathname);
}

mkdirSync(OUT, { recursive: true });
await picture(bold(), "bw-bold.png");
await picture(shaded(), "bw-shaded.png");
console.log("public/examples/bw-bold.png, public/examples/bw-shaded.png");
