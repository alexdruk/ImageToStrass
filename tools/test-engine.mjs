// The concept engine (src/engine/, exp-engine): face regions, the map, the placement rules and the
// checks of the design concept (section 8, 1-4), on the fake design (src/pipeline/fake/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { HIST_BINS, runChecks, checkGapsOf, checkHoles, holeHistogram } from "../src/engine/checks.js";
import { RAMPS, rampOf } from "../src/engine/map.js";
import { ditherJet } from "../src/engine/place.js";
import { faceRegions, inRegion } from "../src/engine/faces.js";
import { engineLayout, mapPicture, mapToJSON, todaysDesign } from "../src/engine/index.js";
import { MAX_TONES } from "../src/engine/map.js";
import { loadConfig } from "../src/server/config.js";

const LAYOUT = JSON.parse(readFileSync(new URL("../src/pipeline/fake/layout.json", import.meta.url), "utf8"));
const AI = await sharp(new URL("../src/pipeline/fake/ai.png", import.meta.url).pathname).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => ({ data, width: info.width, height: info.height }));

const centre = (() => {
  const xs = LAYOUT.stones.map((s) => s[0]), ys = LAYOUT.stones.map((s) => s[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
})();
// The fake layout with a human face: two pupils 20 mm apart around its centre.
const FACE = { ...LAYOUT, report: { ...LAYOUT.report, face: "human", pupilsAtMm: [[centre[0] - 10, centre[1] - 8], [centre[0] + 10, centre[1] - 8]] } };

test("engine: IS_ENGINE=concept selects the engine; the default is today's pipeline", () => {
  assert.equal(loadConfig({}).engine, "today");
  assert.equal(loadConfig({ IS_ENGINE: "concept" }).engine, "concept");
  assert.equal(loadConfig({ IS_ENGINE: "yes" }).engine, "today");
});

test("engine: face regions come from the two pupils (eyes; a mouth for people only)", () => {
  assert.deepEqual(faceRegions(LAYOUT.report), []);
  const human = faceRegions(FACE.report);
  assert.deepEqual(human.map((r) => r.kind), ["eye", "eye", "mouth"]);
  assert.ok(inRegion(human[0], centre[0] - 10, centre[1] - 8));
  assert.ok(inRegion(human[2], centre[0], centre[1] - 8 + 22), "the mouth lies about 1.1 pupil distances below the eyes");
  assert.ok(!inRegion(human[2], centre[0], centre[1] - 8));
  assert.deepEqual(faceRegions({ ...FACE.report, face: "animal" }).map((r) => r.kind), ["eye", "eye"]);
  assert.deepEqual(faceRegions({ ...FACE.report, pupilsAtMm: [[0, 0]] }), []);
});

for (const [mode, style] of [["colour", null], ["bw", "stencil"], ["bw", "halftone"]]) {
  test(`engine (${mode}${style ? ` ${style}` : ""}): the rules hold by construction`, () => {
    const today = todaysDesign(FACE, AI, { mode });
    const engine = engineLayout(FACE, AI, { mode, style: style || "halftone", today: today.stones });
    assert.ok(engine.stones.length > 300);
    assert.equal(engine.gaps.ok, true, "no stone closer than 0.1 mm to another");
    if (mode === "bw") assert.ok(engine.stones.every((s) => s.color === "jet" || s.color === "crystal-clear"), "Jet and Crystal only");
    // Features: today's stones in the face regions, unchanged.
    const kept = today.stones.filter((s) => engine.map.regions.some((r) => inRegion(r, s.x, s.y)));
    const features = engine.stones.filter((s) => s.role === "feature");
    assert.deepEqual(features.map(({ x, y, d, color }) => ({ x, y, d, color })), kept);
    // Chains: one colour and size each, at least 3 stones, evenly spaced.
    for (const ch of engine.chains) {
      assert.ok(ch.stones.length >= 3);
      for (const i of ch.stones) assert.equal(engine.stones[i].color, ch.colour);
      for (const i of ch.stones) assert.equal(engine.stones[i].d, ch.d);
      for (let k = 1; k < ch.stones.length; k++) {
        const a = engine.stones[ch.stones[k - 1]], b = engine.stones[ch.stones[k]];
        const gap = Math.hypot(a.x - b.x, a.y - b.y);
        // A longer gap only where another chain crosses (its stone between the two).
        const crossing = engine.stones.some((s) => s.chain != null && s.chain !== ch.id && Math.hypot(s.x - (a.x + b.x) / 2, s.y - (a.y + b.y) / 2) < gap / 2);
        assert.ok(gap <= 1.5 * (ch.d + 0.15) + 1e-9 || crossing, "no break inside a chain");
      }
    }
    assert.ok(engine.chains.some((c) => c.kind === "outline"), "the subject has an outline chain");
    // Areas: at most 3 tones each.
    for (const a of engine.map.areas) assert.ok(a.tones.length <= MAX_TONES);
    // The design is at the layout's natural size: within a stone of today's.
    assert.ok(Math.abs(engine.stoneLayout.widthMm - today.stoneLayout.widthMm) < 2.5);
    assert.ok(Math.abs(engine.stoneLayout.heightMm - today.stoneLayout.heightMm) < 2.5);
    // The checks run on both designs.
    const checks = runChecks(engine.stones, engine.map, { chains: engine.chains });
    assert.equal(checks.gaps.violations, 0);
    assert.equal(checks.lines.chains.pass, true);
    assert.equal(checks.areas.overTones, 0);
    if (mode === "colour" || style === "stencil") assert.equal(checks.areas.smallPatches, 0);
    assert.equal(runChecks(today.stones, engine.map).gaps.violations, 0);
  });
}

test("engine: the map is saved as JSON and as a picture", async () => {
  const engine = engineLayout(LAYOUT, AI, { mode: "colour", today: [] });
  const json = mapToJSON(engine.map);
  assert.equal(json.version, 1);
  assert.ok(json.subject.outline.length >= 1);
  assert.ok(json.areas.length >= 1 && json.areas.every((a) => a.tones.length >= 1 && a.tones.length <= 3 && Array.isArray(a.shape)));
  assert.ok(Array.isArray(json.lines));
  const meta = await sharp(mapPicture(engine.map)).metadata();
  assert.equal(meta.format, "png");
});

test("checks: gaps, holes and lines are measured as the concept states them", () => {
  // Two stones 0.05 mm apart rim to rim: one violation.
  assert.deepEqual(checkGapsOf([{ x: 0, y: 0, d: 2 }, { x: 2.05, y: 0, d: 2 }]), { violations: 1, minGapMm: 0.05, pass: false });
  assert.equal(checkGapsOf([{ x: 0, y: 0, d: 2 }, { x: 2.1, y: 0, d: 2 }]).pass, true);
  const engine = engineLayout(LAYOUT, AI, { mode: "colour", today: [] });
  // Taking stones out of the middle of the subject opens a hole.
  const { map } = engine;
  const before = checkHoles(engine.stones, map);
  const k = engine.stones.findIndex((s) => s.role === "area" && map.subjectDist[map.grid.at(s.x, s.y)] > 6);
  const gone = engine.stones.filter((s) => Math.hypot(s.x - engine.stones[k].x, s.y - engine.stones[k].y) > 2.5);
  const after = checkHoles(gone, map);
  assert.ok(after.largestMm > 2 && after.holes >= 1 && after.largestMm > before.largestMm);
  // A stone of another colour on a line is counted.
  if (map.lines.length) {
    const ch = engine.chains.find((c) => c.kind === "line");
    const stones = engine.stones.map((s) => ({ ...s }));
    stones[ch.stones[1]].color = ch.colour === "jet" ? "crystal-clear" : "jet";
    assert.ok(runChecks(stones, map).lines.offColour >= 1);
  }
});

test("engine: the outline colour is the darkest of the area's ramp", () => {
  // Light skin (build 1 took Indian Siam, a lip red, for it).
  const skin = rampOf(["light-peach", "rose-gold", "colorado-topaz"]);
  assert.equal(skin.id, "skin");
  assert.equal(skin.colours[skin.colours.length - 1], "smoked-topaz");
  assert.equal(rampOf(["light-sapphire", "capri-blue"]).id, "blue");
  assert.equal(rampOf(["silver", "grey"]).id, "grey");
  for (const r of RAMPS) assert.ok(r.colours.length >= 2);
});

test("engine: an eye region is centred on the eye opening, not on a pupil looking aside", () => {
  const report = { face: "human", pupilsAtMm: [[20, 20], [40, 20]], pupilsMm: [4, 4] };
  const white = (x, y) => ({ x, y, d: 2, lab: [92, 0, 0] });
  // Both eyes look to the right: their whites lie left of the pupils.
  const discs = [white(15.5, 20), white(13.5, 20), white(35.5, 20), white(33.5, 20)];
  const [a, b] = faceRegions(report, discs);
  assert.ok(a.x < 20 && b.x < 40, "moved towards the whites");
  assert.deepEqual(a.pupil, [20, 20]);
  assert.ok(inRegion(a, 20, 20) && inRegion(a, 13.5, 20));
  assert.ok(a.ax < 0.42 * 20, "a narrow eye gets a narrower region");
  // Without whites the region stays on the pupil.
  assert.equal(faceRegions(report)[0].x, 20);
});

test("engine: the halftone pattern is a regular dither of the honeycomb's lattice", () => {
  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    let jet = 0;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if (ditherJet(i, j, share)) jet++;
    assert.equal(jet, share * 64);
    // The same 4 x 4 tile repeats.
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) assert.equal(ditherJet(i, j, share), ditherJet(i + 4, j - 8, share));
  }
});

test("engine: band, honeycomb and the hole histogram", () => {
  const engine = engineLayout(LAYOUT, AI, { mode: "colour", today: [] });
  assert.ok(engine.stones.some((s) => s.role === "hex"), "a honeycomb inside the band");
  assert.ok(engine.stones.some((s) => s.role === "area"), "a band along the outline");
  const all = engineLayout(LAYOUT, AI, { mode: "colour", today: [], bandRows: "all" });
  assert.ok(!all.stones.some((s) => s.role === "hex"), "build 1: rows all the way in");
  const hist = holeHistogram(engine.stones, engine.map);
  assert.equal(hist.length, HIST_BINS.length);
  const holes = checkHoles(engine.stones, engine.map).holes;
  assert.ok(hist[2] + hist[3] + hist[4] >= holes, "every hole of check 4 holds at least one gap of 1.0 mm or more");
});
