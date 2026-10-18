import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { applyTier } from "../src/pipeline/tiers.js";

// Spec section 7.5 / IS-03 "Done when": 0 gap violations at every T on the 12 RS test layouts
// (the strass /layout answers for the RS test images, written by
// services/strass/scripts/make_test_layouts.py).

export const TARGETS_MM = [140, 180, 250, 260, 300, 420, 600];
const DIR = new URL("./fixtures/layouts/", import.meta.url);
export const LAYOUTS = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), layout: JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));

test("12 test layouts", () => {
  assert.equal(LAYOUTS.length, 12);
});

for (const { name, layout } of LAYOUTS) {
  test(`tiers on ${name}: no overlap, gaps >= 0.1 mm, longest side = max(T, L0)`, () => {
    for (const T of TARGETS_MM) {
      const { stoneLayout, tier, gaps } = applyTier(layout, T);
      assert.equal(gaps.overlaps, 0, `${name} T ${T}: overlaps`);
      assert.equal(gaps.belowMinGap, 0, `${name} T ${T}: gaps below 0.1 mm (min ${gaps.minGapMm})`);
      // A design larger than T keeps its natural size (k 1, r 1).
      const expected = Math.max(T, tier.l0Mm);
      assert.ok(Math.abs(Math.max(stoneLayout.widthMm, stoneLayout.heightMm) - expected) < 1e-6, `${name} T ${T}: size`);
      if (tier.l0Mm > T) assert.deepEqual([tier.k, tier.r], [1, 1], `${name} T ${T}: not scaled`);
      assert.ok(tier.r >= 1, `${name} T ${T}: r ${tier.r}`);
      assert.equal(stoneLayout.count, layout.stones.length);
    }
  });
}
