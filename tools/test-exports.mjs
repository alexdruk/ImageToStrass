import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { AI_MARGIN_MM } from "../src/export/aiExport.js";
import { dxfLayerNameForColor } from "../src/export/DxfExporter.js";
import { ghostscriptPath } from "../src/export/epsExport.js";
import { PNG_DPI } from "../src/export/pngExport.js";
import { buildDeliveryZip, deliveryZipPath, designFiles, writeZip, zipEntryNames } from "../src/export/zip.js";
import { naturalLayout } from "../src/pipeline/tiers.js";
import { FILL_REACH, TINT_BRIGHTNESS, renderFull, renderPreview, renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";

// IS-04 (spec sections 8 and 9): the tinted render on a unit fixture, then every export of the 8
// accepted IS-03b designs (tools/fixtures/is03b, strass /layout answers) opened by an outside
// reader: SVG in a browser, PDF and AI by pdfinfo, EPS by Ghostscript, DXF by the RS DXF test's
// group-code reader, PNG by sharp; and the ZIP's entries against the spec's table.

const run = promisify(execFile);
const CODE = "IS-7K3Q-9XPA";
const PT_PER_MM = 72 / 25.4;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PDFINFO = ["/usr/local/bin/pdfinfo", "/opt/homebrew/bin/pdfinfo"].find((f) => existsSync(f)) || "pdfinfo";
const GS = ghostscriptPath();
const exists = (cmd) => cmd.startsWith("/") ? existsSync(cmd) : false;
const NO_GS = !exists(GS) && "Ghostscript (gs) is not installed";
const NO_PDFINFO = !exists(PDFINFO) && "pdfinfo (poppler) is not installed";
// Words no delivered file may contain (spec section 12, and section 9: no metadata naming anything
// but IS).
const FOREIGN = /openai|gpt|dall|prompt|ghostscript|artifex|resvg|tarikjabiri|napi|skia|cairo|rsvg|rhinestone.studio/i;

const FIXTURES = new URL("./fixtures/is03b/", import.meta.url);
const DESIGNS = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const { stoneLayout, gaps } = naturalLayout(JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")));
  return { id: f.replace(/\.json$/, ""), stoneLayout, gaps };
});

// --- Tinted render (section 8) ------------------------------------------------------------------

const stone = (xMm, yMm, size, color, index) => new Stone({ xMm, yMm, sizeMm: size, color, layerId: "design", index });
const rgbOf = (color) => {
  const hex = STONE_COLORS[color].fill.replace("#", "");
  return [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * TINT_BRIGHTNESS));
};

// A: SS16 (r 2 mm) at x 10; B: SS6 (r 1 mm) at x 14.6 (gap 1.6 mm); C: SS6 alone at x 30.
const UNIT = new StoneLayout({
  layerId: "design", sourceMode: "is",
  stones: [stone(10, 10, 4, "siam", 0), stone(14.6, 10, 2, "sapphire", 1), stone(30, 10, 2, "emerald", 2)]
});

