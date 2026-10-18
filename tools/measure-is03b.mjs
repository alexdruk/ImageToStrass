// IS-03b measurements for docs/IS-03b-results.md, run by hand (real provider and strass calls, paid):
//   node tools/measure-is03b.mjs <work dir>            make the designs not yet in <work dir>
//   node tools/measure-is03b.mjs <work dir> --report   tables + images to docs/IS-03b-results
// Nine designs: dog, cat and mug with and without the "about 60 stones across" sentence, and the
// giraffe, dachshund and car with it. Each runs the production steps once (decode, background
// removal, adjustments, model input crop, provider with size auto, layout, natural size), with no
// automatic re-run. Provider outputs and layouts stay in <work dir> (never in the repository); a
// design already there is not made again. The prompt text is never printed.
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { acceptLayout, modelInput } from "../src/pipeline/design.js";
import { callLayoutService } from "../src/pipeline/layout.js";
import { DEFAULT_TIMERS, createProvider } from "../src/pipeline/provider.js";
import { minRimGap, naturalLayout } from "../src/pipeline/tiers.js";
import { callRemoveBackground } from "../src/prep/background.js";
import { decodeToWork } from "../src/prep/decode.js";
import { preparePng } from "../src/prep/prepare.js";
import { loadConfig } from "../src/server/config.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { findStoneSizeByDiameterMm } from "../src/stones/StoneSizes.js";

const PHOTOS = new URL("../services/strass/tests/fixtures/photos/", import.meta.url).pathname;
const RULE = " Make the stones large: about 60 stones across the full width of the image.";
const DESIGNS = [
  ["dog", true], ["dog", false], ["cat", true], ["cat", false], ["mug", true], ["mug", false],
  ["giraffe", true], ["dachshund", true], ["car", true]
].map(([photo, rule]) => ({ photo, rule, id: `${photo}-${rule ? "rule" : "norule"}` }));
const MM_PER_INCH = 25.4;

const [work, flag] = process.argv.slice(2);
if (!work) throw new Error("usage: node tools/measure-is03b.mjs <work dir> [--report]");
mkdirSync(work, { recursive: true });
const config = loadConfig();
const fileOf = (...parts) => path.join(work, ...parts);

// The cut-out of a photo, made once and shared by its designs.
async function cutoutOf(photo) {
  const file = fileOf(`${photo}-cutout.png`);
  if (!existsSync(file)) {
    const { png } = await decodeToWork(readFileSync(path.join(PHOTOS, `${photo}.jpg`)), "jpeg");
    writeFileSync(file, await callRemoveBackground(png, { serviceUrl: config.strassServiceUrl, fetch }));
  }
  return readFileSync(file);
}

// The provider, with the rule sentence taken out of the request when rule is false.
function providerFor(rule) {
  const edit = async (url, init) => {
    if (!rule) {
      const prompt = init.body.get("prompt");
      if (!prompt.includes(RULE)) throw new Error("rule sentence not found");
      init.body.set("prompt", prompt.replace(RULE, ""));
    }
    return fetch(url, init);
  };
  return createProvider({ settings: config.provider, fetch: edit, timers: DEFAULT_TIMERS });
}

async function make({ photo, rule, id }) {
  const t0 = Date.now();
  const prepared = await preparePng(await cutoutOf(photo), {});
  const input = await modelInput(prepared, { cropToSubject: true });
  writeFileSync(fileOf(`${id}-input.png`), input);
  const drawn = await providerFor(rule).redraw(input, { mode: "colour" });
  if (!drawn?.png) throw new Error(`${id}: provider ${drawn?.error} ${drawn?.detail}`);
  writeFileSync(fileOf(`${id}-output.png`), drawn.png);
  const t1 = Date.now();
  const placed = await callLayoutService({
    fetch, timers: DEFAULT_TIMERS, url: config.strassServiceUrl, timeoutMs: config.layoutTimeoutMs,
    pngBuffer: drawn.png, colorIds: Object.keys(STONE_COLORS), signal: new AbortController().signal
  });
  if (placed.error) throw new Error(`${id}: layout ${placed.error.code} ${placed.error.message}`);
  writeFileSync(fileOf(`${id}-layout.json`), `${JSON.stringify(placed.layout)}\n`);
  writeFileSync(fileOf(`${id}-meta.json`), `${JSON.stringify({ outputPx: [drawn.width, drawn.height], providerS: (t1 - t0) / 1000, layoutS: (Date.now() - t1) / 1000 })}\n`);
  console.log(`${id}: done`);
}

