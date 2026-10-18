import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { MAX_STONE_SIZE_ID, applyTier, naturalLayout } from "../src/pipeline/tiers.js";
import { getStoneSize } from "../src/stones/StoneSizes.js";

// Spec section 7.5: every design is delivered at its natural size; the 12 RS test layouts (the
// strass /layout answers for the RS test images, written by
// services/strass/scripts/make_test_layouts.py) pass the gap check there, with every stone above
// SS16 capped to SS16 (D2; 13 SS20/SS30 pupils in 7 of the 12 layouts). The unused tier code
// keeps its IS-03 test: 0 gap violations at every T >= L0, and T < L0 refused.

export const TARGETS_MM = [140, 180, 250, 260, 300, 420, 600];
const DIR = new URL("./fixtures/layouts/", import.meta.url);
export const LAYOUTS = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f.replace(/\.json$/, ""), layout: JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));

const MAX_D = getStoneSize(MAX_STONE_SIZE_ID).diameterMm;
const diameterOf = (sizeId) => getStoneSize(sizeId).diameterMm;

test("12 test layouts", () => {
  assert.equal(LAYOUTS.length, 12);
});

test("SS16 cap on the 12 test layouts: 13 stones changed", () => {
  const capped = Object.fromEntries(LAYOUTS.map(({ name, layout }) => [name, naturalLayout(layout).capped]));
  assert.deepEqual(capped, { cat: 2, dog: 2, einstein: 2, jesus: 1, lake: 0, leopard: 2, logo: 0, parrot: 1, portrait: 0, rose: 0, tulips: 0, woman: 2 });
});

for (const { name, layout } of LAYOUTS) {
  test(`natural size on ${name}: no overlap, gaps >= 0.1 mm, positions as measured, sizes capped at SS16`, () => {
    const { stoneLayout, gaps, capped } = naturalLayout(layout);
    assert.equal(gaps.overlaps, 0, `${name}: overlaps`);
    assert.equal(gaps.belowMinGap, 0, `${name}: gaps below 0.1 mm (min ${gaps.minGapMm})`);
    assert.equal(stoneLayout.count, layout.stones.length);
    const box = stoneLayout.getBoundingBox();
    assert.ok(Math.abs(box.minXmm) < 1e-9 && Math.abs(box.minYmm) < 1e-9, "origin top-left");
    const dx = stoneLayout.stones[0].xMm - layout.stones[0][0];
    const dy = stoneLayout.stones[0].yMm - layout.stones[0][1];
    stoneLayout.stones.forEach((s, i) => {
      assert.ok(Math.abs(s.xMm - layout.stones[i][0] - dx) < 1e-9 && Math.abs(s.yMm - layout.stones[i][1] - dy) < 1e-9);
      assert.equal(s.sizeMm, Math.min(diameterOf(layout.stones[i][2]), MAX_D));
    });
    assert.equal(capped, layout.stones.filter((s) => diameterOf(s[2]) > MAX_D).length);
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
