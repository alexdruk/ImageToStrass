import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { CLOSE_MM, fillHoles, findHoles, lightnessOnWhite, neighbourVote, snapColour, squaredEdt, subjectMask } from "../src/pipeline/holes.js";
import { checkGaps, toStoneLayout } from "../src/pipeline/tiers.js";
import { loadConfig } from "../src/server/config.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";

// Hole fill (spec 7.5, docs/exp-holes.md): the distance transform, the subject mask, the hole search
// and fill on a synthetic AI image, the neighbour step, the colour snapping against the strass
// service's own answers, cleanedLayout without the AI image, the setting; and black & white read
// from the AI image (7.6).

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
const rgbOf = (id) => [1, 3, 5].map((i) => parseInt(STONE_COLORS[id].fill.slice(i, i + 2), 16));

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

test("holes: cleanedLayout without the AI image fills nothing; a report without the frame neither", () => {
  const layout = JSON.parse(readFileSync(new URL("./fixtures/layouts/woman.json", import.meta.url), "utf8"));
  const plain = cleanedLayout(layout);
  assert.equal(plain.filled, 0);
  const again = cleanedLayout(layout, {});
  assert.deepEqual(again.stoneLayout.toJSON(), plain.stoneLayout.toJSON());
  const frameless = { ...layout, report: { ...layout.report, mmPerPx: undefined } };
  assert.equal(cleanedLayout(frameless, { fillHolesIn: image(10, 4) }).filled, 0);
});

test("holes: a filled stone takes its neighbours' colour, not the pixels under it", () => {
  const size = 400, R = 180;
  const holed = hexStones(size, R, (x, y) => Math.hypot(x - 20, y - 20) < 1);
  const centre = (r) => r.added.find((st) => Math.hypot(st.x - 20, st.y - 20) < 1);
  // The AI painted Amethyst; the stones around the hole are Fuchsia.
  const purple = holed.map((st) => ({ ...st, color: "fuchsia" }));
  assert.equal(centre(fillHoles(purple, image(size, R, rgbOf("amethyst")), report, { colours: "pixels" })).color, "amethyst");
  assert.equal(centre(fillHoles(purple, image(size, R, rgbOf("amethyst")), report)).color, "fuchsia");
  // The dark spot: dark gap paint under the hole, Crystal all around -> Crystal.
  const light = holed.map((st) => ({ ...st, color: "crystal-clear" }));
  assert.equal(centre(fillHoles(light, image(size, R, rgbOf("jet")), report, { colours: "pixels" })).color, "jet");
  assert.equal(centre(fillHoles(light, image(size, R, rgbOf("jet")), report)).color, "crystal-clear");
});

test("holes: the neighbour vote weighs nearer stones more, breaks ties by the nearest, and chains", () => {
  // Target 0 (SS6 at the origin). Blue 0.2 mm away weighs 0.8; two reds 0.6 mm away 0.4 each:
  // a tie, which the nearest (blue) wins. A third red 0.9 mm away (0.1) tips it to red.
  const at = (x, color, d = 2) => ({ x, y: 0, d, color });
  const ring = (gap, angle, color) => ({ x: (2 + gap) * Math.cos(angle), y: (2 + gap) * Math.sin(angle), d: 2, color });
  const base = [at(0, null), ring(0.2, 0, "blue"), ring(0.6, 2, "red"), ring(0.6, 4, "red")];
  assert.equal(neighbourVote(base, new Set([0]), (st) => st.color).get(0), "blue");
  assert.equal(neighbourVote([...base, ring(0.9, 3, "red")], new Set([0]), (st) => st.color).get(0), "red");
  // Stones beyond 1 mm do not vote.
  assert.equal(neighbourVote([at(0, null), ring(0.5, 0, "blue"), ring(1.2, 2, "red"), ring(1.2, 3, "red")], new Set([0]), (st) => st.color).get(0), "blue");
  // A target with no decided stone within reach takes its colour from a target decided first.
  const chain = [at(0, null), at(2.2, null), at(4.4, "green")];
  const voted = neighbourVote(chain, new Set([0, 1]), (st) => st.color);
  assert.deepEqual([voted.get(1), voted.get(0)], ["green", "green"]);
});

test("holes: in black & white the voted stones take Jet or Crystal from their neighbours", () => {
  // A white image with a dark spot under the middle stone of three in a row.
  const size = 200;
  const ai = image(size, 1000, [250, 250, 250]);
  for (let y = 40; y < 60; y++) for (let x = 90; x < 110; x++) ai.data.set([0, 0, 0, 255], (y * size + x) * 4);
  const { stoneLayout, originMm } = toStoneLayout([
    { x: 7.8, y: 5, d: 2, color: "jet" }, { x: 10, y: 5, d: 1.5, color: "jet" }, { x: 12.2, y: 5, d: 2, color: "jet" }
  ], 1);
  const frame = { mmPerPx: S, offsetMm: [0, 0], originMm };
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, frame).stones.map((st) => st.color), ["crystal-clear", "jet", "crystal-clear"]);
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, frame, 55, [1]).stones.map((st) => st.color), ["crystal-clear", "crystal-clear", "crystal-clear"]);
});

test("holes: with serviceFillNeighbours the service's fill stones (report.fillAtMm) take their neighbours' colour", () => {
  const layout = JSON.parse(readFileSync(new URL("./fixtures/layouts/woman.json", import.meta.url), "utf8"));
  const [x, y, , colour] = layout.stones[100];
  // Give that stone a colour none of its neighbours has and call it a service fill stone.
  const other = colour === "siam" ? "emerald" : "siam";
  const marked = { ...layout, stones: layout.stones.map((st, i) => (i === 100 ? [st[0], st[1], st[2], other] : st)), report: { ...layout.report, fillAtMm: [[x, y]] } };
  const off = cleanedLayout(marked);
  const on = cleanedLayout(marked, { serviceFillNeighbours: true });
  assert.equal(off.serviceVoted, 0);
  assert.equal(on.serviceVoted, 1);
  // The cleanup removes nothing from this layout, so the stone keeps its index.
  assert.deepEqual(on.voted, [100]);
  assert.equal(off.stoneLayout.stones[100].color, other);
  assert.notEqual(on.stoneLayout.stones[100].color, other);
});

