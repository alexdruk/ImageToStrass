// IS-05d follow-up: how transparent the AI images are inside the delivered stones, run by hand (no
// provider or strass call):
//   node tools/is05d-transparency.mjs <runs dir> [variant]
// <runs dir> holds services/strass/scripts/is05d_runs.py's layouts (<run>.<variant>.json, variant
// "final" by default) for the 21 designs of tools/is05b-measure.mjs. For every delivered stone (after
// the SS16 cap and the overlap cleanup) the pixels of the inner 60 % of its radius are counted by
// alpha: 0 (fully transparent), 1–254 (partly, split 1–127, 128–239 and 240–254) and 255 (opaque),
// and the mean alpha deficit (1 − alpha / 255).
// Numbers go to docs/IS-05d-results/transparency.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALL_DESIGNS, SAMPLE_SHARE, decodeRgba, delivered } from "./is05b-measure.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const BANDS = [["transparent", 0, 0], ["low", 1, 127], ["mid", 128, 239], ["high", 240, 254], ["opaque", 255, 255]];

// Pixel counts per alpha band over the inner SAMPLE_SHARE of every delivered stone, in percent.
export function stoneAlpha(layout, { data, width, height }) {
  const { kept } = delivered(layout);
  const [offX, offY] = layout.report.offsetMm;
  const s = layout.report.mmPerPx;
  const n = Object.fromEntries(BANDS.map(([k]) => [k, 0]));
  let total = 0, deficit = 0;
  for (const st of kept) {
    const cx = (st.x + offX) / s, cy = (st.y + offY) / s, r = SAMPLE_SHARE * st.d / 2 / s;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
        const a = data[(y * width + x) * 4 + 3];
        n[BANDS.find(([, lo, hi]) => a >= lo && a <= hi)[0]]++;
        deficit += 1 - a / 255;
        total++;
      }
    }
  }
  const pct = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Math.round(1000 * v / total) / 10]));
  pct.partly = Math.round(10 * (pct.low + pct.mid + pct.high)) / 10;
  return { stones: kept.length, pixels: total, ...pct, deficit: Math.round(1000 * deficit / total) / 10 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [runs, variant = "final"] = process.argv.slice(2);
  if (!runs) throw new Error("usage: node tools/is05d-transparency.mjs <runs dir> [variant]");
  const out = {};
  for (const d of ALL_DESIGNS) {
    const layout = JSON.parse(readFileSync(path.join(runs, `${d.id}.${variant}.json`), "utf8"));
    out[d.id] = stoneAlpha(layout, await decodeRgba(d.ai));
    const r = out[d.id];
    console.log(`| ${d.id} | ${r.stones} | ${r.transparent} | ${r.partly} (${r.low} / ${r.mid} / ${r.high}) | ${r.opaque} | ${r.deficit} |`);
  }
  writeFileSync(path.join(ROOT, "docs/IS-05d-results/transparency.json"), JSON.stringify(out, null, 1) + "\n");
}
