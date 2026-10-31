// PN-04d: the Colour portrait sheets for the listing, no provider call:
//   node tools/make-portrait-sheets.mjs --candidates
//   node tools/make-portrait-sheets.mjs --overview
// --candidates: docs/listing/portraits/candidates.png, the photos in docs/listing/portraits/candidates.json
// (Wikimedia Commons, CC0; the files in data/listing/candidates/portraits/, git-ignored) on one sheet,
// each labelled with its number, licence and Commons file name.
// --overview: docs/listing/portraits/overview.png, each portrait design made by
// tools/make-listing-designs.mjs (data/listing/designs/<id>-colour/, git-ignored) as its prepared photo
// next to its tinted render, labelled with the candidate's number, stone count and natural size.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = new URL("../", import.meta.url).pathname;
const DIR = path.join(ROOT, "docs/listing/portraits");
const FULL = path.join(ROOT, "data/listing/designs");
const CANDIDATES = JSON.parse(readFileSync(path.join(DIR, "candidates.json"), "utf8"));
const SMALL_PNG = { compressionLevel: 9, palette: true, quality: 100, effort: 10 };
const INK = "#14285a", CELL_BG = "#f3f5f9";

// Each cell: a label line above, the image fitted into CELL_W x CELL_H on a light grey ground.
async function sheet(file, cols, cells, CELL_W, CELL_H) {
  const GAP = 24, LABEL_H = 40;
  const rows = Math.ceil(cells.length / cols);
  const W = GAP + cols * (CELL_W + GAP), H = GAP + rows * (LABEL_H + CELL_H + GAP);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  for (const [i, { label, images }] of cells.entries()) {
    const x0 = GAP + (i % cols) * (CELL_W + GAP), y0 = GAP + Math.floor(i / cols) * (LABEL_H + CELL_H + GAP);
    ctx.fillStyle = INK;
    ctx.font = "bold 19px sans-serif";
    ctx.fillText(label, x0, y0 + 26, CELL_W);
    const w = (CELL_W - (images.length - 1) * 12) / images.length;
    for (const [j, image] of images.entries()) {
      const img = await loadImage(await sharp(readFileSync(image)).rotate().resize(1200, 1200, { fit: "inside" }).png().toBuffer());
      const s = Math.min(w / img.width, CELL_H / img.height);
      const cx = x0 + j * (w + 12), cy = y0 + LABEL_H;
      ctx.fillStyle = CELL_BG;
      ctx.fillRect(cx, cy, w, CELL_H);
      ctx.drawImage(img, cx + (w - img.width * s) / 2, cy + (CELL_H - img.height * s) / 2, img.width * s, img.height * s);
    }
  }
  writeFileSync(file, await sharp(await canvas.encode("png")).png(SMALL_PNG).toBuffer());
  console.log(`${file} ${W} x ${H}`);
}

if (process.argv.includes("--candidates")) {
  await sheet(path.join(DIR, "candidates.png"), 3, CANDIDATES.map((c) => ({
    label: `${c.n} · ${c.licence} · ${c.title}`,
    images: [path.resolve(DIR, c.photo)]
  })), 600, 600);
} else if (process.argv.includes("--overview")) {
  const made = CANDIDATES.filter((c) => existsSync(path.join(FULL, `${c.id}-colour`, "stats.json")));
  if (!made.length) throw new Error(`no portrait designs in ${FULL}`);
  await sheet(path.join(DIR, "overview.png"), 2, made.map((c) => {
    const d = path.join(FULL, `${c.id}-colour`);
    const s = JSON.parse(readFileSync(path.join(d, "stats.json"), "utf8"));
    return {
      label: `${c.n} · ${s.stones} stones · ${s.widthMm} × ${s.heightMm} mm (${s.widthIn} × ${s.heightIn} in)`,
      images: [path.join(d, "prepared.png"), path.join(d, "tinted.png")]
    };
  }), 920, 560);
} else {
  throw new Error("usage: node tools/make-portrait-sheets.mjs --candidates | --overview");
}
