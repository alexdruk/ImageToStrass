import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { cleanedLayout, removeCloseStones } from "../src/pipeline/cleanup.js";
import { acceptLayout } from "../src/pipeline/design.js";
import { naturalLayout } from "../src/pipeline/tiers.js";

// Overlap cleanup after the SS16 cap (spec section 7.5) and the acceptance that uses it (7.4): the
// rules on small fixtures, then the rejected IS-03b car (its saved strass /layout answer, no
// provider call), the 8 accepted IS-03b designs and the 12 RS test layouts.

const read = (dir) => {
  const url = new URL(`./fixtures/${dir}/`, import.meta.url);
  return readdirSync(url).filter((f) => f.endsWith(".json")).sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), layout: JSON.parse(readFileSync(new URL(f, url), "utf8")) }));
};
const plain = (x, y, d, color = "jet") => ({ x, y, d, color });

test("cleanup: of a pair closer than 0.1 mm the smaller stone goes", () => {
  // SS6 at 0 and SS4 1.8 mm away: rim gap 0.05 mm.
  const { stones, removed } = removeCloseStones([plain(0, 0, 2), plain(1.8, 0, 1.5), plain(10, 0, 2)]);
  assert.deepEqual(removed, [1]);
  assert.deepEqual(stones.map((s) => s.x), [0, 10]);
  // A gap of exactly 0.1 mm stays.
  assert.deepEqual(removeCloseStones([plain(0, 0, 2), plain(2.1, 0, 2)]).removed, []);
});

test("cleanup: on equal size the stone with fewer neighbours goes, then the later one", () => {
  // A (index 0) has a neighbour 0.3 mm away on its left; B (index 1) none. A and B overlap.
  const withNeighbour = [plain(10, 0, 2), plain(11.9, 0, 2), plain(7.7, 0, 2)];
  assert.deepEqual(removeCloseStones(withNeighbour).removed, [1]);
  // Mirrored: now the later stone has the neighbour, so the earlier one goes.
  const mirrored = [plain(10, 0, 2), plain(11.9, 0, 2), plain(14.2, 0, 2)];
  assert.deepEqual(removeCloseStones(mirrored).removed, [0]);
  // No neighbour on either side: the later one goes.
  assert.deepEqual(removeCloseStones([plain(10, 0, 2), plain(11.9, 0, 2)]).removed, [1]);
});

test("cleanup: worst gap first; a pair already resolved is skipped; nothing below 0.1 mm is left", () => {
  // Three SS6 in a row 1.9 mm apart: pairs (0,1) and (1,2) both at -0.1 mm. Neighbours, counted
  // once before any removal: 0 and 2 have one each, 1 has two. So each pair removes its outer
  // stone and the middle one stays.
  const row = [plain(0, 0, 2), plain(1.9, 0, 2), plain(3.8, 0, 2)];
  const { stones, removed } = removeCloseStones(row);
  assert.deepEqual(removed, [0, 2]);
  assert.deepEqual(stones.map((s) => s.x), [1.9]);
  // A random dense cloud ends with no pair below 0.1 mm.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cloud = Array.from({ length: 600 }, () => plain(rnd() * 40, rnd() * 40, rnd() < 0.3 ? 1.5 : 2));
  const cleaned = cleanedLayout({ stones: cloud.map((s) => [s.x, s.y, s.d === 2 ? "ss6" : "ss4", "jet"]), report: { coverage: 0.7 } });
  assert.ok(cleaned.removed > 0);
  assert.equal(cleaned.gaps.ok, true, JSON.stringify(cleaned.gaps));
});

test("cleanup runs after the SS16 cap: two SS30 stones that only overlap before the cap both stay", () => {
  const c = cleanedLayout({ stones: [[0, 0, "ss30", "jet"], [6, 0, "ss30", "jet"]], report: { coverage: 0.9 } });
  assert.deepEqual([c.capped, c.removed], [2, 0]);
  // The cap shrinks the stones, so the coverage drops with their area: (2 / 3.2)^2 of it.
  assert.ok(Math.abs(c.coverage - 0.9 * (2 / 3.2) ** 2) < 0.01, String(c.coverage));
});

test("cleanup: the footprint box of the kept stones starts at the origin", () => {
  const c = cleanedLayout({ stones: [[10, 10, "ss4", "jet"], [10.5, 10, "ss6", "jet"], [14, 10, "ss6", "jet"]], report: { coverage: 0.8 } });
  assert.equal(c.removed, 1);
  const box = c.stoneLayout.getBoundingBox();
  assert.ok(Math.abs(box.minXmm) < 1e-9 && Math.abs(box.minYmm) < 1e-9);
  assert.ok(Math.abs(c.stoneLayout.widthMm - 5.5) < 1e-9);
});

test("the rejected IS-03b car: 79 of 3716 stones removed, coverage 0.633 -> 0.624, accepted", () => {
  const [{ layout }] = read("is03b-rejected");
  assert.equal(layout.report.violations, 148);
  const natural = naturalLayout(layout);
  assert.equal(natural.gaps.belowMinGap, 145, "after the cap, before the cleanup");
  const c = cleanedLayout(layout);
  assert.deepEqual([c.capped, c.removed, c.stoneLayout.count], [15, 79, 3637]);
  assert.equal(c.gaps.ok, true);
  assert.equal(Math.round(c.coverage * 1000) / 1000, 0.624);
  const check = acceptLayout(c);
  assert.deepEqual([check.ok, check.violations, check.coverage], [true, 0, 0.624]);
  assert.ok(check.removedShare < 0.03);
});

for (const [dir, n] of [["is03b", 8], ["layouts", 12]]) {
  test(`the ${n} ${dir === "is03b" ? "accepted IS-03b designs" : "RS test layouts"}: the cleanup removes nothing, all accepted`, () => {
    const all = read(dir);
    assert.equal(all.length, n);
    for (const { name, layout } of all) {
      const c = cleanedLayout(layout);
      assert.equal(c.removed, 0, name);
      assert.deepEqual(c.stoneLayout.stones.map((s) => [s.xMm, s.yMm, s.sizeMm]), naturalLayout(layout).stoneLayout.stones.map((s) => [s.xMm, s.yMm, s.sizeMm]), name);
      assert.equal(acceptLayout(c).ok, true, name);
    }
  });
}
