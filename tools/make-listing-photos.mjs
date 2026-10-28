// PN-04b: the Etsy listing photos, made from the PN-04a listing designs with no provider call:
//   node tools/make-listing-photos.mjs
// Reads only the designs marked "use in listing: yes" in docs/listing/README.md, from their full-size
// files in data/listing/designs/<id>/ (prepared.png, tinted.png, stats.json; git-ignored), and for
// photo 05 the final StoneLayout of mastiff-bw-stencil from its PN-04a run in data/listing/runs/
// (stones.json, checked against the design by its tinted.png). Never anything from
// data/private-portraits/ or data/archive/.
// Writes docs/listing/photos/<nn>-<name>.jpg (PHOTO_W x PHOTO_H, sRGB, each under MAX_BYTES) and
// overview.png (every photo on one sheet, at most OVERVIEW_W wide). Running it twice gives the same
// files.
// Everything important stays inside the centre PHOTO_H x PHOTO_H square (Etsy crops the thumbnail).
// Text is Inter (SIL OFL, tools/fonts/); colours are the web app's (public/styles.css).
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { BRAND } from "../src/brand.js";
import { designFiles, zipEntryNames } from "../src/export/zip.js";
import { MARGIN_STONES } from "../src/render/tinted.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

const ROOT = new URL("../", import.meta.url).pathname;
const FULL = path.join(ROOT, "data/listing/designs");
const RUNS = path.join(ROOT, "data/listing/runs");
const OUT = path.join(ROOT, "docs/listing/photos");
const PHOTO_W = 2700, PHOTO_H = 2025;
const MAX_BYTES = 1024 * 1024;
const QUALITY = { start: 92, step: 2, min: 80 };
const OVERVIEW_W = 2000;
const EXAMPLE_CODE = "PN-7K3Q-9XPA";
const FOOTER = "Digital template · no stones included";
// Designs this script may use (docs/listing/README.md, "use in listing: yes"); parrot-colour and
// person-colour are "no" and never read.
const ALLOWED = new Set([
  "butterfly-colour", "car-colour", "dahlia-colour", "hedgehog-colour", "mastiff-colour", "mastiff-bw-stencil",
  "mastiff-bw-halftone", "person-bw-stencil", "person-bw-halftone", "stag-beetle-colour"
]);

const C = {
  bg: "#ffffff", surface: "#f6f8fc", line: "#e2e7f0", lineStrong: "#c9d2e3", ink: "#0e1730", muted: "#5a6680",
  blue: "#123a8c", blueInk: "#0b2766", blueSoft: "#eaf0fb", blueMid: "#3d63b8", logoDot: "#8fb0f2"
};
for (const w of ["Regular", "SemiBold", "Bold"]) GlobalFonts.registerFromPath(path.join(ROOT, `tools/fonts/Inter-${w}.ttf`));
const FONT = "Inter";

// The centre square and the bands every photo shares.
const SAFE = { x0: (PHOTO_W - PHOTO_H) / 2, x1: (PHOTO_W + PHOTO_H) / 2 };
const SAFE_W = SAFE.x1 - SAFE.x0;
const CX = PHOTO_W / 2;
const BRAND_Y = 105, TITLE_Y = 300, TITLE_PX = 104;
const TOP = 390, BOTTOM = 1880, FOOTER_Y = 1975;

// ---- designs ----

function design(id) {
  if (!ALLOWED.has(id)) throw new Error(`${id} is not marked "use in listing: yes"`);
  const dir = path.join(FULL, id);
  const stats = JSON.parse(readFileSync(path.join(dir, "stats.json"), "utf8"));
  return { id, dir, stats, tinted: path.join(dir, "tinted.png"), prepared: path.join(dir, "prepared.png") };
}

