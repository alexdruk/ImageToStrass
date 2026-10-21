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
import { PNG_DPI } from "../src/export/pngExport.js";
import { buildDeliveryZip, deliveryZipPath, designFiles, writeZip, zipEntryNames } from "../src/export/zip.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import {
  FILL_MARGIN_MM, GAP_RULE, INNER_SHARE, gapRgb, lightnessOfHex, renderFull, renderPreview, renderTinted, tintCanvasMm
} from "../src/render/tinted.js";
import { srgbToLab } from "./colour-diff.mjs";
import { Stone } from "../src/stones/Stone.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";

// IS-04 (spec sections 8 and 9): the tinted render on a unit fixture, then every export of the 8
// accepted IS-03b designs (tools/fixtures/is03b, strass /layout answers) opened by an outside
// reader: SVG in a browser, PDF and AI by pdf.js (pdfjs-dist), EPS by a DSC structure check that
// runs its drawing operators, DXF by the RS DXF test's group-code reader, PNG by sharp; and the
// ZIP's entries against the spec's table.

const run = promisify(execFile);
const CODE = "IS-7K3Q-9XPA";
const PT_PER_MM = 72 / 25.4;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Words no delivered file may contain (spec section 12, and section 9: no metadata naming anything
// but IS).
const FOREIGN = /openai|gpt|dall|prompt|ghostscript|artifex|resvg|tarikjabiri|napi|skia|cairo|rsvg|rhinestone.studio/i;

const FIXTURES = new URL("./fixtures/is03b/", import.meta.url);
const DESIGNS = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const { stoneLayout, gaps } = cleanedLayout(JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")));
  return { id: f.replace(/\.json$/, ""), stoneLayout, gaps };
});

// --- Tinted render (section 8) ------------------------------------------------------------------

const stone = (xMm, yMm, size, color, index) => new Stone({ xMm, yMm, sizeMm: size, color, layerId: "design", index });
const rgbOf = (color) => gapRgb(STONE_COLORS[color].fill);

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

test("tinted render: 0.5 mm beyond a stone's edge gets the gap colour of its fill, 0.7 mm is background", async () => {
  const full = renderTinted(UNIT, { longSidePx: 2400, background: "transparent" });
  const white = renderTinted(UNIT, { longSidePx: 2400, background: "white" });
  assert.ok(full.scale > 50, "pixels well below 0.05 r");
  const px = await pixelsOf(full);
  const pw = await pixelsOf(white);
  const dist = (p, s) => Math.hypot(p.at[0] - s.xMm, p.at[1] - s.yMm) / (s.sizeMm / 2);

  // IS-05c: the same margin beyond the edge for every size, the one an SS6 stone had at 1.6 r
  // (0.6 x 1 mm); the SS16 stone A (r 2 mm) used to be filled up to 1.2 mm beyond its edge.
  assert.equal(FILL_MARGIN_MM, 0.6);
  for (const s of UNIT.stones) {
    // Straight up from each stone, away from the others.
    const edge = (p) => dist(p, s) * s.sizeMm / 2 - s.sizeMm / 2;
    const in05 = px(s.xMm, s.yMm - s.sizeMm / 2 - 0.5);
    assert.ok(Math.abs(edge(in05) - 0.5) < 0.03, `${s.color} sample at ${edge(in05)} mm`);
    assert.deepEqual(in05.rgba, [...rgbOf(s.color), 255], `${s.color} at 0.5 mm`);
    const out07 = px(s.xMm, s.yMm - s.sizeMm / 2 - 0.7);
    assert.ok(Math.abs(edge(out07) - 0.7) < 0.03);
    assert.equal(out07.rgba[3], 0, `${s.color} at 0.7 mm: transparent in the PNG file`);
    assert.deepEqual(pw(s.xMm, s.yMm - s.sizeMm / 2 - 0.7).rgba, [255, 255, 255, 255], `${s.color} at 0.7 mm: white in the app`);
  }
  // A at 1.5 r (1 mm beyond its edge) was filled before IS-05c; now it is background.
  assert.equal(px(10, 10 - 3).rgba[3], 0);

  // Nearest by edge, not by centre: 2.9 mm right of A is 0.9 mm from A's edge and 0.7 mm from B's,
  // so it belongs to B, and 0.7 mm from B's edge it is background.
  assert.equal(px(12.9, 10).rgba[3], 0);
});