async function pixelsOf(render) {
  const { data, info } = await sharp(render.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = tintCanvasMm(UNIT);
  // The RGBA of the pixel whose centre is nearest to (xMm, yMm), and that centre's true position.
  return (xMm, yMm) => {
    const x = Math.floor((xMm - box.minXmm) * render.scale);
    const y = Math.floor((yMm - box.minYmm) * render.scale);
    const i = (y * info.width + x) * 4;
    return { rgba: [...data.subarray(i, i + 4)], at: [(x + 0.5) / render.scale + box.minXmm, (y + 0.5) / render.scale + box.minYmm] };
  };
}

test("tinted render: 1.5 r gets 85 % of the nearest stone's fill, 1.7 r is background", async () => {
  const full = renderTinted(UNIT, { longSidePx: 2400, background: "transparent" });
  const white = renderTinted(UNIT, { longSidePx: 2400, background: "white" });
  assert.ok(full.scale > 50, "pixels well below 0.05 r");
  const px = await pixelsOf(full);
  const pw = await pixelsOf(white);
  const dist = (p, s) => Math.hypot(p.at[0] - s.xMm, p.at[1] - s.yMm) / (s.sizeMm / 2);

  for (const s of UNIT.stones) {
    // Straight up from each stone, away from the others.
    const at15 = px(s.xMm, s.yMm - 1.5 * s.sizeMm / 2);
    assert.ok(Math.abs(dist(at15, s) - 1.5) < 0.05, `${s.color} sample at ${dist(at15, s)} r`);
    assert.deepEqual(at15.rgba, [...rgbOf(s.color), 255], `${s.color} at 1.5 r`);
    const at17 = px(s.xMm, s.yMm - 1.7 * s.sizeMm / 2);
    assert.ok(Math.abs(dist(at17, s) - 1.7) < 0.05);
    assert.equal(at17.rgba[3], 0, `${s.color} at 1.7 r: transparent in the PNG file`);
    assert.deepEqual(pw(s.xMm, s.yMm - 1.7 * s.sizeMm / 2).rgba, [255, 255, 255, 255], `${s.color} at 1.7 r: white in the app`);
  }
  assert.equal(FILL_REACH, 1.6);

  // Nearest by edge, not by centre: 2.9 mm right of A is 0.9 mm from A's edge and 0.7 mm from B's,
  // so it belongs to B, and at 1.7 r_B from B's centre it is background although it is only
  // 1.45 r_A from A's centre.
  assert.equal(px(12.9, 10).rgba[3], 0);
});

test("tinted render: full 2400 px transparent, preview 900 px white with the watermark", async () => {
  const { stoneLayout } = DESIGNS.find((d) => d.id === "mug-rule");
  const full = renderFull(stoneLayout);
  const preview = renderPreview(stoneLayout, CODE);
  const fullMeta = await sharp(full.png).metadata();
  const previewMeta = await sharp(preview.png).metadata();
  assert.equal(Math.max(fullMeta.width, fullMeta.height), 2400);
  assert.equal(Math.max(previewMeta.width, previewMeta.height), 900);
  const corner = async (png) => [...(await sharp(png).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer())];
  assert.deepEqual(await corner(full.png), [0, 0, 0, 0]);
  // The canvas margin is 2 main-stone diameters: 4 mm of the 138 mm wide canvas.
  const box = tintCanvasMm(stoneLayout);
  assert.ok(Math.abs(box.widthMm - (stoneLayout.widthMm + 8)) < 1e-9);
  // The watermark changes the preview: the same render without it differs.
  const plain = renderTinted(stoneLayout, { longSidePx: 900, background: "white" });
  assert.ok(!plain.png.equals(preview.png));
  // Deterministic.
  assert.ok(renderPreview(stoneLayout, CODE).png.equals(preview.png));
});

// --- Exports (section 9) ------------------------------------------------------------------------

const WORK = mkdtempSync(path.join(tmpdir(), "is-exports-"));
const FILES = new Map();
for (const d of DESIGNS) {
  const tintedPng = renderTinted(d.stoneLayout, { longSidePx: 600 }).png; // small: only its presence matters here
  // Without Ghostscript the EPS entry is a placeholder and the EPS and ZIP-build tests are skipped.
  const files = await designFiles(d.stoneLayout, { code: CODE, tintedPng, ...(NO_GS ? { epsOf: async () => Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n") } : {}) });
  const dir = path.join(WORK, d.id);
  mkdirSync(dir);
  for (const f of files) writeFileSync(path.join(dir, f.name), f.data);
  FILES.set(d.id, { dir, files });
}
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

const fileOf = (id, name) => path.join(FILES.get(id).dir, name);

test("the 8 IS-03b designs: natural size, gap check passed after the SS16 cap", () => {
  assert.equal(DESIGNS.length, 8);
  for (const d of DESIGNS) {
    assert.ok(d.gaps.ok, d.id);
    assert.ok(d.stoneLayout.stones.every((s) => s.sizeMm <= 4), `${d.id}: nothing above SS16`);
  }
});

test("ZIP contents match the table (spec section 9)", () => {
  const expected = [
    `${CODE}.svg`, "production-sheet-A4.pdf", "production-sheet-Letter.pdf", `${CODE}.ai`, `${CODE}.eps`,
    `${CODE}.dxf`, `${CODE}.png`, `${CODE}-preview.png`, "README.txt"
  ];
  assert.deepEqual(zipEntryNames(CODE), expected);
  for (const d of DESIGNS) assert.deepEqual(FILES.get(d.id).files.map((f) => f.name), expected, d.id);
});

test("no delivered file names anything but IS", () => {
  for (const d of DESIGNS) {
    for (const f of FILES.get(d.id).files) {
      if (f.name.endsWith(".png")) {
        // PNG: no text, EXIF or other metadata chunk that could name anything.
        const chunks = new Set();
        for (let i = 8; i < f.data.length; i += 12 + f.data.readUInt32BE(i)) chunks.add(f.data.toString("latin1", i + 4, i + 8));
        assert.ok([...chunks].every((c) => ["IHDR", "PLTE", "tRNS", "pHYs", "sBIT", "sRGB", "gAMA", "IDAT", "IEND"].includes(c)), `${d.id} ${f.name}: ${[...chunks]}`);
        continue;
      }
      const text = f.data.toString("latin1");
      assert.doesNotMatch(text, FOREIGN, `${d.id} ${f.name}`);
    }
  }
});

test("README: code, natural size, counts per size and colour, file list", () => {
  for (const d of DESIGNS) {
    const text = FILES.get(d.id).files.find((f) => f.name === "README.txt").data.toString("utf8");
    const L = d.stoneLayout;
    assert.ok(text.startsWith(`IS design ${CODE}\r\n`));
    assert.ok(text.includes(`Size: ${L.widthMm.toFixed(1)} × ${L.heightMm.toFixed(1)} mm (${(L.widthMm / 25.4).toFixed(2)} × ${(L.heightMm / 25.4).toFixed(2)} in)`), d.id);
    assert.ok(text.includes(`Stones: ${L.count}\r\n`));
    const sizes = [...text.matchAll(/^ {2}(SS\d+): (\d+)\r$/gm)].reduce((n, m) => n + Number(m[2]), 0);
    assert.equal(sizes, L.count, `${d.id}: per-size counts add up`);
    for (const name of zipEntryNames(CODE)) assert.ok(text.includes(name), `${d.id}: lists ${name}`);
  }
});

test("SVG: true size in mm, one circle per stone, colour groups with ids", () => {
  for (const d of DESIGNS) {
    const svg = readFileSync(fileOf(d.id, `${CODE}.svg`), "utf8");
    const L = d.stoneLayout;
    const [, w, h] = /<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
    assert.ok(Math.abs(w - L.widthMm) < 1e-6 && Math.abs(h - L.heightMm) < 1e-6, d.id);
    assert.equal((svg.match(/<circle /g) || []).length, L.count);
    const ids = [...svg.matchAll(/<g id="([^"]+)" data-layer/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "ids unique");
    const colours = new Set(L.stones.map((s) => s.color));
    assert.deepEqual(new Set(ids.map((id) => id.replace(/-ss\d+$/, ""))), colours, d.id);
    assert.ok(!svg.includes('id="regions"'));
  }
});

test("SVG opens in a browser", { skip: !existsSync(CHROME) && "Chrome not found" }, async () => {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const page = `<!doctype html><meta charset="utf-8"><script type="module">
const ids = ${JSON.stringify(DESIGNS.map((d) => d.id))};
const out = {};
for (const id of ids) {
  const img = new Image();
  img.src = "/" + id + ".svg";
  try { await img.decode(); out[id] = [img.naturalWidth, img.naturalHeight]; } catch (e) { out[id] = String(e); }
}
await fetch("/result", { method: "POST", body: JSON.stringify(out) });
</script>`;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { res.end("ok"); resolveResult(JSON.parse(body)); });
      return;
    }
    if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(page);
    const id = req.url.slice(1).replace(/\.svg$/, "");
    if (!FILES.has(id)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "image/svg+xml" }).end(readFileSync(fileOf(id, `${CODE}.svg`)));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const profile = mkdtempSync(path.join(tmpdir(), "is-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-gpu", "--disable-background-networking",
    `http://127.0.0.1:${server.address().port}/`
  ], { stdio: "ignore" });
  try {
    const got = await Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error("browser did not answer in 60 s")), 60_000))]);
    for (const d of DESIGNS) {
      // An SVG with a mm size decodes at 96 px per inch.
      const [w, h] = got[d.id];
      assert.ok(Math.abs(w - d.stoneLayout.widthMm / 25.4 * 96) <= 1 && Math.abs(h - d.stoneLayout.heightMm / 25.4 * 96) <= 1, `${d.id}: ${got[d.id]}`);
    }
  } finally {
    // Only the headless instance started above.
    const exited = chrome.exitCode !== null ? null : new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    server.close();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS */ }
  }
});

