// Experiment exp-holes, B&W dark-spot diagnosis (tools only, never used by the app; changes nothing).
// Each design is made as the pipeline makes it (cleanedLayout with the hole fill, then
// mapBlackAndWhiteFromImage at the default threshold, the filled stones by the neighbour vote).
//
// 1. Marked stones: Jet stones with at least 2 neighbours (rim gap < 0.5 mm), more than half of them
//    Crystal. Each is classified by the AI pixels the pipeline read for it (the inner 60 % of its
//    disc, lightnessOnWhite), split by the service's detections (trace.detections) into pixels on an
//    AI stone disc (verdicts in STONE_VERDICTS) and gap paint (the rest; painted dots the service
//    dropped as tiny, shadow, gap-dot or interstitial count as gap paint):
//      a  the AI drew a dark stone there: at least half the pixels on dark AI discs (disc L* < threshold);
//      b  on the AI's dark gap paint: at least half the pixels gap paint, and those darker than the
//         threshold;
//      c  other (sub-reason: on a light AI disc, transparent, mixed).
//    Also the distance from the stone's centre to the nearest AI disc's centre (the layout's move).
// 2. Tinted gap pixels (the renderer's rule: a pixel takes its nearest stone's gap colour within
//    FILL_MARGIN_MM of that stone's edge) that are black from a Jet stone while the next stone
//    within reach (its edge also within FILL_MARGIN_MM) is Crystal, at GRID px/mm, by the owner's
//    class (a, b, c, or "edge": a Jet stone that is not marked).
// 3. Close-ups at the 4 windows with the most such pixels from marked stones: AI image | plain |
//    tinted, the marked stones ringed by class (a green, b magenta, c orange).
//
//   node tools/exp-bw-diagnosis.mjs MANIFEST.json OUT_DIR HTML_FILE
//
// MANIFEST as tools/exp-holes.mjs (name, ai, layout, trace). Writes OUT_DIR/diagnosis.json,
// OUT_DIR/NAME-K.jpg and HTML_FILE (images referenced relative to it).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_BW_THRESHOLD, mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { lightnessOnWhite, srgbToLab } from "../src/pipeline/holes.js";
import { FILL_MARGIN_MM } from "../src/render/tinted.js";
import { Stone } from "../src/stones/Stone.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { aiPng, plainPng, rgba, strip, tintedPng } from "./exp-holes.mjs";

const NEAR_MM = 0.5;
const SAMPLE_SHARE = 0.6;
const GRID = 10;
const WINDOW_MM = 10;
const CLOSEUPS = 4;
const STONE_VERDICTS = new Set(["kept", "tiled", "rows-deleted", "duplicate", "inside-big", "outside-mask"]);
const RING = { a: "#12a150", b: "#e0115f", c: "#f08c00" };
const CLASSES = ["a", "b", "c"];