test("tinted render: gaps at least 4 L* darker than the fill, 8 above L* 85 (IS-05b gap rule)", () => {
  assert.deepEqual({ ...GAP_RULE }, { minStep: 4, slope: 0.05, fromL: 80, darkBelow: 0, lightAbove: 85, lightMinStep: 8 });
  let nearWhite = 0;
  for (const [id, c] of Object.entries(STONE_COLORS)) {
    const l = lightnessOfHex(c.fill);
    const step = srgbToLab(gapRgb(c.fill))[0] - l;
    const min = l > 85 ? 8 : 4;
    nearWhite += l > 85;
    assert.ok(step <= -min + 1e-9, `${id}: gap ${step.toFixed(2)} L*`);
    // Darkened by about the rule's step: 4 L*, plus 0.05 per L* above 80, at least 8 above L* 85
    // (8-bit rounding adds < 2).
    const want = Math.max(4 + 0.05 * Math.max(0, l - 80), min);
    assert.ok(-step < want + 2, `${id}: gap ${step.toFixed(2)} L*, rule ${want.toFixed(2)}`);
  }
  assert.ok(nearWhite >= 3, "crystal, crystal clear and silver are near-white");
});

test("tinted render: every stone within 3 L* of its catalogue colour, its inner 60 % within 5, facets kept", async () => {
  for (const pxPerMm of [6, 16]) {
    for (const [id, c] of Object.entries(STONE_COLORS)) {
      const stones = [];
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) stones.push(stone(k * 2.1 + (r % 2) * 1.05, r * 1.82, 2, id, stones.length));
      const sl = new StoneLayout({ layerId: "design", sourceMode: "is", stones });
      const box = tintCanvasMm(sl);
      const render = renderTinted(sl, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
      const { data, info } = await sharp(render.png).raw().toBuffer({ resolveWithObject: true });
      const target = lightnessOfHex(c.fill);
      let spread = 0;
      for (const s of stones) {
        const cx = (s.xMm - box.minXmm) * render.scale, cy = (s.yMm - box.minYmm) * render.scale, R = render.scale;
        const ls = [], inner = [];
        for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
          const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
          if (d2 > R * R) continue;
          const p = (y * info.width + x) * info.channels;
          ls.push(srgbToLab([data[p], data[p + 1], data[p + 2]])[0]);
          if (d2 <= (INNER_SHARE * R) ** 2) inner.push(ls.at(-1));
        }
        const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
        const innerMean = inner.reduce((a, b) => a + b, 0) / inner.length;
        assert.ok(Math.abs(mean - target) <= 3, `${id} at ${pxPerMm} px/mm: stone L* ${mean.toFixed(1)}, fill ${target.toFixed(1)}`);
        assert.ok(Math.abs(innerMean - target) <= 5, `${id} at ${pxPerMm} px/mm: inner 60 % L* ${innerMean.toFixed(1)}, fill ${target.toFixed(1)}`);
        ls.sort((a, b) => a - b);
        spread += (ls[Math.floor(ls.length * 0.95)] - ls[Math.floor(ls.length * 0.05)]) / stones.length;
      }
      // Facets and highlights stay visible: an L* spread inside the stones (5th to 95th
      // percentile) of at least 5 on average (crystal, the palest, has about 10; the others 18-49).
      assert.ok(spread >= 5, `${id} at ${pxPerMm} px/mm: facet spread ${spread.toFixed(1)}`);
    }
  }
});