// The tinted render's scale (px per mm) and the stones' box in its pixels: renderTinted puts the
// stones' box plus MARGIN_STONES main-stone diameters on each side at its long side.
async function tintedGeometry(d) {
  const { width, height } = await sharp(d.tinted).metadata();
  const main = Object.entries(d.stats.bySize).sort((a, b) => b[1] - a[1])[0][0];
  const m = MARGIN_STONES * getStoneSize(main).diameterMm;
  const scale = Math.max(width, height) / (Math.max(d.stats.widthMm, d.stats.heightMm) + 2 * m);
  return { width, height, scale, box: { x: m * scale, y: m * scale, w: d.stats.widthMm * scale, h: d.stats.heightMm * scale } };
}

// The box of a transparent image's visible pixels (alpha above 8).
async function alphaBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// A region of an image resized (Lanczos) to w x h on white, as a canvas Image.
async function picture(file, region, w, h) {
  const png = await sharp(file).extract(region)
    .resize(Math.round(w), Math.round(h), { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: "#ffffff" }).png().toBuffer();
  return loadImage(png);
}

// The visible part of an image fitted into boxW x boxH -> { img, w, h }.
async function fitted(file, boxW, boxH) {
  const region = await alphaBox(file);
  const s = Math.min(boxW / region.width, boxH / region.height);
  const w = Math.round(region.width * s), h = Math.round(region.height * s);
  return { img: await picture(file, region, w, h), w, h };
}

// The visible part of a tinted render at pxPerMm (the same scale for every design of one photo).
async function atScale(d, pxPerMm) {
  const g = await tintedGeometry(d);
  const region = await alphaBox(d.tinted);
  const s = pxPerMm / g.scale;
  const w = Math.round(region.width * s), h = Math.round(region.height * s);
  return { img: await picture(d.tinted, region, w, h), w, h, mm: { w: region.width / g.scale, h: region.height / g.scale } };
}
async function sizeMm(d) {
  const g = await tintedGeometry(d);
  const region = await alphaBox(d.tinted);
  return { w: region.width / g.scale, h: region.height / g.scale };
}

// ---- drawing ----

function font(px, weight = 400) {
  return `${weight} ${px}px ${FONT}`;
}