function neighbourLists(stones) {
  const cell = 5;
  const grid = new Map();
  stones.forEach((st, i) => {
    const k = `${Math.floor(st.x / cell)},${Math.floor(st.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  return stones.map((st, i) => {
    const out = [];
    const gx = Math.floor(st.x / cell), gy = Math.floor(st.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) || []) {
        if (j !== i && Math.hypot(stones[j].x - st.x, stones[j].y - st.y) - (stones[j].d + st.d) / 2 < NEAR_MM) out.push(j);
      }
    }
    return out;
  });
}

// Per AI pixel: index of the stone-like detection whose disc covers it (nearest centre), else -1.
function discMap(ai, discs, report) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const { width: w, height: h } = ai;
  const owner = new Int32Array(w * h).fill(-1);
  const dist = new Float32Array(w * h).fill(Infinity);
  discs.forEach(([x, y, d], k) => {
    const cx = (x + ox) / s, cy = (y + oy) / s, r = d / 2 / s;
    for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(h - 1, Math.ceil(cy + r)); py++) {
      for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(w - 1, Math.ceil(cx + r)); px++) {
        const q = (px - cx) ** 2 + (py - cy) ** 2;
        if (q <= r * r && q < dist[py * w + px]) { dist[py * w + px] = q; owner[py * w + px] = k; }
      }
    }
  });
  return owner;
}

// The pixels the pipeline read for a stone (lightnessOnWhite's disc), split by what is under them.
function classify(st, ai, report, owner, discDark, threshold) {
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;
  const cx = (st.x + ox) / s, cy = (st.y + oy) / s;
  const radius = Math.max(2, SAMPLE_SHARE * 0.5 * st.d / s);
  const part = { dark: [0, 0], light: [0, 0], gap: [0, 0], clear: [0, 0] };
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(ai.height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(ai.width - 1, Math.ceil(cx + radius)); x++) {
      if (Math.hypot(y - cy, x - cx) > radius) continue;
      const p = y * ai.width + x, q = p * 4, a = ai.data[q + 3] / 255;
      const L = srgbToLab(...[0, 1, 2].map((k) => ai.data[q + k] * a + 255 * (1 - a)))[0];
      const k = owner[p] >= 0 ? (discDark[owner[p]] ? "dark" : "light") : a < 0.5 ? "clear" : "gap";
      part[k][0]++; part[k][1] += L;
      n++;
    }
  }
  const share = Object.fromEntries(Object.entries(part).map(([k, v]) => [k, n ? v[0] / n : 0]));
  const gapL = part.gap[0] ? part.gap[1] / part.gap[0] : null;
  if (share.dark >= 0.5) return { cls: "a", reason: "dark AI stone", share, gapL };
  if (share.gap >= 0.5 && gapL < threshold) return { cls: "b", reason: "dark gap paint", share, gapL };
  return { cls: "c", reason: share.light >= 0.5 ? "on a light AI stone" : share.clear >= 0.5 ? "transparent" : "mixed", share, gapL };
}

// Nearest and second-nearest stone edge distance per grid pixel (only within FILL_MARGIN_MM).
function nearestTwo(stones, box) {
  const W = Math.ceil(box.w * GRID), H = Math.ceil(box.h * GRID);
  const e1 = new Float32Array(W * H).fill(Infinity), e2 = new Float32Array(W * H).fill(Infinity);
  const o1 = new Int32Array(W * H).fill(-1), o2 = new Int32Array(W * H).fill(-1);
  stones.forEach((st, i) => {
    const r = st.d / 2, reach = r + FILL_MARGIN_MM;
    const x0 = Math.max(0, Math.floor((st.x - reach - box.x0) * GRID)), x1 = Math.min(W - 1, Math.ceil((st.x + reach - box.x0) * GRID));
    const y0 = Math.max(0, Math.floor((st.y - reach - box.y0) * GRID)), y1 = Math.min(H - 1, Math.ceil((st.y + reach - box.y0) * GRID));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const e = Math.hypot(box.x0 + (px + 0.5) / GRID - st.x, box.y0 + (py + 0.5) / GRID - st.y) - r;
        if (e > FILL_MARGIN_MM) continue;
        const p = py * W + px;
        if (e < e1[p]) { e2[p] = e1[p]; o2[p] = o1[p]; e1[p] = e; o1[p] = i; } else if (e < e2[p]) { e2[p] = e; o2[p] = i; }
      }
    }
  });
  return { W, H, e1, e2, o1, o2 };
}

function ringOverlay(view, ppmm, W, H, rings) {
  const circles = rings.map((r) => `<circle cx="${(r.x - view.x0) * ppmm}" cy="${(r.y - view.y0) * ppmm}" r="${r.d / 2 * ppmm + 2}" fill="none" stroke="${r.colour}" stroke-width="2.5"/>`
    + `<text x="${(r.x - view.x0 + r.d / 2) * ppmm + 2}" y="${(r.y - view.y0 - r.d / 2) * ppmm}" font-family="Helvetica, Arial" font-size="15" font-weight="700" fill="${r.colour}" stroke="#fff" stroke-width="3" paint-order="stroke">${r.cls}</text>`).join("");
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${circles}</svg>`);
}

async function ringed(png, view, ppmm, rings) {
  const m = await sharp(png).metadata();
  return sharp(png).composite([{ input: ringOverlay(view, ppmm, m.width, m.height, rings), left: 0, top: 0 }]).png().toBuffer();
}

const median = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export async function diagnose(item, outDir, base, threshold = DEFAULT_BW_THRESHOLD) {
  const at = (p) => path.resolve(base, p);
  const layout = JSON.parse(readFileSync(at(item.layout), "utf8"));
  if (layout.error) return { name: item.name, error: layout.error.message ?? String(layout.error) };
  const trace = JSON.parse(readFileSync(at(item.trace), "utf8"));
  const ai = await rgba(at(item.ai));
  const report = layout.report;
  const s = report.mmPerPx, [ox, oy] = report.offsetMm;

  // The design as the pipeline makes it, back in the layout's mm (the frame of the trace).
  const natural = cleanedLayout(layout, { fillHolesIn: ai });
  const design = mapBlackAndWhiteFromImage(natural.stoneLayout, ai, { ...report, originMm: natural.originMm }, threshold, natural.voted);
  const [gx, gy] = natural.originMm;
  const stones = design.stones.map((st) => ({ x: st.xMm + gx, y: st.yMm + gy, d: st.sizeMm, color: st.color }));
  const voted = new Set(natural.voted);
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const serviceFill = new Set((report.fillAtMm ?? []).map(([x, y]) => key(x, y)));
  const origin = (i) => (voted.has(i) ? "IS fill" : serviceFill.has(key(stones[i].x, stones[i].y)) ? "service fill" : "AI stone");

  const discs = trace.detections.filter((d) => STONE_VERDICTS.has(d[3]));
  const discDark = discs.map(([x, y, d]) => lightnessOnWhite(ai, (x + ox) / s, (y + oy) / s, d, s) < threshold);
  const owner = discMap(ai, discs, report);
  const nearestDisc = (st) => {
    let best = Infinity, k = -1;
    discs.forEach(([x, y], j) => {
      if (Math.abs(x - st.x) > 3 || Math.abs(y - st.y) > 3) return;
      const dd = Math.hypot(x - st.x, y - st.y);
      if (dd < best) { best = dd; k = j; }
    });
    return { dist: best, dark: k >= 0 ? discDark[k] : null };
  };

  // 1. Marked stones and their class.
  const nb = neighbourLists(stones);
  const marked = new Map();
  stones.forEach((st, i) => {
    if (st.color !== "jet" || nb[i].length < 2) return;
    const crystal = nb[i].filter((j) => stones[j].color !== "jet").length;
    if (crystal <= nb[i].length / 2) return;
    const c = classify(st, ai, report, owner, discDark, threshold);
    marked.set(i, { ...c, origin: origin(i), disc: nearestDisc(st), allCrystal: crystal === nb[i].length });
  });
  // Baseline move: the distance from Crystal stones the AI drew to their nearest disc.
  const crystalMoves = stones.flatMap((st, i) => (st.color !== "jet" && origin(i) === "AI stone" && i % 7 === 0 ? [nearestDisc(st).dist] : []));

  // 2. Black gap pixels next to Crystal.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of stones) { x0 = Math.min(x0, st.x - st.d); y0 = Math.min(y0, st.y - st.d); x1 = Math.max(x1, st.x + st.d); y1 = Math.max(y1, st.y + st.d); }
  const box = { x0, y0, w: x1 - x0, h: y1 - y0 };
  const g = nearestTwo(stones, box);
  const px = { blackGap: 0, blackNextCrystal: 0, byOwner: { a: 0, b: 0, c: 0, edge: 0 }, onMarked: { a: 0, b: 0, c: 0 } };
  const heat = new Float32Array(g.W * g.H);
  for (let p = 0; p < g.W * g.H; p++) {
    const i = g.o1[p];
    if (i < 0) continue;
    const m = marked.get(i);
    if (g.e1[p] <= 0) { if (m) px.onMarked[m.cls]++; continue; }
    if (stones[i].color !== "jet") continue;
    px.blackGap++;
    const j = g.o2[p];
    if (j < 0 || stones[j].color === "jet") continue;
    px.blackNextCrystal++;
    px.byOwner[m ? m.cls : "edge"]++;
    if (m) heat[p] = 1;
  }
  const mm2 = (n) => Math.round(n / GRID / GRID * 10) / 10;

  // 3. The 4 windows with the most black-next-to-Crystal pixels from marked stones.
  const cells = Math.round(WINDOW_MM * GRID), stride = Math.round(cells / 4);
  const integral = new Float64Array((g.W + 1) * (g.H + 1));
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    integral[(y + 1) * (g.W + 1) + x + 1] = heat[y * g.W + x] + integral[y * (g.W + 1) + x + 1] + integral[(y + 1) * (g.W + 1) + x] - integral[y * (g.W + 1) + x];
  }
  const sum = (x, y) => integral[(y + cells) * (g.W + 1) + x + cells] - integral[y * (g.W + 1) + x + cells] - integral[(y + cells) * (g.W + 1) + x] + integral[y * (g.W + 1) + x];
  const windows = [];
  for (let y = 0; y + cells <= g.H; y += stride) for (let x = 0; x + cells <= g.W; x += stride) windows.push({ x, y, v: sum(x, y) });
  windows.sort((a, b) => b.v - a.v);
  const picked = [];
  for (const w of windows) {
    if (picked.length >= CLOSEUPS || w.v <= 0) break;
    if (picked.some((o) => Math.abs(o.x - w.x) < cells && Math.abs(o.y - w.y) < cells)) continue;
    picked.push(w);
  }
  const designLayout = new StoneLayout({ layerId: "design", sourceMode: "is", stones: stones.map((st, index) => new Stone({ xMm: st.x, yMm: st.y, sizeMm: st.d, color: st.color, layerId: "design", index })) });
  const ppmm = 36;
  const closeups = [];
  for (const [k, w] of picked.entries()) {
    const view = { x0: box.x0 + w.x / GRID, y0: box.y0 + w.y / GRID, w: WINDOW_MM, h: WINDOW_MM };
    const inView = [...marked.entries()].filter(([i]) => stones[i].x > view.x0 && stones[i].x < view.x0 + view.w && stones[i].y > view.y0 && stones[i].y < view.y0 + view.h);
    const rings = inView.map(([i, m]) => ({ ...stones[i], colour: RING[m.cls], cls: m.cls }));
    const counts = Object.fromEntries(CLASSES.map((c) => [c, inView.filter(([, m]) => m.cls === c).length]));
    const file = `${item.name}-${k + 1}.jpg`;
    const jpg = await strip(null, [
      { label: "AI image", png: await ringed(await aiPng(at(item.ai), report, view, ppmm), view, ppmm, rings) },
      { label: "plain", png: await ringed(plainPng(designLayout, view, ppmm), view, ppmm, rings) },
      { label: "tinted", png: await tintedPng(designLayout, view, ppmm) }
    ], 360);
    writeFileSync(path.join(outDir, file), jpg);
    closeups.push({ file, xMm: r2(view.x0), yMm: r2(view.y0), blackFromMarkedMm2: mm2(w.v), counts });
  }

  const list = [...marked.values()];
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, list.filter((m) => m.cls === c).length]));
  const reasonsC = {};
  for (const m of list) if (m.cls === "c") reasonsC[m.reason] = (reasonsC[m.reason] ?? 0) + 1;
  const byOrigin = {};
  for (const m of list) { byOrigin[m.origin] ??= { a: 0, b: 0, c: 0 }; byOrigin[m.origin][m.cls]++; }
  const moves = (c) => list.filter((m) => m.cls === c && Number.isFinite(m.disc.dist)).map((m) => m.disc.dist);
  return {
    name: item.name,
    stones: stones.length,
    jet: stones.filter((st) => st.color === "jet").length,
    marked: list.length,
    allCrystal: list.filter((m) => m.allCrystal).length,
    byClass,
    reasonsC,
    byOrigin,
    bOnLightDiscNearest: list.filter((m) => m.cls === "b" && m.disc.dark === false).length,
    medianMoveMm: { a: r2(median(moves("a"))), b: r2(median(moves("b"))), c: r2(median(moves("c"))), crystalBaseline: r2(median(crystalMoves)) },
    gapMm2: { blackGap: mm2(px.blackGap), blackNextCrystal: mm2(px.blackNextCrystal), byOwner: Object.fromEntries(Object.entries(px.byOwner).map(([k, v]) => [k, mm2(v)])), onMarkedStones: Object.fromEntries(Object.entries(px.onMarked).map(([k, v]) => [k, mm2(v)])) },
    closeups
  };
}

