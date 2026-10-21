// IS-05 tinted comparison for docs/IS-05-tinted-comparison.md, run by hand (no provider or strass
// call): for the 8 accepted IS-03b designs, the IS-03b car and the 12 RS test layouts, one image per
// design with four panels side by side: the original image, the AI image the layout was made from,
// plain stones (faceted stones on white, no fill) and tinted (spec section 8). Plus a zoomed eye
// crop, plain vs tinted, for 3 designs. The AI image is a docs-only column: the app never shows it
// (spec D4).
//   node tools/tinted-comparison.mjs [<runs dir>]
// The IS-03b AI images are the fixtures in tools/fixtures/is03b-ai; the RS AI images are the RS
// test images. Each design is the delivered one (cleanedLayout: the size cap and the overlap
// cleanup) of the strass /layout answer: <runs dir>/<run>.default.json of
// services/strass/scripts/is05b_runs.py or is05c_runs.py (today's service rules) when given, else the saved
// fixture (RS 38cd831 rules). Plain and tinted share one canvas (the tinted canvas: stones'
// box + 2 main-stone margins) at the same px per mm; the original is shown at the same height.
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { getCrystalAppearance } from "../src/stones/CrystalAppearance.js";
import { drawCrystalStone } from "../src/stones/CrystalStoneRenderer.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { findStoneSizeByDiameterMm } from "../src/stones/StoneSizes.js";
import { ALL_DESIGNS, layoutOf } from "./is05b-measure.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, "docs/IS-05-tinted-comparison");
const DOC = path.join(ROOT, "docs/IS-05-tinted-comparison.md");
const PHOTOS = path.join(ROOT, "services/strass/tests/fixtures/photos");
const RS_IMAGES = path.join(ROOT, "services/strass/prototype/img");
const PANEL_PX = 640;     // the stone panels' long side
const GAP_PX = 12;
const EYE_PX_PER_MM = 36; // zoomed crops
const EYE_REACH_MM = 6;   // stones this far outside the crop are rendered too (tint reach < 3 mm)

const RUNS = process.argv[2] || null;
const GROUP = (id) => (id === "car-rule" ? "IS-03b car" : id.startsWith("rs-") ? "RS test layouts" : "IS-03b (accepted)");
const DESIGNS = ALL_DESIGNS.map((d) => ({
  ...d, group: GROUP(d.id),
  original: d.id.startsWith("rs-") ? path.join(RS_IMAGES, `N2_${d.id.slice(3)}.png`) : path.join(PHOTOS, `${d.id.split("-")[0]}.jpg`)
}));
// The car last of the IS-03b designs, as before.
DESIGNS.sort((a, b) => ["IS-03b (accepted)", "IS-03b car", "RS test layouts"].indexOf(a.group) - ["IS-03b (accepted)", "IS-03b car", "RS test layouts"].indexOf(b.group));
const EYES = ["dog-rule", "cat-rule", "rs-portrait"];

const sizeName = (d) => findStoneSizeByDiameterMm(d)?.name ?? `${d} mm`;

// Plain stones: the RS faceted renderer on white, no tint, on the given canvas (mm box, px per mm).
function renderPlain(stoneLayout, box, scale) {
  const widthPx = Math.round(box.widthMm * scale);
  const heightPx = Math.round(box.heightMm * scale);
  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  for (const stone of stoneLayout.stones) {
    drawCrystalStone(ctx, (stone.xMm - box.minXmm) * scale, (stone.yMm - box.minYmm) * scale, (stone.sizeMm / 2) * scale, stone.color, getCrystalAppearance(stone));
  }
  return canvas.toBuffer("image/png");
}

const flatten = (png) => sharp(png).flatten({ background: "#ffffff" });

