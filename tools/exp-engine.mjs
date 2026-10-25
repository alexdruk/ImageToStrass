// Experiment exp-engine (docs/exp-engine.md; tools only): today's designs and the engine's
// (src/engine/, IS_ENGINE=concept) side by side, from saved AI images only (no provider calls), with
// the concept's checks 1-4 (src/engine/checks.js), time per design and stone counts.
//
//   node tools/exp-engine.mjs public              the 9 CC0 fixtures and the 12 RS images
//   node tools/exp-engine.mjs private             the private photos (colour, halftone, stencil)
//   node tools/exp-engine.mjs public NAME ...     only those designs
//   node tools/exp-engine.mjs tables public|private   the results as markdown tables (stdout)
//   node tools/exp-engine.mjs page                the private page data/private-portraits/engine.html
//
// Layouts: the saved /layout answers of exp-faces (data/exp-faces/layouts, and for the private photos
// the manifest data/private-portraits/faces/manifest.json); the three CC0 "norule" images had none,
// so the local strass service lays them out once (cached in data/exp-engine/layouts/).
//
// Writes, per design, a whole view (original | AI image | today | engine | map) and close-ups (AI |
// today | engine) at a line, an area border, a row seam and the face, plus the map (JSON and PNG) and
// results.json. Public designs: pictures in docs/exp-engine/, maps in data/exp-engine/maps/.
// Private photos: everything under data/private-portraits/engine/ and the page
// data/private-portraits/engine.html (never in docs/ or git).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { engineLayout, mapPicture, mapToJSON, todaysDesign } from "../src/engine/index.js";
import { runChecks } from "../src/engine/checks.js";
import { callLayoutService } from "../src/pipeline/layout.js";
import { aiImageForArchive } from "../src/prep/pngmeta.js";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const R = (...p) => path.join(ROOT, ...p);
const PANEL_H = 520;
const CLOSE_PX = 300;
const CLOSE_MM = 20;
const TINT_PPMM = 16;

function publicDesigns() {
  const list = [];
  for (const n of ["car-rule", "cat-norule", "cat-rule", "dachshund-rule", "dog-norule", "dog-rule", "giraffe-rule", "mug-norule", "mug-rule"]) {
    const photo = n.split("-")[0];
    const saved = R("data/exp-faces/layouts", `cc0-${photo}-layout.json`);
    list.push({
      name: `cc0-${n}`, set: "CC0", style: "colour", original: R("services/strass/tests/fixtures/photos", `${photo}.jpg`),
      ai: R("tools/fixtures/is03b-ai", `${n}-output.png`),
      layout: n.endsWith("-rule") && existsSync(saved) ? saved : R("data/exp-engine/layouts", `cc0-${n}-layout.json`)
    });
  }
  for (const n of ["cat", "dog", "einstein", "jesus", "lake", "leopard", "logo", "parrot", "portrait", "rose", "tulips", "woman"]) {
    list.push({ name: `rs-${n}`, set: "RS", style: "colour", original: null, ai: R("services/strass/prototype/img", `N2_${n}.png`), layout: R("data/exp-faces/layouts", `rs-${n}-layout.json`) });
  }
  return list;
}

function privateDesigns() {
  return JSON.parse(readFileSync(R("data/private-portraits/faces/manifest.json"), "utf8")).map((e) => ({
    name: `${e.name}-${e.style}`, set: "private", style: e.style, original: e.original, ai: e.ai, layout: e.layout
  }));
}

async function rgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function layoutOf(design) {
  if (existsSync(design.layout)) return JSON.parse(readFileSync(design.layout, "utf8"));
  const png = await aiImageForArchive(readFileSync(design.ai));
  const answer = await callLayoutService({
    fetch: globalThis.fetch, timers: { setTimeout, clearTimeout }, url: process.env.STRASS_SERVICE_URL || "http://127.0.0.1:8000",
    timeoutMs: 600000, pngBuffer: png, colorIds: Object.keys(STONE_COLORS), signal: new AbortController().signal
  });
  if (!answer.layout) throw new Error(`Layout for ${design.name} failed: ${JSON.stringify(answer.error)}`);
  mkdirSync(path.dirname(design.layout), { recursive: true });
  writeFileSync(design.layout, `${JSON.stringify(answer.layout)}\n`);
  return answer.layout;
}

// Plain layout-mm stones -> a StoneLayout in the same mm (no shift), for renders cut by mm.
const layoutMm = (stones) => new StoneLayout({
  layerId: "design", sourceMode: "is",
  stones: stones.map((s, index) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color, layerId: "design", index }))
});