function html(results, imgDir) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tot = (f) => results.reduce((s, r) => s + (r.error ? 0 : f(r)), 0);
  const rows = results.filter((r) => !r.error).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.stones}</td><td>${r.jet}</td><td>${r.marked}</td><td>${r.byClass.a}</td><td>${r.byClass.b}</td><td>${r.byClass.c}</td><td>${r.medianMoveMm.b ?? "–"} / ${r.medianMoveMm.crystalBaseline}</td><td>${r.gapMm2.blackNextCrystal}</td><td>${r.gapMm2.byOwner.a}</td><td>${r.gapMm2.byOwner.b}</td><td>${r.gapMm2.byOwner.c}</td><td>${r.gapMm2.byOwner.edge}</td></tr>`).join("\n");
  const total = `<tr class="total"><td>total</td><td>${tot((r) => r.stones)}</td><td>${tot((r) => r.jet)}</td><td>${tot((r) => r.marked)}</td><td>${tot((r) => r.byClass.a)}</td><td>${tot((r) => r.byClass.b)}</td><td>${tot((r) => r.byClass.c)}</td><td></td><td>${tot((r) => r.gapMm2.blackNextCrystal).toFixed(1)}</td><td>${tot((r) => r.gapMm2.byOwner.a).toFixed(1)}</td><td>${tot((r) => r.gapMm2.byOwner.b).toFixed(1)}</td><td>${tot((r) => r.gapMm2.byOwner.c).toFixed(1)}</td><td>${tot((r) => r.gapMm2.byOwner.edge).toFixed(1)}</td></tr>`;
  const sections = results.filter((r) => !r.error).map((r) => `<section><h2>${esc(r.name)}</h2>