async function pdfinfo(file) {
  const { stdout } = await run(PDFINFO, ["-l", "999", file]);
  const info = Object.fromEntries(stdout.split("\n").filter((l) => /^[\w ]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  const pages = [...stdout.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  return { info, pages };
}

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const samePage = ([w, h], [a, b]) => (near(w, a) && near(h, b)) || (near(w, b) && near(h, a));

test("production sheets (A4 and Letter) open in pdfinfo: page size, Producer and Creator IS", { skip: NO_PDFINFO }, async () => {
  for (const d of DESIGNS) {
    for (const [name, size] of [["production-sheet-A4.pdf", [595.28, 841.89]], ["production-sheet-Letter.pdf", [612, 792]]]) {
      const { info, pages } = await pdfinfo(fileOf(d.id, name));
      assert.equal(info.Producer, "IS", `${d.id} ${name}`);
      assert.equal(info.Creator, "IS");
      assert.equal(info.Title, `IS design ${CODE}`);
      assert.equal(Number(info.Pages), pages.length);
      assert.ok(pages.length >= 1);
      for (const p of pages) assert.ok(samePage(p, size), `${d.id} ${name}: ${p}`);
    }
  }
});

test("production sheet text: title, no Object line, footer on every page, units", async () => {
  for (const d of DESIGNS) {
    for (const [name, unit] of [["production-sheet-A4.pdf", "mm"], ["production-sheet-Letter.pdf", "in"]]) {
      const pdf = readFileSync(fileOf(d.id, name), "latin1");
      const pages = Number(/\/Count (\d+)/.exec(pdf)[1]);
      assert.ok(pdf.includes(`(IS design ${CODE}) Tj`), `${d.id} ${name}: title`);
      assert.ok(!pdf.includes("(Object:"), "no Object line");
      assert.ok(!/Plate|Design target/.test(pdf), "no plate lines");
      assert.match(pdf, new RegExp(`\\(Production size: [\\d.]+ \\xd7 [\\d.]+ ${unit}\\) Tj`));
      assert.ok(pdf.includes("(Gap: 0.1 mm) Tj"));
      for (let i = 1; i <= pages; i++) assert.ok(pdf.includes(`(Made with IS \xb7 Page ${i} of ${pages}) Tj`), `${d.id} ${name}: footer ${i}`);
    }
  }
});

test("AI opens in pdfinfo: one page, the design plus 10 mm, Producer IS", { skip: NO_PDFINFO }, async () => {
  for (const d of DESIGNS) {
    const { info, pages } = await pdfinfo(fileOf(d.id, `${CODE}.ai`));
    assert.equal(info.Producer, "IS");
    assert.equal(info.Creator, "IS");
    assert.equal(pages.length, 1);
    const L = d.stoneLayout;
    assert.ok(near(pages[0][0], (L.widthMm + 2 * AI_MARGIN_MM) * PT_PER_MM, 0.01) && near(pages[0][1], (L.heightMm + 2 * AI_MARGIN_MM) * PT_PER_MM, 0.01), `${d.id}: ${pages[0]}`);
    const pdf = readFileSync(fileOf(d.id, `${CODE}.ai`), "latin1");
    assert.equal((pdf.match(/\nh\nB/g) || []).length, L.count, "one filled circle per stone");
  }
});

test("EPS opens in Ghostscript: bounding box of the stones, header names IS", { skip: NO_GS }, async () => {
  for (const d of DESIGNS) {
    const file = fileOf(d.id, `${CODE}.eps`);
    const eps = readFileSync(file, "latin1");
    assert.ok(eps.startsWith("%!PS-Adobe-3.0 EPSF-3.0"), d.id);
    assert.match(eps, /\n%%Creator: IS\n/);
    assert.match(eps, new RegExp(`\\n%%Title: IS design ${CODE}\\n`));
    const { stderr } = await run(GS, ["-q", "-dSAFER", "-dNOPAUSE", "-dBATCH", "-sDEVICE=bbox", file]);
    const [, x0, y0, x1, y1] = /%%HiResBoundingBox: ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/.exec(stderr).map(Number);
    const L = d.stoneLayout;
    // The drawn stones (with their 0.12 mm stroke) span the design's natural size.
    assert.ok(near((x1 - x0) / PT_PER_MM, L.widthMm, 0.3) && near((y1 - y0) / PT_PER_MM, L.heightMm, 0.3), `${d.id}: ${stderr}`);
  }
});

// The RS DXF test's reader (tools/test-rs3036-dxf-exporter.mjs @38cd831): (code, value) line pairs,
// collecting CIRCLE {layer, x, y, r}, LAYER names and $INSUNITS.
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push({ code: parseInt(lines[i].trim(), 10), value: lines[i + 1].trim() });
  const layerNames = [];
  const circles = [];
  let insunits = null;
  let lastSavedBy = null;
  let entity = null;
  const flush = () => {
    if (entity?.type === "CIRCLE") circles.push({ layer: entity.layer, x: entity.x, y: entity.y, r: entity.r });
    else if (entity?.type === "LAYER" && entity.name) layerNames.push(entity.name);
    entity = null;
  };
  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 9 && value === "$INSUNITS") insunits = Number(pairs[i + 1].value);
    if (code === 9 && value === "$LASTSAVEDBY") lastSavedBy = pairs[i + 1].value;
    if (code === 0) { flush(); entity = { type: value }; continue; }
    if (!entity) continue;
    if (code === 8) entity.layer = value;
    if (code === 2 && entity.type === "LAYER") entity.name = value;
    if (code === 10) entity.x = Number(value);
    if (code === 20) entity.y = Number(value);
    if (code === 40) entity.r = Number(value);
  }
  flush();
  return { layerNames, circles, insunits, lastSavedBy };
}

