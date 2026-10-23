import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { CLOSE_MM, fillHoles, findHoles, snapColour, squaredEdt, subjectMask } from "../src/pipeline/holes.js";
import { checkGaps, toStoneLayout } from "../src/pipeline/tiers.js";

// Hole fill (experiment exp-holes, docs/exp-holes.md; off in production): the distance transform,
// the subject mask, the hole search and fill on a synthetic AI image, the colour snapping against
// the strass service's own answers, and cleanedLayout unchanged without the AI image.

// A synthetic AI image: opaque inside a disc of radius R px around the centre, one flat colour,
// mmPerPx 0.1. Stones on a hexagonal grid of pitch 2.2 mm (SS6, gap 0.2 mm) inside the disc.
const S = 0.1;
function image(size, radiusPx, rgb = [20, 20, 20], holesPx = []) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const on = Math.hypot(x - size / 2, y - size / 2) <= radiusPx && !holesPx.some(([hx, hy, hr]) => Math.hypot(x - hx, y - hy) <= hr);
      data.set(on ? [...rgb, 255] : [0, 0, 0, 0], p);
    }
  }
  return { data, width: size, height: size };
}
function hexStones(size, radiusPx, skip = () => false) {
  const out = [];
  const pitch = 2.2;
  const c = size / 2 * S, R = radiusPx * S;
  for (let row = -40; row <= 40; row++) {
    for (let col = -40; col <= 40; col++) {
      const x = c + (col + (row % 2) / 2) * pitch, y = c + row * pitch * Math.sqrt(3) / 2;
      if (Math.hypot(x - c, y - c) > R - 1.2 || skip(x, y)) continue;
      out.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, d: 2, color: "jet" });
    }
  }
  return out;
}
const report = { mmPerPx: S, offsetMm: [0, 0] };

test("holes: squaredEdt is the exact squared distance", () => {
  const w = 17, h = 11;
  const f = new Uint8Array(w * h);
  [[0, 0], [16, 10], [8, 5], [3, 9]].forEach(([x, y]) => { f[y * w + x] = 1; });
  const d = squaredEdt(f, w, h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i - x) / w;
    const want = Math.min(...[[0, 0], [16, 10], [8, 5], [3, 9]].map(([a, b]) => (a - x) ** 2 + (b - y) ** 2));
    assert.equal(d[i], want);
  }
  assert.equal(squaredEdt(new Uint8Array(4), 2, 2)[0], Infinity);
});

test("holes: the subject closes gaps narrower than CLOSE_MM and small enclosed holes, not the outside", () => {
  // A 0.6 mm wide transparent slit through the middle and a 1 mm transparent dot are closed; a
  // 6 mm transparent disc (area above two SS6 stones) stays open, and so does the outside.
  const size = 400;
  const ai = image(size, 180, [20, 20, 20], [[100, 200, 5], [300, 200, 30]]);
  for (let y = 0; y < size; y++) for (let x = 197; x < 203; x++) ai.data[(y * size + x) * 4 + 3] = 0;
  const m = subjectMask(ai, S);
  assert.equal(CLOSE_MM, 1);
  assert.equal(m[200 * size + 200], 1, "slit closed");
  assert.equal(m[200 * size + 100], 1, "small dot filled");
  assert.equal(m[200 * size + 300], 0, "large enclosed hole kept open");
  assert.equal(m[5 * size + 5], 0, "outside");
});

test("holes: a full grid has none; removed stones become SS6 holes, filled with the 0.1 mm gap kept", () => {
  const size = 400, R = 180;
  const ai = image(size, R);
  const full = hexStones(size, R);
  const none = findHoles(full, ai, report);
  assert.equal(none.ss6, 0);
  // Remove the stones within 3 mm of (20, 20) mm: a hole of several SS6 stones.
  const holed = hexStones(size, R, (x, y) => Math.hypot(x - 20, y - 20) < 3);
  const found = findHoles(holed, ai, report);
  assert.ok(found.ss6 >= full.length - holed.length - 1, `ss6 ${found.ss6} for ${full.length - holed.length} removed`);
  // The grid leaves SS4-sized spots at the disc's rim; the SS6 holes are where stones were removed.
  assert.ok(found.holes.filter((h) => h.sizeId === "ss6").every((h) => Math.hypot(h.x - 20, h.y - 20) < 5), "SS6 holes only where stones were removed");
  assert.equal(found.ss4 - none.ss4 <= 3, true);
  assert.ok(found.largestEmptyMm > 4);
  const { stones, added } = fillHoles(holed, ai, report);
  assert.equal(added.length, found.holes.length);
  assert.ok(added.every((s) => s.color === "jet"), "colour read from the image");
  const { stones: placed } = toStoneLayout(stones, 1);
  const gaps = checkGaps(placed);
  assert.ok(gaps.ok, JSON.stringify(gaps));
  assert.ok(gaps.minGapMm >= 0.1 - 1e-9);
  assert.equal(findHoles(stones, ai, report).holes.length, 0, "nothing left to fill");
});

test("holes: nothing is placed outside the subject or where only SS4 fits partly outside it", () => {
  const size = 400, R = 180;
  const ai = image(size, R);
  const stones = hexStones(size, R);
  const found = findHoles(stones, ai, report);
  for (const h of found.holes) assert.ok(Math.hypot(h.x - 20, h.y - 20) + h.d / 2 <= R * S + 0.1, `hole at ${h.x}, ${h.y} reaches outside`);
});

test("holes: colours snap as the strass service snaps them", () => {
  // Lab colours and the ids snap_colours (palette PLUS_REAL_SKIN) gave them.
  const cases = [
    ["jet", [0, 0, 0]], ["colorado-topaz", [48.54, 25.11, 35.88]], ["smoked-topaz", [23.65, 20.91, 25.86]],
    ["rose-gold", [65.5, 21.78, 33.34]], ["copper", [53.19, 24.14, 34.45]], ["silk", [70.51, 20.35, 31.61]],
    ["citrus-green", [86.16, -35.33, 84.08]], ["capri-blue", [43.66, -6.63, -29.47]], ["emerald", [31.91, -24.28, 24.8]],
    ["fern-green", [47.01, -25.74, 41.28]], ["hematite", [23.84, -5.53, -13.65]], ["olivine", [51.73, -7.76, 51.62]]
  ];
  for (const [id, lab] of cases) assert.equal(snapColour(lab), id, JSON.stringify(lab));
});

test("holes: cleanedLayout without the AI image is unchanged and fills nothing", () => {
  const layout = JSON.parse(readFileSync(new URL("./fixtures/layouts/woman.json", import.meta.url), "utf8"));
  const plain = cleanedLayout(layout);
  assert.equal(plain.filled, 0);
  const again = cleanedLayout(layout, {});
  assert.deepEqual(again.stoneLayout.toJSON(), plain.stoneLayout.toJSON());
});