<p class="meta">${r.marked} marked Jet stones: a ${r.byClass.a}, b ${r.byClass.b}, c ${r.byClass.c}${Object.keys(r.reasonsC).length ? ` (c: ${Object.entries(r.reasonsC).map(([k, v]) => `${esc(k)} ${v}`).join(", ")})` : ""}. Origin: ${Object.entries(r.byOrigin).map(([k, v]) => `${esc(k)} a${v.a}/b${v.b}/c${v.c}`).join("; ")}.</p>
${r.closeups.map((c, k) => `<figure><img src="${imgDir}/${c.file}" alt="${esc(r.name)} close-up ${k + 1}" loading="lazy"><figcaption>${k + 1}. at (${c.xMm}, ${c.yMm}) mm, 10 × 10 mm; marked here: a ${c.counts.a}, b ${c.counts.b}, c ${c.counts.c}; ${c.blackFromMarkedMm2} mm² black gap next to Crystal from marked stones</figcaption></figure>`).join("\n")}
</section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>B&amp;W dark spots</title>
<style>
:root { --bg: #fff; --fg: #1a1f2b; --muted: #667085; --accent: #1d3a8a; --line: #e4e7ec; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, system-ui, sans-serif; }
main { max-width: 1500px; margin: 0 auto; }
h1 { color: var(--accent); margin: 0 0 4px; font-size: 22px; } h2 { font-size: 17px; margin: 24px 0 6px; }
.meta { color: var(--muted); margin: 0 0 12px; }
.scroll { overflow-x: auto; } table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: right; } th:first-child, td:first-child { text-align: left; }
tr.total td { font-weight: 600; } figure { margin: 0 0 16px; } img { max-width: 100%; height: auto; display: block; }
figcaption { color: var(--muted); font-size: 13px; } .key span { font-weight: 700; }
</style></head><body><main>
<h1>Black &amp; white dark spots: diagnosis</h1>
<p class="meta">Private B&amp;W designs as the pipeline makes them (hole fill on, threshold ${DEFAULT_BW_THRESHOLD}). Marked: Jet stones with at least 2 neighbours within 0.5 mm, more than half Crystal.
<span class="key">Ring colours: <span style="color:${RING.a}">a</span> the AI drew a dark stone there, <span style="color:${RING.b}">b</span> the stone sits on the AI's dark gap paint, <span style="color:${RING.c}">c</span> other.</span>
Move: median distance from the stone's centre to the nearest AI stone disc, class b against Crystal stones. Gap: tinted gap area (mm²) that is black from a Jet stone while the next stone within reach is Crystal, by the Jet stone's class ("edge": a Jet stone that is not marked, i.e. the border of a dark area).</p>
<div class="scroll"><table>
<tr><th>design</th><th>stones</th><th>Jet</th><th>marked</th><th>a</th><th>b</th><th>c</th><th>move b / Crystal (mm)</th><th>black next to Crystal (mm²)</th><th>from a</th><th>from b</th><th>from c</th><th>from edge</th></tr>
${rows}
${total}
</table></div>
${sections}
</main></body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestFile, outDir, htmlFile] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const item of manifest) {
    const r = await diagnose(item, outDir, path.dirname(path.resolve(manifestFile)));
    results.push(r);
    console.log(item.name, r.error ? `error: ${r.error}` : `marked ${r.marked} a ${r.byClass.a} b ${r.byClass.b} c ${r.byClass.c} | black next to Crystal ${r.gapMm2.blackNextCrystal} mm2 ${JSON.stringify(r.gapMm2.byOwner)}`);
  }
  writeFileSync(path.join(outDir, "diagnosis.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(htmlFile, html(results, path.relative(path.dirname(path.resolve(htmlFile)), path.resolve(outDir))));
}