test("DXF: millimetres, one circle per stone at the Y-flipped position, one layer per colour", () => {
  for (const d of DESIGNS) {
    const L = d.stoneLayout;
    const dxf = parseDxf(readFileSync(fileOf(d.id, `${CODE}.dxf`), "utf8"));
    assert.equal(dxf.insunits, 4, "millimetres");
    assert.equal(dxf.lastSavedBy, "IS");
    const colours = [...new Set(L.stones.map((s) => s.color))].sort();
    for (const c of colours) assert.ok(dxf.layerNames.includes(dxfLayerNameForColor(c)), `${d.id}: layer ${c}`);
    assert.ok(dxf.layerNames.includes("CANVAS"));
    assert.equal(dxf.circles.length, L.count);
    L.stones.forEach((s, i) => {
      const c = dxf.circles[i];
      assert.equal(c.layer, dxfLayerNameForColor(s.color));
      assert.ok(near(c.x, s.xMm, 1e-6) && near(c.y, L.heightMm - s.yMm, 1e-6) && near(c.r, s.sizeMm / 2, 1e-9), `${d.id} stone ${i}`);
    });
  }
});

test("PNG: 300 dpi true size, transparent background", async () => {
  for (const d of DESIGNS) {
    const file = fileOf(d.id, `${CODE}.png`);
    const meta = await sharp(file).metadata();
    const L = d.stoneLayout;
    assert.equal(meta.width, Math.round(L.widthMm / 25.4 * PNG_DPI), d.id);
    assert.equal(meta.height, Math.round(L.heightMm / 25.4 * PNG_DPI), d.id);
    assert.equal(meta.density, PNG_DPI);
    assert.equal(meta.hasAlpha, true);
    // A pixel between stones (the box's corner lies outside every circle) is transparent.
    const corner = await sharp(file).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 0, d.id);
  }
});