// Median centre distance from each main-size stone to its nearest main-size neighbour.
function mainPitch(stones, mainD) {
  const main = stones.filter((s) => s.sizeMm === mainD);
  const cell = mainD * 2;
  const grid = new Map();
  for (const s of main) {
    const k = `${Math.floor(s.xMm / cell)},${Math.floor(s.yMm / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const nearest = [];
  for (const s of main) {
    let best = Infinity;
    const gx = Math.floor(s.xMm / cell), gy = Math.floor(s.yMm / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) if (o !== s) best = Math.min(best, Math.hypot(s.xMm - o.xMm, s.yMm - o.yMm));
    }
    if (best < Infinity) nearest.push(best);
  }
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)];
}

function analyse({ id }) {
  const layout = JSON.parse(readFileSync(fileOf(`${id}-layout.json`), "utf8"));
  const meta = JSON.parse(readFileSync(fileOf(`${id}-meta.json`), "utf8"));
  const { stoneLayout, gaps } = naturalLayout(layout);
  const stones = stoneLayout.stones;
  const bySize = {};
  for (const s of stones) {
    const name = findStoneSizeByDiameterMm(s.sizeMm)?.name ?? `${s.sizeMm} mm`;
    bySize[name] = (bySize[name] || 0) + 1;
  }
  const mainName = Object.entries(bySize).sort((a, b) => b[1] - a[1])[0][0];
  const mainD = stones.find((s) => findStoneSizeByDiameterMm(s.sizeMm)?.name === mainName).sizeMm;
  const pitch = mainPitch(stones, mainD);
  const big = stones.filter((s) => s.sizeMm >= 4.7).map((s) => ({
    size: findStoneSizeByDiameterMm(s.sizeMm).name,
    at: [s.xMm / stoneLayout.widthMm, s.yMm / stoneLayout.heightMm].map((v) => Math.round(v * 100))
  }));
  const check = acceptLayout(layout);
  return {
    id,
    outputPx: meta.outputPx,
    imageWidthMm: meta.outputPx[0] * layout.report.mmPerPx,
    pitch,
    acrossImage: (meta.outputPx[0] * layout.report.mmPerPx) / pitch,
    acrossDesign: stoneLayout.widthMm / pitch,
    stones: stones.length,
    bySize,
    widthMm: stoneLayout.widthMm,
    heightMm: stoneLayout.heightMm,
    coverage: layout.report.coverage,
    minGapMm: minRimGap(stones).minGapMm,
    gapsOk: gaps.ok,
    accepted: check.ok,
    violations: check.violations,
    big,
    pupilsMm: layout.report.pupilsMm,
    stoneLayout
  };
}

// Flat circles in catalogue colours, white background, scaled to `height` px.
function stonesPng(stoneLayout, height) {
  const scale = height / stoneLayout.heightMm;
  const width = Math.round(stoneLayout.widthMm * scale);
  const circles = stoneLayout.stones.map((s) => `<circle cx="${(s.xMm * scale).toFixed(2)}" cy="${(s.yMm * scale).toFixed(2)}" r="${(s.sizeMm * scale / 2).toFixed(2)}" fill="${STONE_COLORS[s.color]?.previewColor ?? "#ff00ff"}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${circles.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// The model input on a checkerboard (transparent shown), scaled to `height` px.
async function inputPng(file, height) {
  const img = sharp(readFileSync(file)).resize({ height });
  const { width } = await sharp(await img.clone().png().toBuffer()).metadata();
  const tile = 12;
  const squares = [];
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) {
    if ((x / tile + y / tile) % 2) squares.push(`<rect x="${x}" y="${y}" width="${tile}" height="${tile}" fill="#ddd"/>`);
  }
  const board = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${squares.join("")}</svg>`);
  return sharp(board).composite([{ input: await img.png().toBuffer() }]).png().toBuffer();
}

// Tiles side by side, each under a label of one or two lines ("first\nsecond").
async function row(tiles, labels, file) {
  const H = 420, pad = 16, top = 48, minColumn = 230;
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const columns = metas.map((m) => Math.max(m.width, minColumn));
  const width = columns.reduce((a, w) => a + w + pad, pad);
  let x = pad;
  const layers = [];
  const text = [];
  metas.forEach((m, i) => {
    layers.push({ input: tiles[i], left: x, top });
    labels[i].split("\n").forEach((line, j) => {
      text.push(`<text x="${x}" y="${18 + j * 19}" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#123">${line}</text>`);
    });
    x += columns[i] + pad;
  });
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H + top + pad}"><rect width="100%" height="100%" fill="#fff"/>${text.join("")}</svg>`);
  await sharp(bg).composite(layers).png({ compressionLevel: 9, palette: true }).toFile(file);
}