// The tinted render at TINT_PPMM with its box, to cut views by layout mm.
function tinted(stones, bwGap) {
  const sl = layoutMm(stones);
  const box = tintCanvasMm(sl);
  const r = renderTinted(sl, { longSidePx: Math.round(TINT_PPMM * Math.max(box.widthMm, box.heightMm)), background: "white", bwGap });
  return { png: r.png, box, scale: r.scale, widthPx: r.widthPx, heightPx: r.heightPx };
}

async function cut(t, x0, y0, size) {
  const left = Math.round((x0 - t.box.minXmm) * t.scale), top = Math.round((y0 - t.box.minYmm) * t.scale), side = Math.round(size * t.scale);
  return cropPadded(t.png, t.widthPx, t.heightPx, left, top, side);
}

async function cropPadded(png, w, h, left, top, side) {
  const l = Math.max(0, left), tp = Math.max(0, top), r = Math.min(w, left + side), b = Math.min(h, top + side);
  const base = sharp({ create: { width: side, height: side, channels: 3, background: "#ffffff" } });
  if (r <= l || b <= tp) return base.resize(CLOSE_PX, CLOSE_PX).png().toBuffer();
  const inner = await sharp(png).flatten({ background: "#ffffff" }).extract({ left: l, top: tp, width: r - l, height: b - tp }).toBuffer();
  const out = await base.composite([{ input: inner, left: l - left, top: tp - top }]).png().toBuffer();
  return sharp(out).resize(CLOSE_PX, CLOSE_PX).png().toBuffer();
}

async function aiCut(aiFile, report, x0, y0, size) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const meta = await sharp(aiFile).metadata();
  const png = await sharp(aiFile).flatten({ background: "#ffffff" }).png().toBuffer();
  return cropPadded(png, meta.width, meta.height, Math.round((x0 + ox) / s), Math.round((y0 + oy) / s), Math.round(size / s));
}

// Where to look closer: { kind, x, y, size } in layout mm.
function closeUpSpots(map, engine) {
  const spots = [];
  const { grid, areaOf, borderDist, regions } = map;
  const longest = [...map.lines].sort((a, b) => b.lengthMm - a.lengthMm)[0];
  if (longest) {
    const p = longest.points[Math.floor(longest.points.length / 2)];
    spots.push({ kind: "line", x: p.xMm, y: p.yMm, size: CLOSE_MM });
  }
  // Area border: the longest border between two areas, its middle cell away from lines and faces.
  const pairs = new Map();
  for (let k = 0; k < grid.n; k++) {
    if (borderDist[k] > 0.05 || areaOf[k] < 0) continue;
    const i = k % grid.w;
    for (const m of [i < grid.w - 1 ? k + 1 : -1, k + grid.w < grid.n ? k + grid.w : -1]) {
      if (m < 0 || areaOf[m] < 0 || areaOf[m] === areaOf[k]) continue;
      const key = `${Math.min(areaOf[k], areaOf[m])}-${Math.max(areaOf[k], areaOf[m])}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(k);
    }
  }
  const lineNear = (x, y) => map.lines.some((l) => l.points.some((p) => Math.hypot(p.xMm - x, p.yMm - y) < 4));
  const best = [...pairs.values()].sort((a, b) => b.length - a.length)[0];
  if (best) {
    const cells = best.filter((k) => !lineNear(grid.cx(k), grid.cy(k)) && !regions.some((r) => Math.hypot(r.x - grid.cx(k), r.y - grid.cy(k)) < r.ax + 4));
    const k = (cells.length ? cells : best)[Math.floor((cells.length ? cells : best).length / 2)];
    spots.push({ kind: "area border", x: grid.cx(k), y: grid.cy(k), size: CLOSE_MM });
  }
  // Row seam: where the engine's seam stones are densest (outside the faces).
  const seams = engine.stones.filter((s) => s.role === "seam" && !regions.some((r) => Math.hypot(r.x - s.x, r.y - s.y) < r.ax));
  let top = null, n = -1;
  for (const s of seams) {
    const c = seams.filter((o) => Math.hypot(o.x - s.x, o.y - s.y) < 4).length;
    if (c > n) { n = c; top = s; }
  }
  if (top) spots.push({ kind: "row seam", x: top.x, y: top.y, size: CLOSE_MM });
  const eyes = regions.filter((r) => r.kind === "eye");
  if (eyes.length === 2) {
    const ipd = Math.hypot(eyes[1].x - eyes[0].x, eyes[1].y - eyes[0].y);
    const size = Math.max(CLOSE_MM, 2.2 * ipd);
    spots.push({ kind: "face", x: (eyes[0].x + eyes[1].x) / 2, y: (eyes[0].y + eyes[1].y) / 2 + 0.45 * ipd, size });
  }
  return spots;
}

async function label(png, text, width) {
  const svg = `<svg width="${width}" height="26" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff"/><text x="6" y="18" font-family="Helvetica, Arial" font-size="15" fill="#1d3557">${text}</text></svg>`;
  const meta = await sharp(png).metadata();
  return sharp({ create: { width: Math.max(width, meta.width), height: meta.height + 26, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: png, left: 0, top: 26 }]).png().toBuffer();
}

async function row(panels, gap = 8) {
  const metas = await Promise.all(panels.map((p) => sharp(p).metadata()));
  const width = metas.reduce((s, m) => s + m.width, 0) + gap * (panels.length - 1), height = Math.max(...metas.map((m) => m.height));
  let x = 0;
  const comp = panels.map((p, i) => { const c = { input: p, left: x, top: 0 }; x += metas[i].width + gap; return c; });
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).composite(comp).png().toBuffer();
}

async function column(rows, gap = 10) {
  const metas = await Promise.all(rows.map((p) => sharp(p).metadata()));
  const width = Math.max(...metas.map((m) => m.width)), height = metas.reduce((s, m) => s + m.height, 0) + gap * (rows.length - 1);
  let y = 0;
  const comp = rows.map((p, i) => { const c = { input: p, left: 0, top: y }; y += metas[i].height + gap; return c; });
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).composite(comp).png().toBuffer();
}