function text(ctx, s, x, y, { px, weight = 400, color = C.ink, align = "center", maxW = null }) {
  let size = px;
  ctx.font = font(size, weight);
  while (maxW && ctx.measureText(s).width > maxW && size > 20) ctx.font = font(--size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(s, x, y);
  return size;
}

function wrap(ctx, s, maxW) {
  const lines = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return [...lines, line];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// The app's logo (public/logo.svg: a 64 x 64 blue tile with eight white stones) at size px.
function logo(ctx, x, y, size) {
  const k = size / 64;
  ctx.fillStyle = C.blue;
  roundRect(ctx, x, y, size, size, 16 * k);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  for (const [cx, cy] of [[20, 17], [20, 32], [20, 47], [46, 17], [36, 22], [44, 32], [36, 42], [44, 47]]) {
    ctx.beginPath();
    ctx.arc(x + cx * k, y + cy * k, 4 * k, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = C.logoDot;
  ctx.beginPath();
  ctx.arc(x + 32 * k, y + 32 * k, 2.2 * k, 0, 2 * Math.PI);
  ctx.fill();
}

// White photo with the brand row on top, an optional title and the footer line.
function frame({ title = null, footer = true } = {}) {
  const canvas = createCanvas(PHOTO_W, PHOTO_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  const L = 76;
  ctx.font = font(54, 600);
  const nameW = ctx.measureText(BRAND).width;
  const x = CX - (L + 22 + nameW) / 2;
  logo(ctx, x, BRAND_Y - L / 2, L);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = C.blueInk;
  ctx.fillText(BRAND, x + L + 22, BRAND_Y + 2);
  if (title) text(ctx, title, CX, TITLE_Y, { px: TITLE_PX, weight: 700, maxW: SAFE_W - 40 });
  if (footer) text(ctx, FOOTER, CX, FOOTER_Y, { px: 42, color: C.muted });
  return { canvas, ctx };
}

function arrow(ctx, x0, x1, y, { width = 18, head = 64, color = C.blue } = {}) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 - head * 0.8, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x1 - head, y - head * 0.62);
  ctx.lineTo(x1 - head, y + head * 0.62);
  ctx.closePath();
  ctx.fill();
}

const draw = (ctx, p, x, y) => ctx.drawImage(p.img, Math.round(x), Math.round(y), p.w, p.h);

// ---- photos ----

async function mainPhoto(id) {
  const d = design(id);
  const { canvas, ctx } = frame({ title: "Your photo → rhinestone template" });
  const boxW = 860, boxH = BOTTOM - TOP - 40, gap = SAFE_W - 2 * boxW;
  const midY = (TOP + BOTTOM) / 2;
  const left = await fitted(d.prepared, boxW, boxH);
  const right = await fitted(d.tinted, boxW, boxH);
  draw(ctx, left, SAFE.x0 + (boxW - left.w) / 2, midY - left.h / 2);
  draw(ctx, right, SAFE.x1 - boxW + (boxW - right.w) / 2, midY - right.h / 2);
  arrow(ctx, SAFE.x0 + boxW + gap * 0.22, SAFE.x0 + boxW + gap * 0.78, midY);
  return canvas;
}

// Two black & white styles of one subject at the same scale, labelled, with the prepared photo small
// above them (landscape) or between them (portrait).
async function twoStyles(subject, title) {
  const bold = design(`${subject}-bw-stencil`), shaded = design(`${subject}-bw-halftone`);
  const { canvas, ctx } = frame({ title });
  const sizes = [await sizeMm(bold), await sizeMm(shaded)];
  const portrait = sizes[0].h > sizes[0].w;
  const LABEL = 110, GAP = 50;
  let photo, cols, top, avail;
  if (portrait) {
    const photoW = 330;
    const colW = (SAFE_W - photoW - 2 * GAP) / 2;
    photo = await fitted(bold.prepared, photoW, 600);
    cols = [SAFE.x0, SAFE.x1 - colW].map((x) => ({ x, w: colW }));
    top = TOP;
    avail = BOTTOM - TOP - LABEL;
  } else {
    photo = await fitted(bold.prepared, 600, 330);
    const colW = (SAFE_W - GAP) / 2;
    cols = [SAFE.x0, SAFE.x1 - colW].map((x) => ({ x, w: colW }));
    top = TOP + photo.h + 40;
    avail = BOTTOM - top - LABEL;
  }
  const pxPerMm = Math.min(...sizes.flatMap((s, i) => [cols[i].w / s.w, avail / s.h]));
  const pics = [await atScale(bold, pxPerMm), await atScale(shaded, pxPerMm)];
  const maxH = Math.max(...pics.map((p) => p.h));
  const y0 = top + (avail - maxH) / 2;
  for (const [i, p] of pics.entries()) {
    const x = cols[i].x + (cols[i].w - p.w) / 2;
    draw(ctx, p, x, y0 + maxH - p.h);
    text(ctx, ["Bold", "Shaded"][i], cols[i].x + cols[i].w / 2, y0 + maxH + 85, { px: 64, weight: 600, color: C.blue });
  }
  if (portrait) draw(ctx, photo, CX - photo.w / 2, y0 + (maxH - photo.h) / 2);
  else draw(ctx, photo, CX - photo.w / 2, TOP);
  return canvas;
}

async function range() {
  const ids = ["car-colour", "stag-beetle-colour", "hedgehog-colour", "mastiff-colour", "butterfly-colour", "dahlia-colour"];
  const { canvas, ctx } = frame({ title: "Pets, flowers, cars, anything" });
  const COLS = 3, GAP = 40, PAD = 10;
  const cellW = (SAFE_W - (COLS - 1) * GAP) / COLS, cellH = (BOTTOM - TOP - GAP) / 2;
  for (const [i, id] of ids.entries()) {
    const x = SAFE.x0 + (i % COLS) * (cellW + GAP), y = TOP + Math.floor(i / COLS) * (cellH + GAP);
    const p = await fitted(design(id).tinted, cellW - 2 * PAD, cellH - 2 * PAD);
    draw(ctx, p, x + (cellW - p.w) / 2, y + (cellH - p.h) / 2);
  }
  return canvas;
}

function fileTile(ctx, x, y, w, h, label) {
  const fold = w * 0.28;
  ctx.fillStyle = C.blueSoft;
  ctx.strokeStyle = C.blueMid;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  text(ctx, label, x + w / 2, y + h - 30, { px: 30, weight: 700, color: C.blue });
}

async function howItWorks() {
  const d = design("butterfly-colour");
  const { canvas, ctx } = frame({ title: "How it works" });
  const N = 4, GAP = 40, colW = (SAFE_W - (N - 1) * GAP) / N, card = colW - 10;
  // The cards and their two lines of text, centred between the title and the footer.
  const cardY = TOP + (BOTTOM - TOP - card - 250) / 2 + 30;
  const steps = ["Upload your photo", "See your design", "Order on Etsy with your code", "Download your files"];
  for (const [i, label] of steps.entries()) {
    const x = SAFE.x0 + i * (colW + GAP) + (colW - card) / 2, y = cardY;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = C.lineStrong;
    ctx.lineWidth = 4;
    ctx.setLineDash(i === 0 ? [22, 14] : []);
    roundRect(ctx, x, y, card, card, 28);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    if (i === 0) {
      const p = await fitted(d.prepared, card - 80, card - 80);
      draw(ctx, p, x + (card - p.w) / 2, y + (card - p.h) / 2);
    } else if (i === 1) {
      const p = await fitted(d.tinted, card - 60, card - 60);
      draw(ctx, p, x + (card - p.w) / 2, y + (card - p.h) / 2);
    } else if (i === 2) {
      const p = await fitted(d.tinted, card - 120, card - 170);
      draw(ctx, p, x + (card - p.w) / 2, y + 30 + (card - 170 - p.h) / 2);
      const chipW = card - 50, chipH = 84, chipY = y + card - chipH - 36;
      ctx.fillStyle = C.blueSoft;
      roundRect(ctx, x + 25, chipY, chipW, chipH, 18);
      ctx.fill();
      text(ctx, EXAMPLE_CODE, x + card / 2, chipY + 57, { px: 44, weight: 700, color: C.blue, maxW: chipW - 30 });
    } else {
      const p = await fitted(d.tinted, card - 160, card - 230);
      draw(ctx, p, x + (card - p.w) / 2, y + 30 + (card - 230 - p.h) / 2);
      const tw = 96, th = 124, tg = 16, labels = ["SVG", "PDF", "DXF", "PNG"];
      const tx = x + (card - (labels.length * tw + (labels.length - 1) * tg)) / 2;
      for (const [j, l] of labels.entries()) fileTile(ctx, tx + j * (tw + tg), y + card - th - 36, tw, th, l);
    }
    // The step's number, on the card's top edge.
    const R = 52, nx = x + card / 2, ny = y;
    ctx.fillStyle = C.blue;
    ctx.beginPath();
    ctx.arc(nx, ny, R, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = font(58, 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), nx, ny + 3);
    ctx.font = font(54, 600);
    for (const [k, line] of wrap(ctx, label, colW).entries()) {
      text(ctx, line, x + card / 2, y + card + 110 + k * 68, { px: 54, weight: 600 });
    }
  }
  return canvas;
}

// The final StoneLayout of a listing design: its PN-04a run's stones.json, found by the design's
// tinted.png (the run archived the same file).
function stonesOf(d) {
  const want = createHash("sha256").update(readFileSync(d.tinted)).digest("hex");
  for (const run of readdirSync(RUNS).sort()) {
    const archive = path.join(RUNS, run, "archive");
    if (!existsSync(archive)) continue;
    for (const code of readdirSync(archive)) {
      for (const attempt of readdirSync(path.join(archive, code)).filter((a) => a.startsWith("attempt-"))) {
        const dir = path.join(archive, code, attempt);
        if (!existsSync(path.join(dir, "tinted.png")) || !existsSync(path.join(dir, "stones.json"))) continue;
        if (createHash("sha256").update(readFileSync(path.join(dir, "tinted.png"))).digest("hex") === want) {
          return StoneLayout.fromJSON(JSON.parse(readFileSync(path.join(dir, "stones.json"), "utf8")));
        }
      }
    }
  }
  throw new Error(`no stones.json for ${d.id} in ${RUNS}`);
}

// Page 1 of the A4 production sheet, made by the delivery ZIP's own exporter, rendered heightPx high.
async function sheetPage(d, heightPx) {
  const layout = stonesOf(d);
  const files = await designFiles(layout, { code: EXAMPLE_CODE, tintedPng: readFileSync(d.tinted) });
  const pdf = files.find((f) => f.name === "production-sheet-A4.pdf").data;
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: heightPx / base.height });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function whatsIncluded() {
  const d = design("mastiff-bw-stencil");
  const { canvas, ctx } = frame({ title: "Ready for cutting machines and hand setting" });
  const items = [
    ["SVG", "Vector file, true size", ".svg"],
    ["PDF", "Production sheet, A4 and Letter", "production-sheet-A4.pdf"],
    ["AI", "Vector file, true size", ".ai"],
    ["EPS", "Vector file, true size", ".eps"],
    ["DXF", "Cutting template, a layer per colour", ".dxf"],
    ["PNG", "300 dpi, transparent background", `${EXAMPLE_CODE}.png`],
    ["Preview", "How the finished design looks", "-preview.png"]
  ];
  const names = zipEntryNames(EXAMPLE_CODE);
  for (const [, , end] of items) if (!names.some((n) => n.endsWith(end))) throw new Error(`no ZIP file ends with ${end}`);

  const sheetH = BOTTOM - TOP - 20;
  const sheet = await sheetPage(d, sheetH);
  const sx = SAFE.x0 + 20, sy = TOP + 10;
  for (const [k, a] of [[18, 0.03], [10, 0.05], [4, 0.07]]) {
    ctx.fillStyle = `rgba(14, 23, 48, ${a})`;
    roundRect(ctx, sx - k + 6, sy - k + 10, sheet.width + 2 * k, sheet.height + 2 * k, 10 + k);
    ctx.fill();
  }
  ctx.drawImage(sheet, sx, sy);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, sheet.width, sheet.height);

  const lx = sx + sheet.width + 90, lw = SAFE.x1 - lx;
  text(ctx, "In your download", lx, TOP + 120, { px: 60, weight: 700, color: C.blue, align: "left", maxW: lw });
  ctx.font = font(36, 700);
  const badgeW = Math.max(...items.map(([b]) => ctx.measureText(b).width)) + 44;
  const rowH = (BOTTOM - TOP - 240) / items.length;
  for (const [i, [badge, label]] of items.entries()) {
    const y = TOP + 220 + i * rowH;
    ctx.fillStyle = C.blue;
    roundRect(ctx, lx, y, badgeW, 70, 14);
    ctx.fill();
    text(ctx, badge, lx + badgeW / 2, y + 48, { px: 36, weight: 700, color: "#ffffff" });
    ctx.font = font(42, 400);
    const lines = wrap(ctx, label, lw - badgeW - 30);
    for (const [k, line] of lines.entries()) {
      text(ctx, line, lx + badgeW + 30, y + 50 + (k - (lines.length - 1) / 2) * 50, { px: 42, align: "left" });
    }
  }
  return canvas;
}

function dimension(ctx, x0, y0, x1, y1, tick = 26) {
  ctx.strokeStyle = C.blue;
  ctx.lineWidth = 5;
  ctx.lineCap = "butt";
  const horizontal = y0 === y1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  for (const [x, y] of [[x0, y0], [x1, y1]]) {
    if (horizontal) {
      ctx.moveTo(x, y - tick);
      ctx.lineTo(x, y + tick);
    } else {
      ctx.moveTo(x - tick, y);
      ctx.lineTo(x + tick, y);
    }
  }
  ctx.stroke();
  const head = 24, w = 13;
  ctx.fillStyle = C.blue;
  const heads = horizontal ? [[x0, y0, 1, 0], [x1, y1, -1, 0]] : [[x0, y0, 0, 1], [x1, y1, 0, -1]];
  for (const [x, y, dx, dy] of heads) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * head - dy * w, y + dy * head + dx * w);
    ctx.lineTo(x + dx * head + dy * w, y + dy * head - dx * w);
    ctx.closePath();
    ctx.fill();
  }
}