const fmt = (v, p = 1) => Number(v).toFixed(p);

async function report() {
  const out = new URL("../docs/IS-03b-results/", import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const results = DESIGNS.filter((d) => existsSync(fileOf(`${d.id}-layout.json`))).map(analyse);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const H = 420;
  console.log("| Design | Output px | Stones across image / design | Stones | Natural size | Sizes | Coverage | Min gap mm | Accepted |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const size = `${fmt(r.widthMm)} x ${fmt(r.heightMm)} mm (${fmt(r.widthMm / MM_PER_INCH, 2)} x ${fmt(r.heightMm / MM_PER_INCH, 2)} in)`;
    const sizes = Object.entries(r.bySize).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`| ${r.id} | ${r.outputPx.join(" x ")} | ${fmt(r.acrossImage)} / ${fmt(r.acrossDesign)} | ${r.stones} | ${size} | ${sizes} | ${fmt(r.coverage, 3)} | ${fmt(r.minGapMm, 3)} | ${r.accepted ? "yes" : `no (${r.violations} violations)`} |`);
  }
  console.log("\nSS20 / SS30 stones (position in % of the design's width and height) and the service's pupils:");
  for (const r of results) {
    const big = r.big.filter((b) => b.size === "SS20" || b.size === "SS30");
    if (big.length) console.log(`- ${r.id}: ${big.map((b) => `${b.size} at ${b.at.join("/")} %`).join("; ")}; pupilsMm ${JSON.stringify(r.pupilsMm)}`);
  }
  for (const photo of ["dog", "cat", "mug"]) {
    const a = byId[`${photo}-rule`], b = byId[`${photo}-norule`];
    if (!a || !b) continue;
    await row(
      [await inputPng(fileOf(`${photo}-rule-input.png`), H), await stonesPng(a.stoneLayout, H), await stonesPng(b.stoneLayout, H)],
      ["model input", `with rule\n${a.stones} stones, ${fmt(a.acrossImage, 0)} across`, `without rule\n${b.stones} stones, ${fmt(b.acrossImage, 0)} across`],
      path.join(out, `${photo}.png`)
    );
  }
  for (const photo of ["giraffe", "dachshund", "car"]) {
    const a = byId[`${photo}-rule`];
    if (!a) continue;
    await row(
      [await inputPng(fileOf(`${photo}-rule-input.png`), H), await stonesPng(a.stoneLayout, H)],
      ["model input", `${a.stones} stones, ${fmt(a.acrossImage, 0)} across\n${fmt(a.widthMm, 0)} x ${fmt(a.heightMm, 0)} mm`],
      path.join(out, `${photo}.png`)
    );
  }
}

if (flag === "--report") {
  await report();
} else {
  for (const design of DESIGNS) {
    if (existsSync(fileOf(`${design.id}-layout.json`))) continue;
    try {
      await make(design);
    } catch (error) {
      console.log(`${design.id}: FAILED ${error.message}`);
    }
  }
}
