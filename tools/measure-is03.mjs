// IS-03 measurements for docs/IS-03-results.md (spec sections 7.5 and 7.6), run by hand:
//   node tools/measure-is03.mjs docs/IS-03-results
// On the 12 test layouts (tools/fixtures/layouts): the tier, stretch r and gap growth at every T,
// and the black & white mapping at several thresholds. Writes comparison images to the folder
// given and prints the markdown tables.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { bwColour, lightness, mapBlackAndWhite } from "../src/pipeline/bw.js";
import { applyTier, minRimGap, stonesOfLayout } from "../src/pipeline/tiers.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";
import { findStoneSizeByDiameterMm } from "../src/stones/StoneSizes.js";

const OUT = process.argv[2] || "docs/IS-03-results";
const TARGETS = [140, 180, 250, 260, 300, 420, 600];
const THRESHOLDS = [45, 50, 55, 60, 65];
const DIR = new URL("./fixtures/layouts/", import.meta.url);
const LAYOUTS = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), layout: JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));

mkdirSync(OUT, { recursive: true });

const fmt = (v, p = 2) => v.toFixed(p);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Per stone: rim gap to its nearest neighbour (centre distance minus both radii).
function nearestRimGaps(stones) {
  const dMax = Math.max(...stones.map((s) => s.sizeMm));
  const cell = dMax * 2;
  const grid = new Map();
  for (const s of stones) {
    const k = `${Math.floor(s.xMm / cell)},${Math.floor(s.yMm / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  return stones.map((s) => {
    const gx = Math.floor(s.xMm / cell), gy = Math.floor(s.yMm / cell);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) {
        if (o !== s) best = Math.min(best, Math.hypot(s.xMm - o.xMm, s.yMm - o.yMm) - (s.sizeMm + o.sizeMm) / 2);
      }
    }
    return best;
  });
}

function mainSize(stones) {
  const counts = new Map();
  for (const s of stones) counts.set(s.sizeMm, (counts.get(s.sizeMm) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Median rim gap of main-size stones divided by the main diameter.
function relativeGap(stones) {
  const d = mainSize(stones);
  const gaps = nearestRimGaps(stones).filter((_, i) => stones[i].sizeMm === d);
  return { d, gap: median(gaps), rel: median(gaps) / d };
}

const naturalStones = (layout) => stonesOfLayout(layout).map((s) => ({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color }));

// --- 7.5 tiers ---------------------------------------------------------------------------------
const tierRows = [];
for (const { name, layout } of LAYOUTS) {
  const nat = relativeGap(naturalStones(layout));
  for (const T of TARGETS) {
    const { stoneLayout, tier, gaps } = applyTier(layout, T);
    const now = relativeGap(stoneLayout.stones);
    tierRows.push({
      name, T, l0: tier.l0Mm, k: tier.k, r: tier.r, main: findStoneSizeByDiameterMm(now.d).name,
      natRel: nat.rel, rel: now.rel, growth: now.rel / nat.rel, gapMm: now.gap,
      minGap: gaps.minGapMm, violations: gaps.overlaps + gaps.belowMinGap
    });
  }
}

console.log("## Tiers per layout\n");
console.log("| Layout | L0 mm | stones | sizes (natural) | min gap mm (natural) |");
console.log("| --- | --- | --- | --- | --- |");
for (const { name, layout } of LAYOUTS) {
  const st = naturalStones(layout);
  const sizes = {};
  for (const s of st) { const id = findStoneSizeByDiameterMm(s.sizeMm).name; sizes[id] = (sizes[id] || 0) + 1; }
  console.log(`| ${name} | ${fmt(tierRows.find((r) => r.name === name).l0, 1)} | ${st.length} | ${Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join(", ")} | ${fmt(minRimGap(st).minGapMm, 3)} |`);
}

console.log("\n## By T (all 12 layouts)\n");
console.log("| T mm | tiers k used | main stone | r min-max | median gap / d (natural 0.xx) min-max | gap growth vs natural, max | min gap mm | violations |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const T of TARGETS) {
  const rows = tierRows.filter((r) => r.T === T);
  const ks = [...new Set(rows.map((r) => r.k))].join(", ");
  const mains = [...new Set(rows.map((r) => r.main))].join(", ");
  const span = (f, p = 3) => `${fmt(Math.min(...rows.map(f)), p)}-${fmt(Math.max(...rows.map(f)), p)}`;
  console.log(`| ${T} | ${ks} | ${mains} | ${span((r) => r.r)} | ${span((r) => r.rel)} | ${fmt(Math.max(...rows.map((r) => r.growth)), 2)}x | ${fmt(Math.min(...rows.map((r) => r.minGap)), 3)} | ${rows.reduce((a, r) => a + r.violations, 0)} |`);
}
const natural = LAYOUTS.map(({ layout }) => relativeGap(naturalStones(layout)).rel);
console.log(`\nNatural median gap / d: ${fmt(Math.min(...natural), 3)}-${fmt(Math.max(...natural), 3)}`);
const worst = tierRows.reduce((a, b) => (b.growth > a.growth ? b : a));
console.log(`Largest gap growth: ${fmt(worst.growth, 2)}x on ${worst.name} at T ${worst.T} (k ${worst.k}, r ${fmt(worst.r, 3)}, gap ${fmt(worst.gapMm, 2)} mm on ${worst.main})`);
const worstR = tierRows.reduce((a, b) => (b.r > a.r ? b : a));
console.log(`Largest r: ${fmt(worstR.r, 3)} on ${worstR.name} at T ${worstR.T} (k ${worstR.k})`);

// --- Images ------------------------------------------------------------------------------------
function svgOf(stones, { x0, y0, w, h, scale, colourOf = (s) => STONE_COLORS[s.color].fill, label = "" }) {
  const W = Math.round(w * scale), H = Math.round(h * scale) + (label ? 22 : 0);
  const circles = stones
    .filter((s) => s.xMm + s.sizeMm > x0 && s.xMm - s.sizeMm < x0 + w && s.yMm + s.sizeMm > y0 && s.yMm - s.sizeMm < y0 + h)
    .map((s) => `<circle cx="${((s.xMm - x0) * scale).toFixed(2)}" cy="${((s.yMm - y0) * scale).toFixed(2)}" r="${(s.sizeMm / 2 * scale).toFixed(2)}" fill="${colourOf(s)}"/>`)
    .join("");
  const text = label ? `<rect y="${H - 22}" width="${W}" height="22" fill="#fff"/><text x="6" y="${H - 6}" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#123">${label.replace(/&/g, "&amp;")}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${circles}${text}</svg>`;
}

async function sheet(tiles, file, columns) {
  const pngs = await Promise.all(tiles.map((svg) => sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true })));
  const tw = Math.max(...pngs.map((p) => p.info.width)), th = Math.max(...pngs.map((p) => p.info.height));
  const rows = Math.ceil(pngs.length / columns);
  await sharp({ create: { width: columns * (tw + 8) + 8, height: rows * (th + 8) + 8, channels: 3, background: "#dfe4ea" } })
    .composite(pngs.map((p, i) => ({ input: p.data, left: 8 + (i % columns) * (tw + 8), top: 8 + Math.floor(i / columns) * (th + 8) })))
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, file));
}