const fit = (input, h = PANEL_H) => sharp(input).flatten({ background: "#ffffff" }).resize({ height: h, width: Math.round(h * 0.95), fit: "contain", background: "#ffffff" }).png().toBuffer();

const countBy = (stones, key) => stones.reduce((m, s) => { m[key(s)] = (m[key(s)] || 0) + 1; return m; }, {});

async function runOne(design, out) {
  const ai = await rgba(design.ai);
  const layout = await layoutOf(design);
  const mode = design.style === "colour" ? "colour" : "bw";
  const style = design.style === "stencil" ? "stencil" : "halftone";
  const t0 = performance.now();
  const today = todaysDesign(layout, ai, { mode });
  const t1 = performance.now();
  const engine = engineLayout(layout, ai, { mode, style, today: today.stones });
  const t2 = performance.now();
  const checksToday = runChecks(today.stones, engine.map);
  const checksEngine = runChecks(engine.stones, engine.map, { chains: engine.chains });
  for (const c of [checksToday, checksEngine]) c.holes.at = c.holes.at.length;
  const box = (sl) => ({ widthMm: Math.round(sl.widthMm * 10) / 10, heightMm: Math.round(sl.heightMm * 10) / 10 });
  const result = {
    name: design.name, set: design.set, style: design.style,
    today: { stones: today.stones.length, ms: Math.round(t1 - t0), size: box(today.stoneLayout), bySize: countBy(today.stones, (s) => s.d), checks: checksToday },
    engine: {
      stones: engine.stones.length, ms: Math.round(t2 - t1), msParts: engine.ms, size: box(engine.stoneLayout), bySize: countBy(engine.stones, (s) => s.d),
      byRole: countBy(engine.stones, (s) => s.role), stats: engine.stats, checks: checksEngine,
      map: { lines: engine.map.lines.length, areas: engine.map.areas.length, faces: engine.map.regions.length, discs: engine.map.discs.length }
    }
  };

  // Map (JSON + PNG).
  const mapPng = mapPicture(engine.map);
  writeFileSync(path.join(out.maps, `${design.name}-map.json`), `${JSON.stringify(mapToJSON(engine.map))}\n`);
  writeFileSync(path.join(out.maps, `${design.name}-map.png`), mapPng);

  // Pictures.
  const bwGap = mode === "bw" ? "crystal" : null;
  const tToday = tinted(today.stones, bwGap), tEngine = tinted(engine.stones, bwGap);
  const blank = await sharp({ create: { width: 300, height: PANEL_H, channels: 3, background: "#f2f2f2" } }).png().toBuffer();
  const whole = await row([
    await label(design.original ? await fit(design.original) : blank, design.original ? "original" : "original (none)", 200),
    await label(await fit(design.ai), "AI image (map source)", 200),
    await label(await fit(tToday.png), `today: ${result.today.stones} stones`, 200),
    await label(await fit(tEngine.png), `engine: ${result.engine.stones} stones`, 200),
    await label(await fit(mapPng), "map", 200)
  ]);
  await sharp(whole).jpeg({ quality: 78 }).toFile(path.join(out.pics, `${design.name}-whole.jpg`));
  const rows = [];
  for (const spot of closeUpSpots(engine.map, engine)) {
    const x0 = spot.x - spot.size / 2, y0 = spot.y - spot.size / 2;
    rows.push(await row([
      await label(await aiCut(design.ai, layout.report, x0, y0, spot.size), `${spot.kind}: AI image`, CLOSE_PX),
      await label(await cut(tToday, x0, y0, spot.size), `${spot.kind}: today`, CLOSE_PX),
      await label(await cut(tEngine, x0, y0, spot.size), `${spot.kind}: engine`, CLOSE_PX)
    ]));
  }
  if (rows.length) await sharp(await column(rows)).jpeg({ quality: 80 }).toFile(path.join(out.pics, `${design.name}-closeups.jpg`));
  result.closeUps = rows.length;
  return result;
}

