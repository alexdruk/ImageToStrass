import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { applyTier, naturalLayout } from "../src/pipeline/tiers.js";

// Spec section 7.5: every design is delivered at its natural size; the 12 RS test layouts (the
// strass /layout answers for the RS test images, written by
// services/strass/scripts/make_test_layouts.py) pass the gap check there. The unused tier code
// keeps its IS-03 test: 0 gap violations at every T >= L0, and T < L0 refused.

export const TARGETS_MM = [140, 180, 250, 260, 300, 420, 600];
const DIR = new URL("./fixtures/layouts/", import.meta.url);
export const LAYOUTS = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), layout: JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));

test("12 test layouts", () => {
  assert.equal(LAYOUTS.length, 12);
});

for (const { name, layout } of LAYOUTS) {
  test(`natural size on ${name}: no overlap, gaps >= 0.1 mm, positions and sizes as measured`, () => {
    const { stoneLayout, gaps } = naturalLayout(layout);
    assert.equal(gaps.overlaps, 0, `${name}: overlaps`);
    assert.equal(gaps.belowMinGap, 0, `${name}: gaps below 0.1 mm (min ${gaps.minGapMm})`);
    assert.equal(stoneLayout.count, layout.stones.length);
    const box = stoneLayout.getBoundingBox();
    assert.ok(Math.abs(box.minXmm) < 1e-9 && Math.abs(box.minYmm) < 1e-9, "origin top-left");
    const dx = stoneLayout.stones[0].xMm - layout.stones[0][0];
    const dy = stoneLayout.stones[0].yMm - layout.stones[0][1];
    stoneLayout.stones.forEach((s, i) => {
      assert.ok(Math.abs(s.xMm - layout.stones[i][0] - dx) < 1e-9 && Math.abs(s.yMm - layout.stones[i][1] - dy) < 1e-9);
    });
  });

  test(`tiers on ${name}: no overlap, gaps >= 0.1 mm, longest side = T; T < L0 refused`, () => {
    const natural = naturalLayout(layout).stoneLayout;
    const l0 = Math.max(natural.widthMm, natural.heightMm);
    for (const T of TARGETS_MM) {
      if (T < l0) {
        assert.throws(() => applyTier(layout, T), RangeError, `${name} T ${T}`);
        continue;
      }
      const { stoneLayout, tier, gaps } = applyTier(layout, T);
      assert.equal(gaps.overlaps, 0, `${name} T ${T}: overlaps`);
      assert.equal(gaps.belowMinGap, 0, `${name} T ${T}: gaps below 0.1 mm (min ${gaps.minGapMm})`);
      assert.ok(Math.abs(Math.max(stoneLayout.widthMm, stoneLayout.heightMm) - T) < 1e-6, `${name} T ${T}: size`);
      assert.ok(tier.r >= 1, `${name} T ${T}: r ${tier.r}`);
      assert.equal(stoneLayout.count, layout.stones.length);
    }
  });
}