test("holes: the fill is on unless IS_FILL_HOLES=0; the service fill vote is off unless asked for", () => {
  assert.equal(loadConfig({}).fillHoles, true);
  assert.equal(loadConfig({ IS_FILL_HOLES: "1" }).fillHoles, true);
  assert.equal(loadConfig({ IS_FILL_HOLES: "0" }).fillHoles, false);
  assert.equal(loadConfig({}).serviceFillNeighbours, false);
  assert.equal(loadConfig({ IS_SERVICE_FILL_NEIGHBOURS: "1" }).serviceFillNeighbours, true);
  assert.equal(loadConfig({}).bwThreshold, 55);
  assert.equal(loadConfig({ BW_THRESHOLD: "45" }).bwThreshold, 45);
  assert.equal(loadConfig({}).bwGap, "nearest");
  for (const g of ["nearest", "crystal", "white", "black"]) assert.equal(loadConfig({ BW_GAP: g }).bwGap, g);
  assert.equal(loadConfig({ BW_GAP: "grey" }).bwGap, "nearest");
  assert.equal(loadConfig({}).bwStyle, "halftone");
  assert.equal(loadConfig({ BW_STYLE: "stencil" }).bwStyle, "stencil");
  assert.equal(loadConfig({ BW_STYLE: "dots" }).bwStyle, "halftone");
  assert.equal(loadConfig({}).bwFromDiscs, false);
  assert.equal(loadConfig({ IS_BW_FROM_DISCS: "1" }).bwFromDiscs, true);
});

test("black & white: with fromDiscs a stone takes the colour of the AI stone disc it overlaps most", () => {
  // Dark gap paint with a white disc (r 1 mm) at (7.2, 5); a dark disc at (3.8, 5) in the same paint.
  // report.discsAtMm holds both discs.
  const size = 200;
  const ai = image(size, 1000, [20, 20, 20]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (Math.hypot(x - 72, y - 50) <= 10) ai.data.set([250, 250, 250, 255], (y * size + x) * 4);
  }
  const discsAtMm = [[3.8, 5, 2], [7.2, 5, 2]];
  // Stone 0 on the dark disc; stone 1 moved 1.1 mm left off the white disc, its inner 60 % mostly on
  // the paint; stone 2 on the paint away from every disc; stone 3 between the discs, overlapping the
  // white one more (its inner 60 % all paint).
  const { stoneLayout, originMm } = toStoneLayout([
    { x: 3.8, y: 5, d: 2, color: "jet" }, { x: 6.1, y: 5, d: 1.5, color: "jet" }, { x: 6, y: 12, d: 2, color: "jet" }, { x: 5.6, y: 5, d: 2, color: "jet" }
  ], 1);
  const frame = { mmPerPx: S, offsetMm: [0, 0], originMm, discsAtMm };
  const colours = (opts) => mapBlackAndWhiteFromImage(stoneLayout, ai, frame, 55, [], opts).stones.map((st) => st.color);
  assert.deepEqual(colours(), ["jet", "jet", "jet", "jet"]);
  assert.deepEqual(colours({ fromDiscs: true }), ["jet", "crystal-clear", "jet", "crystal-clear"]);
  // No discs in the report (layouts before exp-holes B&W): read as before.
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, { ...frame, discsAtMm: undefined }, 55, [], { fromDiscs: true }).stones.map((st) => st.color), colours());
});

test("black & white: each stone's lightness is read from the AI image composited on white", () => {
  // Left half dark grey (L* about 21), right half transparent (white on white); a 50 % alpha black
  // column composites to mid grey (L* 53.6).
  const size = 200;
  const ai = image(size, 1000, [50, 50, 50]);
  for (let y = 0; y < size; y++) {
    for (let x = 100; x < size; x++) ai.data[(y * size + x) * 4 + 3] = 0;
    for (let x = 140; x < 160; x++) ai.data.set([0, 0, 0, 128], (y * size + x) * 4);
  }
  assert.ok(Math.abs(lightnessOnWhite(ai, 50, 50, 2, S) - 21) < 1);
  assert.ok(lightnessOnWhite(ai, 120, 50, 2, S) > 99);
  const mid = lightnessOnWhite(ai, 150, 50, 1.5, S);
  assert.ok(mid > 50 && mid < 58, String(mid));
  const { stoneLayout, originMm } = toStoneLayout([
    { x: 5, y: 5, d: 2, color: "crystal-clear" }, { x: 12, y: 5, d: 2, color: "jet" }, { x: 15, y: 5, d: 1.5, color: "jet" }
  ], 1);
  const frame = { mmPerPx: S, offsetMm: [0, 0], originMm };
  // The mid grey (L* 53.6) is Jet at the default 55 and Crystal at 50.
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, frame).stones.map((st) => st.color), ["jet", "crystal-clear", "jet"]);
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, frame, 50).stones.map((st) => st.color), ["jet", "crystal-clear", "crystal-clear"]);
  // Positions and sizes are unchanged.
  assert.deepEqual(mapBlackAndWhiteFromImage(stoneLayout, ai, frame).stones.map((st) => [st.xMm, st.yMm, st.sizeMm]), stoneLayout.stones.map((st) => [st.xMm, st.yMm, st.sizeMm]));
});