async function size() {
  const d = design("mastiff-colour");
  const { stats } = d;
  const [main, mainCount] = Object.entries(stats.bySize).sort((a, b) => b[1] - a[1])[0];
  if (mainCount * 2 <= stats.stones) throw new Error(`${d.id}: no size is used by most stones`);
  const { canvas, ctx } = frame({ title: `${stats.stones} stones · mostly ${main.toUpperCase()}` });
  const g = await tintedGeometry(d);
  const cm = (mm) => `${(mm / 10).toFixed(1)} cm`;
  // The stones' box at pxPerMm, with room for the width line below and the height line and its
  // label on the right.
  const DIM = 200, LABEL_W = 280;
  const availW = SAFE_W - DIM - LABEL_W, availH = BOTTOM - TOP - 90 - DIM;
  const pxPerMm = Math.min(availW / stats.widthMm, availH / stats.heightMm);
  const k = pxPerMm / g.scale;
  const boxW = stats.widthMm * pxPerMm, boxH = stats.heightMm * pxPerMm;
  const bx = SAFE.x0 + (availW - boxW) / 2 + 40, by = TOP + 10 + (availH - boxH) / 2;
  const p = { img: await picture(d.tinted, { left: 0, top: 0, width: g.width, height: g.height }, g.width * k, g.height * k), w: Math.round(g.width * k), h: Math.round(g.height * k) };
  draw(ctx, p, bx - g.box.x * k, by - g.box.y * k);

  const wy = by + boxH + 80;
  dimension(ctx, bx, wy, bx + boxW, wy);
  text(ctx, `${cm(stats.widthMm)}  ·  ${stats.widthIn} in`, bx + boxW / 2, wy + 95, { px: 56, weight: 600, color: C.blue });
  const hx = bx + boxW + 80;
  dimension(ctx, hx, by, hx, by + boxH);
  text(ctx, cm(stats.heightMm), hx + 50, by + boxH / 2 - 10, { px: 56, weight: 600, color: C.blue, align: "left" });
  text(ctx, `${stats.heightIn} in`, hx + 50, by + boxH / 2 + 62, { px: 56, weight: 600, color: C.blue, align: "left" });
  text(ctx, "Each design has its own natural size, usually 13–30 cm", CX, BOTTOM + 10, { px: 46, color: C.ink, maxW: SAFE_W });
  return canvas;
}