async function row(design, stoneLayout) {
  const box = tintCanvasMm(stoneLayout);
  const tinted = renderTinted(stoneLayout, { longSidePx: PANEL_PX, background: "white" });
  const plain = renderPlain(stoneLayout, box, tinted.scale);
  const height = tinted.heightPx;
  const original = await flatten(readFileSync(design.original)).resize({ height }).png().toBuffer({ resolveWithObject: true });
  const ai = await flatten(readFileSync(design.ai)).resize({ height }).png().toBuffer({ resolveWithObject: true });
  const panels = [original.data, ai.data, plain, tinted.png];
  const widths = [original.info.width, ai.info.width, tinted.widthPx, tinted.widthPx];
  const width = widths.reduce((a, b) => a + b, 0) + GAP_PX * (panels.length - 1);
  let left = 0;
  const composite = panels.map((input, i) => {
    const at = { input, left, top: 0 };
    left += widths[i] + GAP_PX;
    return at;
  });
  const file = `${design.id}.jpg`;
  await sharp({ create: { width, height, channels: 3, background: "#e6e9ef" } })
    .composite(composite).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT_DIR, file));
  return file;
}

// The eye area: the box around the two largest stones (the pupils) plus 7 mm on every side.
function eyeWindow(stoneLayout) {
  const [a, b] = [...stoneLayout.stones].sort((s, t) => t.sizeMm - s.sizeMm);
  const pad = 7;
  const minX = Math.min(a.xMm, b.xMm) - pad, maxX = Math.max(a.xMm, b.xMm) + pad;
  const minY = Math.min(a.yMm, b.yMm) - pad, maxY = Math.max(a.yMm, b.yMm) + pad;
  return { minXmm: minX, minYmm: minY, widthMm: maxX - minX, heightMm: maxY - minY };
}

// Plain and tinted of the window at EYE_PX_PER_MM, rendered from the stones near it only (the tint
// of a pixel depends only on stones within reach, so the crop is exact).
async function eyeCrop(design, stoneLayout) {
  const win = eyeWindow(stoneLayout);
  const near = stoneLayout.stones.filter((s) => s.xMm > win.minXmm - EYE_REACH_MM && s.xMm < win.minXmm + win.widthMm + EYE_REACH_MM &&
    s.yMm > win.minYmm - EYE_REACH_MM && s.yMm < win.minYmm + win.heightMm + EYE_REACH_MM);
  const sub = new StoneLayout({ layerId: "eye", stones: near });
  const box = tintCanvasMm(sub);
  const longSidePx = Math.round(Math.max(box.widthMm, box.heightMm) * EYE_PX_PER_MM);
  const tinted = renderTinted(sub, { longSidePx, background: "white" });
  const plain = renderPlain(sub, box, tinted.scale);
  const extract = {
    left: Math.round((win.minXmm - box.minXmm) * tinted.scale), top: Math.round((win.minYmm - box.minYmm) * tinted.scale),
    width: Math.round(win.widthMm * tinted.scale), height: Math.round(win.heightMm * tinted.scale)
  };
  const crops = await Promise.all([plain, tinted.png].map((png) => sharp(png).extract(extract).png().toBuffer()));
  const file = `${design.id}-eyes.jpg`;
  await sharp({ create: { width: extract.width * 2 + GAP_PX, height: extract.height, channels: 3, background: "#e6e9ef" } })
    .composite([{ input: crops[0], left: 0, top: 0 }, { input: crops[1], left: extract.width + GAP_PX, top: 0 }])
    .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(OUT_DIR, file));
  return { file, win };
}

function stats(stoneLayout) {
  const bySize = new Map();
  for (const s of stoneLayout.stones) bySize.set(sizeName(s.sizeMm), (bySize.get(sizeName(s.sizeMm)) || 0) + 1);
  const sizes = [...bySize].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ");
  const w = stoneLayout.widthMm, h = stoneLayout.heightMm;
  return `${stoneLayout.count} stones (${sizes}) · ${w.toFixed(1)} × ${h.toFixed(1)} mm (${(w / 25.4).toFixed(2)} × ${(h / 25.4).toFixed(2)} in)`;
}