const fmt = (c) => [
  `${c.gaps.violations} / ${c.gaps.minGapMm}`,
  `${c.lines.clean}/${c.lines.lines} · ${c.lines.offColour} · ${c.lines.offSize} · ${c.lines.breaks} · ${c.lines.missing}`,
  `${c.areas.overTones} (${c.areas.maxTones}) · ${c.areas.smallPatches}${c.areas.halftonePatches ? ` (+${c.areas.halftonePatches} ht)` : ""}`,
  `${c.holes.holes} / ${c.holes.largestMm}`
];

export function tableRows(results) {
  const lines = [
    "| Design | | Stones | ms | Size mm | 1 Gaps: viol. / min | 2 Lines: clean · other colour · other size · breaks · missing | 3 Areas: >3 tones (max) · patches <4 | 4 Holes >1 mm / largest |",
    "| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |"
  ];
  for (const r of results) {
    for (const [who, d] of [["today", r.today], ["engine", r.engine]]) {
      lines.push(`| ${who === "today" ? `${r.name}` : ""} | ${who} | ${d.stones} | ${d.ms} | ${d.size.widthMm} × ${d.size.heightMm} | ${fmt(d.checks).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

export function summary(results) {
  const sum = (who, f) => results.reduce((s, r) => s + f(r[who]), 0);
  const all = (who, f) => results.filter((r) => f(r[who])).length;
  const out = {};
  for (const who of ["today", "engine"]) {
    out[who] = {
      designs: results.length,
      gapPass: all(who, (d) => d.checks.gaps.pass),
      lines: sum(who, (d) => d.checks.lines.lines), cleanLines: sum(who, (d) => d.checks.lines.clean),
      offColour: sum(who, (d) => d.checks.lines.offColour), offSize: sum(who, (d) => d.checks.lines.offSize),
      breaks: sum(who, (d) => d.checks.lines.breaks), missing: sum(who, (d) => d.checks.lines.missing), linePass: all(who, (d) => d.checks.lines.pass),
      overTones: sum(who, (d) => d.checks.areas.overTones), smallPatches: sum(who, (d) => d.checks.areas.smallPatches), areaPass: all(who, (d) => d.checks.areas.pass),
      holes: sum(who, (d) => d.checks.holes.holes), holePass: all(who, (d) => d.checks.holes.pass),
      largestHole: Math.max(...results.map((r) => r[who].checks.holes.largestMm)),
      stones: sum(who, (d) => d.stones), ms: sum(who, (d) => d.ms), maxMs: Math.max(...results.map((r) => r[who].ms))
    };
  }
  return out;
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function bySet(results) {
  const groups = new Map();
  for (const r of results) {
    const key = r.set === "private" ? r.style : r.set;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function summaryTable(results) {
  const lines = ["| Set | Designs | Who | Gap pass | Clean lines | Other colour on lines | Breaks | Missing lines | Areas >3 tones | Patches <4 | Holes >1 mm | Largest hole | Stones | ms (mean / max) |", "| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"];
  for (const [key, list] of bySet(results)) {
    const s = summary(list);
    for (const who of ["today", "engine"]) {
      const v = s[who];
      lines.push(`| ${who === "today" ? key : ""} | ${who === "today" ? v.designs : ""} | ${who} | ${v.gapPass}/${v.designs} | ${v.cleanLines}/${v.lines} | ${v.offColour} | ${v.breaks} | ${v.missing} | ${v.overTones} | ${v.smallPatches} | ${v.holes} | ${v.largestHole} | ${v.stones} | ${Math.round(v.ms / v.designs)} / ${v.maxMs} |`);
    }
  }
  return lines.join("\n");
}

function page(results) {
  const md = (t) => esc(t).split("\n").filter((l) => !/^\| ---/.test(l)).map((l, i) => `<tr>${l.split("|").slice(1, -1).map((c) => (i ? `<td>${c.trim()}</td>` : `<th>${c.trim()}</th>`)).join("")}</tr>`).join("\n");
  const designs = results.map((r) => `<section><h3>${esc(r.name)}</h3>
<p>today ${r.today.stones} stones, ${r.today.ms} ms · engine ${r.engine.stones} stones, ${r.engine.ms} ms (map ${r.engine.msParts.map}, placement ${r.engine.msParts.place}) · roles ${esc(JSON.stringify(r.engine.byRole))} · map ${r.engine.map.lines} lines, ${r.engine.map.areas} areas, ${r.engine.map.faces} face regions</p>
<img src="engine/${esc(r.name)}-whole.jpg" alt="${esc(r.name)} whole"><img src="engine/${esc(r.name)}-closeups.jpg" alt="${esc(r.name)} close-ups"></section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Engine comparison (private)</title>
<style>body{font-family:Helvetica,Arial,sans-serif;margin:16px;color:#1d3557;background:#fff}table{border-collapse:collapse;font-size:13px;margin:8px 0 20px}td,th{border:1px solid #ccd;padding:3px 6px;text-align:right}th{background:#eef2fa}td:first-child,th:first-child{text-align:left}img{max-width:100%;display:block;margin:6px 0}section{border-top:1px solid #ccd;margin-top:18px}</style></head><body>
<h1>Engine comparison: private photos</h1>
<p>Private: images, numbers and this page stay under data/private-portraits/. Method and the public results: docs/exp-engine.md. Each design: original | AI image (the map's source) | today | engine | map, then close-ups (AI | today | engine) at a line, an area border, a row seam and the face. Maps: engine/maps/.</p>
<h2>Summary by style</h2><table>${md(summaryTable(results))}</table>
<h2>Checks per design</h2><p>1 gaps: violations / smallest gap (mm) · 2 lines: clean of all · stones of another colour · of another size · breaks · missing lines · 3 areas: areas over 3 tones (most tones) · patches under 4 stones (halftone pattern patches apart) · 4 holes: empty circles over 1.0 mm / largest (mm).</p>
<table>${md(tableRows(results))}</table>
<h2>Designs</h2>${designs}</body></html>\n`;
}

async function main() {
  const [which, ...only] = process.argv.slice(2);
  if (which === "tables") {
    const file = only[0] === "private" ? R("data/private-portraits/engine/results.json") : R("docs/exp-engine/results.json");
    const { results } = JSON.parse(readFileSync(file, "utf8"));
    console.log(`${summaryTable(results)}\n\n${tableRows(results)}`);
    return;
  }
  if (which === "page") {
    const { results } = JSON.parse(readFileSync(R("data/private-portraits/engine/results.json"), "utf8"));
    writeFileSync(R("data/private-portraits/engine.html"), page(results));
    return;
  }
  if (which !== "public" && which !== "private") throw new Error("Usage: node tools/exp-engine.mjs public|private [NAME ...] | tables public|private | page");
  const out = which === "public"
    ? { pics: R("docs/exp-engine"), maps: R("data/exp-engine/maps"), results: R("docs/exp-engine/results.json") }
    : { pics: R("data/private-portraits/engine"), maps: R("data/private-portraits/engine/maps"), results: R("data/private-portraits/engine/results.json") };
  for (const d of [out.pics, out.maps]) mkdirSync(d, { recursive: true });
  let designs = which === "public" ? publicDesigns() : privateDesigns();
  if (only.length) designs = designs.filter((d) => only.includes(d.name));
  const previous = existsSync(out.results) ? JSON.parse(readFileSync(out.results, "utf8")).results : [];
  const results = previous.filter((r) => !designs.some((d) => d.name === r.name));
  for (const design of designs) {
    const t = Date.now();
    const r = await runOne(design, out);
    results.push(r);
    const e = r.engine.checks, d = r.today.checks;
    console.log(`${design.name}: today ${r.today.stones} (${r.today.ms} ms) holes ${d.holes.holes}, lines ${d.lines.clean}/${d.lines.lines}, patches ${d.areas.smallPatches} | engine ${r.engine.stones} (${r.engine.ms} ms) gaps ${e.gaps.violations} holes ${e.holes.holes}, lines ${e.lines.clean}/${e.lines.lines}, patches ${e.areas.smallPatches} [${Date.now() - t} ms]`);
  }
  const order = (which === "public" ? publicDesigns() : privateDesigns()).map((d) => d.name);
  results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  writeFileSync(out.results, `${JSON.stringify({ summary: summary(results), results }, null, 1)}\n`);
  console.log(JSON.stringify(summary(results), null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