// The mastiff's eyes and nose at CLOSE_SCALE times the full-size render (fractions of tinted.png).
const CLOSE = { cx: 0.55, cy: 0.45, scale: 2 };
async function closeUp() {
  const d = design("mastiff-colour");
  const { canvas, ctx } = frame({ title: "Every stone placed for you", footer: false });
  const g = await tintedGeometry(d);
  const top = TOP - 30, h = PHOTO_H - top;
  const sw = Math.round(PHOTO_W / CLOSE.scale), sh = Math.round(h / CLOSE.scale);
  const left = Math.round(CLOSE.cx * g.width - sw / 2), stop = Math.round(CLOSE.cy * g.height - sh / 2);
  if (left < 0 || stop < 0 || left + sw > g.width || stop + sh > g.height) throw new Error("close-up outside the render");
  const p = { img: await picture(d.tinted, { left, top: stop, width: sw, height: sh }, PHOTO_W, h), w: PHOTO_W, h };
  draw(ctx, p, 0, top);
  return canvas;
}

// ---- output ----

const rgba = (canvas) => Buffer.from(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.buffer);

// canvas -> sRGB JPG under MAX_BYTES, the quality lowered step by step down to QUALITY.min.
async function jpg(canvas, file) {
  const raw = sharp(rgba(canvas), { raw: { width: canvas.width, height: canvas.height, channels: 4 } }).removeAlpha();
  for (let q = QUALITY.start; q >= QUALITY.min; q -= QUALITY.step) {
    const buf = await raw.clone().withIccProfile("srgb").jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length < MAX_BYTES || q - QUALITY.step < QUALITY.min) {
      writeFileSync(file, buf);
      const over = buf.length >= MAX_BYTES ? " OVER 1 MB" : "";
      console.log(`${path.relative(ROOT, file)} ${canvas.width} x ${canvas.height} q${q} ${(buf.length / 1024).toFixed(0)} KB${over}`);
      return { file, quality: q, bytes: buf.length };
    }
  }
}