mkdirSync(OUT_DIR, { recursive: true });
const rows = [];
const eyes = [];
for (const design of DESIGNS) {
  const layout = layoutOf(design, RUNS);
  const { stoneLayout } = cleanedLayout(layout);
  rows.push({ design, file: await row(design, stoneLayout), stats: stats(stoneLayout) });
  if (EYES.includes(design.id)) eyes.push({ design, ...(await eyeCrop(design, stoneLayout)) });
  console.log(design.id, stats(stoneLayout));
}

const lines = [
  "# IS-05 tinted comparison",
  "",
  "Docs only. Made by `node tools/tinted-comparison.mjs <runs dir>` with no provider call. Re-rendered",
  "for IS-05c (21 Oct 2026) with the settings of that build: the tinted renderer of spec section 8 (each",
  "stone within 2 L* of its catalogue colour and its inner 60 % within 4, gaps 4 L* darker than the fill,",
  "a little more above L* 80, and 8 L* on near-white fills above L* 85, filled up to 0.6 mm beyond every",
  "stone's edge, a large Jet stone's light rim as wide as an SS6 stone's), and each design laid out again",
  "by today's strass service from its saved AI image (`services/strass/scripts/is05c_runs.py`, rules",
  "`DEFAULT`: soft outlines off, plausible pupils, the one plausible pair kept of more than two, colours",
  "read at the delivered stones, no iris rings around a person's pupils, skin colours read from the inner",
  "60 % of each stone). Re-rendered again for IS-06 (21 Oct 2026) with today's `DEFAULT`, which since",
  "IS-05d also has `warm_shadow` on (3 ΔE): stones, sizes and natural sizes are unchanged, only some skin",
  "colours differ (12 of the images).",
  "",
  "Each row shows four images side by side:",
  "",
  "1. **Original**: for the IS-03b designs, the buyer photo the design was made from (before background",
  "   removal and the model-input crop, so the framing differs from the design); for the RS test layouts,",
  "   the RS test image (there is no other original: the RS test images are themselves model outputs, so",
  "   columns 1 and 2 are the same image on those rows).",
  "2. **AI image**: the model output the strass service laid out (IS-05b; docs only, the app never",
  "   shows it, spec D4). For the IS-03b designs, the saved provider output of IS-03b.",
  "3. **Plain stones**: the faceted stones (RS `drawCrystalStone`) on white, with no fill between them.",
  "4. **Tinted**: `renderTinted` as in the app's preview, without the watermark.",
  "",
  "Plain and tinted use the same canvas (the stones' box plus 2 main-stone diameters) at the same",
  "pixels per mm (640 px on the long side). The original and the AI image are scaled to the same height. Each design",
  "is the delivered one: the strass `/layout` answer after the size cap (a face's two pupils SS20, every other",
  "stone at most SS16) and the overlap cleanup.",
  "Under each row: stone count, stones per size, and the natural size.",
  ""
];
let group = null;
for (const r of rows) {
  if (r.design.group !== group) {
    group = r.design.group;
    lines.push(`## ${group}`, "");
  }
  lines.push(`### ${r.design.id}`, "", `![${r.design.id}: original, AI image, plain stones, tinted](IS-05-tinted-comparison/${r.file})`, "", r.stats, "");
}
lines.push(
  "## Eye area up close",
  "",
  `Plain (left) and tinted (right), ${EYE_PX_PER_MM} px per mm, for 3 designs. Each crop is the box`,
  "around the two largest stones (the pupils) plus 7 mm on every side, so the gaps between the stones",
  "can be judged at close range.",
  ""
);
for (const e of eyes) {
  const { win } = e;
  lines.push(`### ${e.design.id}`, "", `![${e.design.id} eye area: plain, tinted](IS-05-tinted-comparison/${e.file})`, "",
    `Crop ${win.widthMm.toFixed(1)} × ${win.heightMm.toFixed(1)} mm at x ${win.minXmm.toFixed(1)}, y ${win.minYmm.toFixed(1)} mm.`, "");
}
writeFileSync(DOC, `${lines.join("\n")}\n`);
