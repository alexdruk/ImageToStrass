// The concept engine (src/engine/, exp-engine): face regions, the map, the placement rules and the
// checks of the design concept (section 8, 1-4), on the fake design (src/pipeline/fake/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { runChecks, checkGapsOf, checkHoles } from "../src/engine/checks.js";
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
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 1.5 * (ch.d + 0.15) + 1e-9, "no break inside a chain");
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