test("tinted render: a large Jet stone's light rim is as wide as an SS6 Jet stone's (IS-05c)", async () => {
  // Light pixels (L* > 35) within 0.4 mm of the edge, per px of circumference, at 30 px per mm.
  // RS draws the rim 0.09 r wide: an SS20 Jet stone had 2.2 times the SS6 width; IS draws it at the
  // SS6 width. The stone's lightness rule (step 6) still holds.
  const pxPerMm = 30;
  const rim = {};
  for (const d of [2, 2.8, 4, 4.7]) {
    const sl = new StoneLayout({ layerId: "design", sourceMode: "is", stones: [stone(10, 10, d, "jet", 0)] });
    const box = tintCanvasMm(sl);
    const render = renderTinted(sl, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
    const { data, info } = await sharp(render.png).raw().toBuffer({ resolveWithObject: true });
    const c = (10 - box.minXmm) * render.scale, R = (d / 2) * render.scale;
    let light = 0, sum = 0, n = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const p = (y * info.width + x) * info.channels;
      const l = srgbToLab([data[p], data[p + 1], data[p + 2]])[0];
      if (Math.abs(r - R) <= 0.4 * render.scale && l > 35) light++;
      if (r <= R) { sum += l; n++; }
    }
    rim[d] = light / (2 * Math.PI * R);
    assert.ok(Math.abs(sum / n - lightnessOfHex(STONE_COLORS.jet.fill)) <= 3, `jet ${d} mm: stone L* ${(sum / n).toFixed(1)}`);
  }
  for (const d of [2.8, 4, 4.7]) assert.ok(Math.abs(rim[d] - rim[2]) <= 0.25 * rim[2], `jet ${d} mm rim ${rim[d].toFixed(2)} px, SS6 ${rim[2].toFixed(2)} px`);
  // Any other colour is drawn as RS draws it: only Jet's rim is lighter than its fill.
  const lighter = Object.entries(STONE_COLORS).filter(([, c]) => lightnessOfHex(c.stroke) > lightnessOfHex(c.fill)).map(([id]) => id);
  assert.deepEqual(lighter, ["jet"]);
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
  const files = await designFiles(d.stoneLayout, { code: CODE, tintedPng });
  const dir = path.join(WORK, d.id);
  mkdirSync(dir);
  for (const f of files) writeFileSync(path.join(dir, f.name), f.data);
  FILES.set(d.id, { dir, files });
}
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

const fileOf = (id, name) => path.join(FILES.get(id).dir, name);

test("the 8 IS-03b designs: natural size, gap check passed after the SS16 cap and the cleanup", () => {
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
    // The timers are cleared (or unref'd) so the test process exits as soon as the test is done.
    let timer;
    const got = await Promise.race([
      result,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("browser did not answer in 60 s")), 60_000); })
    ]).finally(() => clearTimeout(timer));
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
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left to the OS */ }
  }
});

