import { ZipArchive } from "archiver";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { BRAND, SITE_URL } from "../brand.js";
import { attemptDir } from "../prep/archive.js";
import { MIN_GAP_MM } from "../pipeline/tiers.js";
import { renderFull } from "../render/tinted.js";
import { STONE_COLORS } from "../stones/StoneColors.js";
import { StoneLayout } from "../stones/StoneLayout.js";
import { findStoneSizeByDiameterMm } from "../stones/StoneSizes.js";
import { designAi } from "./aiExport.js";
import { designDxf } from "./dxfExport.js";
import { designEps } from "./epsExport.js";
import { withInfo } from "./pdfInfo.js";
import { designPng } from "./pngExport.js";
import { productionSheetToPdf } from "./ProductionSheetExporter.js";
import { designSvg } from "./svgExport.js";

// The delivery ZIP (spec section 9): every file at the natural size, all made from the final
// StoneLayout (attempt-<n>/stones.json) and the full tinted render (attempt-<n>/tinted.png).
// Stored as data/delivery/<code>/<code>.zip; nothing in the archive is written or changed.

const MM_PER_INCH = 25.4;
export const SHEET_MARGIN_MM = 10;
export const SHEETS = Object.freeze([
  Object.freeze({ name: "production-sheet-A4.pdf", pageSize: "A4", units: "mm" }),
  Object.freeze({ name: "production-sheet-Letter.pdf", pageSize: "Letter", units: "in" })
]);

// The ZIP's file names, in the order of the spec's table.
export function zipEntryNames(code) {
  return [
    `${code}.svg`, ...SHEETS.map((s) => s.name), `${code}.ai`, `${code}.eps`, `${code}.dxf`, `${code}.png`,
    `${code}-preview.png`, "README.txt"
  ];
}

const sizeName = (d) => findStoneSizeByDiameterMm(d)?.name ?? `${d} mm`;
const colourName = (id) => STONE_COLORS[id]?.name ?? id;
const fixed = (v, p) => (Math.round(v * 10 ** p) / 10 ** p).toFixed(p);

function counts(stones, keyOf) {
  const out = new Map();
  for (const s of stones) out.set(keyOf(s), (out.get(keyOf(s)) || 0) + 1);
  return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function naturalSizeText(stoneLayout) {
  const { widthMm, heightMm } = stoneLayout;
  return `${fixed(widthMm, 1)} × ${fixed(heightMm, 1)} mm (${fixed(widthMm / MM_PER_INCH, 2)} × ${fixed(heightMm / MM_PER_INCH, 2)} in)`;
}

export function readmeText(stoneLayout, code) {
  const bySize = counts(stoneLayout.stones, (s) => sizeName(s.sizeMm));
  const byColour = counts(stoneLayout.stones, (s) => colourName(s.color));
  const files = [
    [`${code}.svg`, "the stones as vector circles at true size"],
    ["production-sheet-A4.pdf", "printable production sheet on A4 paper, sizes in mm"],
    ["production-sheet-Letter.pdf", "printable production sheet on US Letter paper, sizes in inches"],
    [`${code}.ai`, "vector file for Adobe Illustrator (PDF-compatible), true size"],
    [`${code}.eps`, "vector file (EPS), true size"],
    [`${code}.dxf`, "cutting template in mm, one layer per colour"],
    [`${code}.png`, "the stones at 300 dpi, transparent background, true size"],
    [`${code}-preview.png`, "preview of the finished design"],
    ["README.txt", "this file"]
  ];
  const width = Math.max(...files.map(([name]) => name.length));
  return [
    `${BRAND} design ${code}`,
    SITE_URL,
    "",
    `Size: ${naturalSizeText(stoneLayout)}`,
    `Stones: ${stoneLayout.count}`,
    "",
    "Stones per size:",
    ...bySize.map(([name, n]) => `  ${name}: ${n}`),
    "",
    "Stones per colour:",
    ...byColour.map(([name, n]) => `  ${name}: ${n}`),
    "",
    "Files:",
    ...files.map(([name, what]) => `  ${name.padEnd(width)}  ${what}`),
    "",
    "How to use:",
    "  1. Print a production sheet at 100 % (actual size, no \"fit to page\"). The scale bar must",
    "     measure exactly 50 mm. A large design is printed on several pages; the cover page shows",
    "     how they fit together.",
    "  2. To cut a template (flock or rhinestone template material), open the SVG, AI, EPS or DXF",
    "     file in your cutting software at 100 % and cut the circles.",
    "  3. Place the stones colour by colour, using the production sheet as the guide.",
    ""
  ].join("\r\n");
}

// StoneLayout + code + the full tinted render -> [{ name, data }] in zipEntryNames() order.
export async function designFiles(stoneLayout, { code, tintedPng }) {
  const title = `${BRAND} design ${code}`;
  const sheet = (s) => withInfo(productionSheetToPdf(stoneLayout, {
    projectName: title, productionWidthMm: stoneLayout.widthMm, productionHeightMm: stoneLayout.heightMm,
    gapMm: MIN_GAP_MM, pageSize: s.pageSize, units: s.units, marginMm: SHEET_MARGIN_MM, mirror: false, registrationMarks: true
  }), { title });
  const svg = designSvg(stoneLayout);
  const ai = designAi(stoneLayout, { title });
  const files = [
    [`${code}.svg`, Buffer.from(svg, "utf8")],
    ...SHEETS.map((s) => [s.name, sheet(s)]),
    [`${code}.ai`, ai],
    [`${code}.eps`, designEps(stoneLayout, { title })],
    [`${code}.dxf`, Buffer.from(designDxf(stoneLayout), "utf8")],
    [`${code}.png`, designPng(svg).png],
    [`${code}-preview.png`, tintedPng],
    ["README.txt", Buffer.from(readmeText(stoneLayout, code), "utf8")]
  ];
  return files.map(([name, data]) => ({ name, data }));
}

// [{ name, data }] -> a ZIP (deflate) at `file`, written to a temporary name first.
export async function writeZip(files, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const done = pipeline(archive, createWriteStream(tmp));
    for (const { name, data } of files) archive.append(data, { name });
    await archive.finalize();
    await done;
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return file;
}

export function deliveryZipPath(deliveryDir, code) {
  return path.join(deliveryDir, code, `${code}.zip`);
}

// The delivery ZIP of attempt n of a code, rebuilt from the archive. A design made before the
// tinted render existed has no tinted.png; its preview is rendered here (and not archived).
export async function buildDeliveryZip({ archiveDir, deliveryDir, code, n }) {
  const dir = attemptDir(archiveDir, code, n);
  const stoneLayout = StoneLayout.fromJSON(JSON.parse(readFileSync(path.join(dir, "stones.json"), "utf8")));
  const tintedFile = path.join(dir, "tinted.png");
  const tintedPng = existsSync(tintedFile) ? readFileSync(tintedFile) : renderFull(stoneLayout).png;
  const files = await designFiles(stoneLayout, { code, tintedPng });
  return writeZip(files, deliveryZipPath(deliveryDir, code));
}