async function overview(files) {
  const COLS = 3, GAP = 20, LABEL = 36;
  const cellW = Math.floor((OVERVIEW_W - (COLS + 1) * GAP) / COLS), cellH = Math.round(cellW * PHOTO_H / PHOTO_W);
  const rows = Math.ceil(files.length / COLS);
  const W = COLS * cellW + (COLS + 1) * GAP, H = rows * (cellH + LABEL + GAP) + GAP;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.surface;
  ctx.fillRect(0, 0, W, H);
  for (const [i, file] of files.entries()) {
    const x = GAP + (i % COLS) * (cellW + GAP), y = GAP + Math.floor(i / COLS) * (cellH + LABEL + GAP);
    text(ctx, path.basename(file), x, y + 26, { px: 24, weight: 600, color: C.ink, align: "left" });
    const img = await loadImage(await sharp(file).resize(cellW, cellH, { kernel: "lanczos3" }).png().toBuffer());
    ctx.drawImage(img, x, y + LABEL);
    ctx.strokeStyle = C.lineStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + LABEL + 0.5, cellW - 1, cellH - 1);
  }
  const file = path.join(OUT, "overview.png");
  writeFileSync(file, await sharp(rgba(canvas), { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 }).toBuffer());
  console.log(`${path.relative(ROOT, file)} ${W} x ${H}`);
}

const PHOTOS = [
  ["01-main-butterfly.jpg", () => mainPhoto("butterfly-colour")],
  ["01-main-dahlia.jpg", () => mainPhoto("dahlia-colour")],
  ["02-bold-vs-shaded.jpg", () => twoStyles("mastiff", "Black & white in two styles")],
  ["03-range.jpg", range],
  ["04-how-it-works.jpg", howItWorks],
  ["05-whats-included.jpg", whatsIncluded],
  ["06-size.jpg", size],
  ["07-close-up.jpg", closeUp],
  ["08-person.jpg", () => twoStyles("person", "Portraits too")]
];

mkdirSync(OUT, { recursive: true });
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1].split(",");
const written = [];
for (const [name, make] of PHOTOS) {
  const file = path.join(OUT, name);
  if (!only || only.some((o) => name.startsWith(o))) written.push(await jpg(await make(), file));
}
if (!only) await overview(PHOTOS.map(([name]) => path.join(OUT, name)));
const over = written.filter((w) => w.bytes >= MAX_BYTES);
if (over.length) console.log(`over 1 MB at quality ${QUALITY.min}: ${over.map((w) => path.basename(w.file)).join(", ")}`);