// pdf.js opens the file: { info (document info), pages ([width, height] in pt per page) }.
async function pdfOpen(file) {
  const task = getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const { info } = await doc.getMetadata();
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
      pages.push([width, height]);
    }
    return { info, pages, numPages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const samePage = ([w, h], [a, b]) => (near(w, a) && near(h, b)) || (near(w, b) && near(h, a));

test("production sheets (A4 and Letter) open in pdf.js: page count, page size, Producer and Creator IS", async () => {
  // Page counts of the 8 designs (A4 and Letter alike), as in docs/IS-04-results.md.
  const PAGES = { "cat-norule": 2, "cat-rule": 2, "dachshund-rule": 1, "dog-norule": 2, "dog-rule": 2, "giraffe-rule": 3, "mug-norule": 1, "mug-rule": 1 };
  for (const d of DESIGNS) {
    for (const [name, size] of [["production-sheet-A4.pdf", [595.28, 841.89]], ["production-sheet-Letter.pdf", [612, 792]]]) {
      const { info, pages, numPages } = await pdfOpen(fileOf(d.id, name));
      assert.equal(info.Producer, "IS", `${d.id} ${name}`);
      assert.equal(info.Creator, "IS");
      assert.equal(info.Title, `IS design ${CODE}`);
      assert.equal(numPages, PAGES[d.id], `${d.id} ${name}: pages`);
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

test("AI opens in pdf.js: one page, the design plus 10 mm, Producer IS", async () => {
  for (const d of DESIGNS) {
    const { info, pages } = await pdfOpen(fileOf(d.id, `${CODE}.ai`));
    assert.equal(info.Producer, "IS");
    assert.equal(info.Creator, "IS");
    assert.equal(pages.length, 1);
    const L = d.stoneLayout;
    assert.ok(near(pages[0][0], (L.widthMm + 2 * AI_MARGIN_MM) * PT_PER_MM, 0.01) && near(pages[0][1], (L.heightMm + 2 * AI_MARGIN_MM) * PT_PER_MM, 0.01), `${d.id}: ${pages[0]}`);
    const pdf = readFileSync(fileOf(d.id, `${CODE}.ai`), "latin1");
    assert.equal((pdf.match(/\nh\nB/g) || []).length, L.count, "one filled circle per stone");
  }
});

// EPSF-3.0 structure (DSC): the header comments up to %%EndComments, prolog, one page, trailer,
// %%EOF; then the drawing run as PostScript: every line outside comments is numbers and the known
// operators (C = filled circle x y r, setrgbcolor, gsave/grestore, showpage) with the operand
// counts they need, nothing left on the stack. -> { header, circles: [{ x, y, r, rgb }] }.
function parseEps(text) {
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(text), "7-bit text only");
  const lines = text.split("\n");
  assert.equal(lines[0], "%!PS-Adobe-3.0 EPSF-3.0");
  const end = lines.indexOf("%%EndComments");
  assert.ok(end > 0, "%%EndComments");
  const header = {};
  for (const line of lines.slice(1, end)) {
    const m = /^%%(\w+): (.*)$/.exec(line);
    assert.ok(m, `header line ${line}`);
    header[m[1]] = m[2];
  }
  const at = (marker) => lines.indexOf(marker);
  const order = ["%%EndComments", "%%BeginProlog", "%%EndProlog", "%%Page: 1 1", "%%Trailer", "%%EOF"].map(at);
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `DSC sections in order: ${order}`);
  assert.deepEqual(lines.slice(order[5] + 1), [""], "nothing after %%EOF");
  assert.deepEqual(lines.slice(order[1] + 1, order[2]), ["/C { newpath 0 360 arc closepath fill } bind def"]);

  const circles = [];
  const stack = [];
  let rgb = null;
  let depth = 0;
  let shown = 0;
  for (const line of lines.slice(order[3] + 1, order[4])) {
    if (line.startsWith("%")) continue;
    for (const token of line.split(" ")) {
      if (/^-?\d+(\.\d+)?$/.test(token)) { stack.push(Number(token)); continue; }
      const take = (n) => { assert.ok(stack.length >= n, `${token} needs ${n} operands`); return stack.splice(-n); };
      if (token === "C") { const [x, y, r] = take(3); circles.push({ x, y, r, rgb }); }
      else if (token === "setrgbcolor") { rgb = take(3); assert.ok(rgb.every((v) => v >= 0 && v <= 1)); }
      else if (token === "gsave") depth++;
      else if (token === "grestore") { depth--; assert.ok(depth >= 0, "grestore without gsave"); }
      else if (token === "showpage") shown++;
      else assert.fail(`unknown operator ${token}`);
    }
    assert.equal(stack.length, 0, `operands left on line ${line}`);
  }
  assert.equal(depth, 0, "gsave/grestore balanced");
  assert.equal(shown, 1, "one showpage");
  assert.ok(circles.every((c) => c.rgb), "a colour is set before the first circle");
  return { header, circles };
}

test("EPS: valid EPSF-3.0 structure, bounding box = design size, one circle per stone, header names IS", () => {
  const unit = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255);
  for (const d of DESIGNS) {
    const L = d.stoneLayout;
    const { header, circles } = parseEps(readFileSync(fileOf(d.id, `${CODE}.eps`), "latin1"));
    assert.equal(header.Creator, "IS", d.id);
    assert.equal(header.Title, `IS design ${CODE}`);
    assert.equal(header.Pages, "1");
    const W = L.widthMm * PT_PER_MM, H = L.heightMm * PT_PER_MM;
    const hi = header.HiResBoundingBox.split(" ").map(Number);
    assert.ok(hi[0] === 0 && hi[1] === 0 && near(hi[2], W, 0.001) && near(hi[3], H, 0.001), `${d.id}: ${header.HiResBoundingBox}`);
    assert.deepEqual(header.BoundingBox.split(" ").map(Number), [0, 0, Math.ceil(hi[2]), Math.ceil(hi[3])]);
    assert.equal(circles.length, L.count, `${d.id}: one circle per stone`);
    // Grouped by colour: each colour is set once. Each circle is its stone, y flipped, in the box.
    const colourRuns = circles.filter((c, i) => i === 0 || c.rgb !== circles[i - 1].rgb).length;
    assert.equal(colourRuns, new Set(L.stones.map((s) => s.color)).size, `${d.id}: one group per colour`);
    const byColour = [...new Set(L.stones.map((s) => s.color))].flatMap((c) => L.stones.filter((s) => s.color === c));
    byColour.forEach((s, i) => {
      const c = circles[i];
      assert.ok(near(c.x, s.xMm * PT_PER_MM, 0.002) && near(c.y, H - s.yMm * PT_PER_MM, 0.002) && near(c.r, s.sizeMm / 2 * PT_PER_MM, 0.002), `${d.id} stone ${i}`);
      assert.ok(unit(STONE_COLORS[s.color].fill).every((v, k) => near(c.rgb[k], v, 1e-4)), `${d.id} stone ${i}: catalogue fill`);
      assert.ok(c.x - c.r >= -0.002 && c.y - c.r >= -0.002 && c.x + c.r <= W + 0.002 && c.y + c.r <= H + 0.002);
    });
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

test("buildDeliveryZip: from the archive to data/delivery/<code>/<code>.zip", async () => {
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
