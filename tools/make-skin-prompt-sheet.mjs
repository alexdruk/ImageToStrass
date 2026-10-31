// PN-10: docs/skin-prompt.png, no provider call:
//   node tools/make-skin-prompt-sheet.mjs <rows.json> <out.png>
// rows.json: [{ subject, note, photo, before: { tinted, label }, after: { tinted, label } }] with
// file paths (the prepared photo and the tinted renders of the PN-10 runs, git-ignored). One row
// per subject: the photo, the best before design and the best after design, side by side, each
// labelled (the label says the run and its face ΔL*).
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = new URL("../", import.meta.url).pathname;
for (const w of ["Regular", "SemiBold"]) GlobalFonts.registerFromPath(path.join(ROOT, `tools/fonts/Inter-${w}.ttf`));
const [rowsFile, outFile] = process.argv.slice(2);
if (!outFile) throw new Error("usage: node tools/make-skin-prompt-sheet.mjs <rows.json> <out.png>");
const rows = JSON.parse(readFileSync(rowsFile, "utf8"));

const CELL = 520, GAP = 24, LEFT = 230, HEAD = 70, LABEL = 56;
const W = LEFT + 3 * CELL + 4 * GAP, ROW = CELL + LABEL + GAP;
const canvas = createCanvas(W, HEAD + rows.length * ROW);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#0e1730";
ctx.font = "600 28px Inter";
for (const [i, h] of ["Photo", "Before (prompt 3), best run", "After (prompt 4), best run"].entries()) ctx.fillText(h, LEFT + GAP + i * (CELL + GAP), 46);

// The visible part of a (transparent) image fitted into CELL x CELL on a light ground.
async function cell(file, x, y) {
  const trimmed = await sharp(readFileSync(file)).trim({ threshold: 0 }).resize(CELL, CELL, { fit: "inside" })
    .flatten({ background: "#ffffff" }).png().toBuffer();
  const img = await loadImage(trimmed);
  ctx.fillStyle = "#f3f5f9";
  ctx.fillRect(x, y, CELL, CELL);
  ctx.drawImage(img, x + (CELL - img.width) / 2, y + (CELL - img.height) / 2);
}

for (const [k, r] of rows.entries()) {
  const y = HEAD + k * ROW;
  ctx.fillStyle = "#0e1730";
  ctx.font = "600 26px Inter";
  ctx.fillText(r.subject, 20, y + 40, LEFT - 30);
  ctx.fillStyle = "#5a6680";
  ctx.font = "400 20px Inter";
  let ly = y + 74;
  for (const line of (r.note || "").split("\n")) { ctx.fillText(line, 20, ly, LEFT - 30); ly += 28; }
  const cells = [[r.photo, "Prepared photo"], [r.before.tinted, r.before.label], [r.after.tinted, r.after.label]];
  for (const [i, [file, label]] of cells.entries()) {
    const x = LEFT + GAP + i * (CELL + GAP);
    await cell(file, x, y);
    ctx.fillStyle = "#0e1730";
    ctx.font = "400 21px Inter";
    ctx.fillText(label, x, y + CELL + 34, CELL);
  }
}
writeFileSync(outFile, await sharp(await canvas.encode("png")).png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 }).toBuffer());
console.log(`${outFile} ${canvas.width} x ${canvas.height}`);