// Zoomed crops: the same part of the design (25 main stones wide, around the centre of the
// subject), with the main stone always 12 px wide, so wider relative gaps show directly.
for (const name of ["portrait", "cat", "parrot"]) {
  const { layout } = LAYOUTS.find((l) => l.name === name);
  const tiles = [];
  const natural = naturalStones(layout);
  const cut = (stones, label) => {
    const d = mainSize(stones);
    const box = { w: 25 * d, h: 25 * d };
    const xs = stones.map((s) => s.xMm), ys = stones.map((s) => s.yMm);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) * 0.4;
    return svgOf(stones, { x0: cx - box.w / 2, y0: cy - box.h / 2, ...box, scale: 12 / d, label });
  };
  tiles.push(cut(natural, `natural ${fmt(Math.max(...natural.map((s) => s.xMm)), 0)} mm, SS6`));
  for (const T of TARGETS) {
    const { stoneLayout, tier } = applyTier(layout, T);
    tiles.push(cut(stoneLayout.stones, `T ${T}: k ${tier.k}, r ${fmt(tier.r, 2)}, ${findStoneSizeByDiameterMm(mainSize(stoneLayout.stones)).name}`));
  }
  await sheet(tiles, `tiers-${name}.png`, 4);
}

// --- 7.6 black & white -------------------------------------------------------------------------
console.log("\n## Catalogue L* (sorted)\n");
const catalogue = Object.values(STONE_COLORS).map((c) => ({ id: c.id, name: c.name, fill: c.fill, l: lightness(c.fill) })).sort((a, b) => a.l - b.l);
console.log("| colour | fill | L* | at 55 |");
console.log("| --- | --- | --- | --- |");
for (const c of catalogue) console.log(`| ${c.name} | ${c.fill} | ${fmt(c.l, 1)} | ${bwColour(c.id, 55) === "jet" ? "Jet" : "Crystal"} |`);

console.log("\n## Jet share per threshold\n");
console.log(`| Layout | ${THRESHOLDS.map((t) => `Jet % at ${t}`).join(" | ")} | pupils Jet at 55 | catch-lights Crystal at 55 |`);
console.log(`| --- | ${THRESHOLDS.map(() => "---").join(" | ")} | --- | --- |`);
for (const { name, layout } of LAYOUTS) {
  const st = naturalStones(layout);
  const shares = THRESHOLDS.map((t) => fmt(100 * st.filter((s) => bwColour(s.color, t) === "jet").length / st.length, 1));
  // Pupils: the stones larger than SS10 (SS16/SS20/SS30). Catch-lights: Crystal stones touching a pupil.
  const pupils = st.filter((s) => s.sizeMm > 2.8);
  const catch_ = st.filter((s) => s.color === "crystal-clear" && pupils.some((p) => Math.hypot(p.xMm - s.xMm, p.yMm - s.yMm) < (p.sizeMm + s.sizeMm) / 2 + 0.6));
  const pj = pupils.filter((p) => bwColour(p.color, 55) === "jet").length;
  const cc = catch_.filter((c) => bwColour(c.color, 55) === "crystal-clear").length;
  console.log(`| ${name} | ${shares.join(" | ")} | ${pj}/${pupils.length} (${[...new Set(pupils.map((p) => p.color))].join(", ") || "-"}) | ${cc}/${catch_.length} |`);
}

for (const names of [["portrait", "cat", "parrot"], ["einstein", "rose", "logo"]]) {
  const tiles = [];
  for (const name of names) {
    const { layout } = LAYOUTS.find((l) => l.name === name);
    const { stoneLayout } = applyTier(layout, 250);
    const box = { x0: 0, y0: 0, w: stoneLayout.widthMm, h: stoneLayout.heightMm };
    const scale = 300 / Math.max(box.w, box.h);
    tiles.push(svgOf(stoneLayout.stones, { ...box, scale, label: `${name}: colour` }));
    for (const t of [45, 55, 65]) {
      const bw = mapBlackAndWhite(stoneLayout, t);
      tiles.push(svgOf(bw.stones, { ...box, scale, label: `${name}: B&W at ${t}` }));
    }
  }
  await sheet(tiles, `bw-${names.join("-")}.png`, 4);
}
console.log(`\nImages written to ${OUT}`);