test("writeZip: a deflate ZIP with the entries in table order, contents unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "is-zip-"));
  try {
    const { files } = FILES.get("mug-rule");
    const file = await writeZip(files, path.join(root, CODE, `${CODE}.zip`));
    const { stdout } = await run("unzip", ["-Z1", file]);
    assert.deepEqual(stdout.trim().split("\n"), zipEntryNames(CODE));
    await run("unzip", ["-tq", file]);
    const { stdout: verbose } = await run("unzip", ["-v", file]);
    assert.match(verbose, /Defl:/);
    for (const f of files) {
      const { stdout: data } = await run("unzip", ["-p", file, f.name], { encoding: "buffer", maxBuffer: 1 << 26 });
      assert.ok(data.equals(f.data), f.name);
    }
    assert.deepEqual(readdirSync(path.join(root, CODE)), [`${CODE}.zip`], "no temporary file left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildDeliveryZip: from the archive to data/delivery/<code>/<code>.zip", { skip: NO_GS }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "is-delivery-"));
  try {
    const archiveDir = path.join(root, "archive");
    const deliveryDir = path.join(root, "delivery");
    const { stoneLayout } = DESIGNS.find((d) => d.id === "dachshund-rule");
    const dir = path.join(archiveDir, CODE, "attempt-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "stones.json"), JSON.stringify(stoneLayout.toJSON()));
    const tinted = renderTinted(stoneLayout, { longSidePx: 300 }).png;
    writeFileSync(path.join(dir, "tinted.png"), tinted);
    const before = readdirSync(dir).sort();

    const file = await buildDeliveryZip({ archiveDir, deliveryDir, code: CODE, n: 2 });
    assert.equal(file, deliveryZipPath(deliveryDir, CODE));
    assert.equal(file, path.join(deliveryDir, CODE, `${CODE}.zip`));
    const { stdout } = await run("unzip", ["-Z1", file]);
    assert.deepEqual(stdout.trim().split("\n"), zipEntryNames(CODE));
    await run("unzip", ["-tq", file]);
    const { stdout: preview } = await run("unzip", ["-p", file, `${CODE}-preview.png`], { encoding: "buffer", maxBuffer: 1 << 26 });
    assert.ok(preview.equals(tinted), "the archived full tinted render is the preview");
    assert.deepEqual(readdirSync(dir).sort(), before, "the archive is not touched");
    assert.deepEqual(readdirSync(path.join(deliveryDir, CODE)), [`${CODE}.zip`], "no temporary file left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
