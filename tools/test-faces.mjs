import assert from "node:assert/strict";
import { test } from "node:test";
import { lightness } from "../src/pipeline/bw.js";
import { EYE_BAND_MM, MESH, designFaceFeatures, faceRegions, finishFaceFeatures, insidePolygon } from "../src/pipeline/faces.js";
import { srgbToLab } from "../src/pipeline/holes.js";
import { checkGaps } from "../src/pipeline/tiers.js";
import { Stone } from "../src/stones/Stone.js";
import { STONE_COLORS } from "../src/stones/StoneColors.js";

// exp-faces (src/pipeline/faces.js) on a synthetic face: two eyes 20 mm apart (openings 10 x 4.4
// mm, iris radius 2.6 mm) and a mouth 12 mm wide (big: 18 mm, lips about 5 mm high), closed or
// open, on a lattice of SS6 skin stones.

function face({ open = false, big = open } = {}) {
  const points = Array.from({ length: 478 }, () => [0, 0]);
  const eye = (e, cx, cy) => {
    e.contour.forEach((id, k) => {
      const t = Math.PI + (k * Math.PI) / 8;
      points[id] = [cx + 5 * Math.cos(t), cy - 2.2 * Math.sin(t)];
    });
    points[e.iris] = [cx, cy];
    e.rim.forEach((id, k) => { points[id] = [cx + 2.6 * Math.cos((k * Math.PI) / 2), cy + 2.6 * Math.sin((k * Math.PI) / 2)]; });
  };
  eye(MESH.eyes[0], 20, 20);
  eye(MESH.eyes[1], 40, 20);
  const step = big ? 1.8 : 1.2, k0 = 30 - 5 * step;
  const chain = (ids, h) => ids.forEach((id, k) => { points[id] = [k0 + step * k, 42 - h * Math.sin((Math.PI * k) / 10)]; });
  chain(MESH.upperOuter, big ? 5.5 : 3);
  chain(MESH.lowerOuter, big ? -6 : -3.2);
  chain(MESH.upperInner, open ? 2.6 : 0.25);
  chain(MESH.lowerInner, open ? -2.6 : -0.25);
  return points;
}

function skin() {
  const stones = [];
  const p = 2.1, h = p * Math.sqrt(3) / 2;
  for (let j = 0; j * h < 60; j++) for (let i = 0; i * p < 60; i++) stones.push({ x: i * p + (j & 1) * p / 2, y: j * h, d: 2, color: "light-peach" });
  return stones;
}

const LIPS_LAB = srgbToLab(170, 70, 80);
const ctx = (open) => ({
  photoLab: (x, y) => (y > 35 ? LIPS_LAB : srgbToLab(90, 60, 30)),
  // Teeth: the open mouth is light but for a dark band along its middle.
  aiLightness: (x, y) => (open && Math.abs(y - 42) > 0.6 ? 90 : 20),
  aiLabMean: () => [20, 10, 5]
});
const gapsOk = (stones) => checkGaps(stones.map((s) => new Stone({ xMm: s.x, yMm: s.y, sizeMm: s.d, color: s.color, layerId: "design" }))).ok;

test("faces: regions from the landmarks (eyes, irises, lips, open mouth)", () => {
  const closed = faceRegions(face());
  assert.equal(closed.eyes.length, 2);
  assert.ok(Math.abs(closed.eyes[0].widthMm - 10) < 1e-9);
  assert.ok(Math.abs(closed.eyes[0].iris.r - 2.6) < 1e-9);
  assert.equal(closed.eyeDistanceMm, 20);
  assert.equal(closed.lips.open, false);
  assert.equal(closed.lips.opening, null);
  assert.ok(insidePolygon([30, 39.5], closed.lips.upper) && insidePolygon([30, 44.5], closed.lips.lower));
  const open = faceRegions(face({ open: true }));
  assert.equal(open.lips.open, true);
  assert.ok(insidePolygon([30, 42], open.lips.opening));
});

test("faces E2: SS16 Jet pupil at the iris centre, SS4 Crystal catch-light at the upper right, Crystal white, gaps kept", () => {
  for (const style of ["colour", "stencil", "halftone"]) {
    const { stones, faces } = designFaceFeatures(skin(), [face()], { style, eyes: "E2", ...ctx(false) });
    assert.ok(gapsOk(stones), style);
    const pupil = stones.find((s) => s.designed && s.d === 4 && Math.hypot(s.x - 20, s.y - 20) < 1e-9);
    assert.equal(pupil?.color, "jet", style);
    const catchLight = stones.filter((s) => s.designed && s.d === 1.5 && s.color === "crystal-clear" && s.x > 20 && s.y < 20 && Math.abs(Math.hypot(s.x - 20, s.y - 20) - (2 + 0.1 + 0.75)) < 1e-9);
    assert.equal(catchLight.length, 1, style);
    const eye = faces[0].eyes[0];
    assert.ok(eye.ring > 0 && eye.lidStones > 0 && eye.white > 0, style);
    // The ring: the photo's iris colour in colour, Jet in black & white.
    assert.equal(eye.irisColour === "jet", style !== "colour", style);
    // Nothing undesigned is left in the opening.
    const opening = faceRegions(face()).eyes[0].opening;
    assert.equal(stones.filter((s) => !s.designed && insidePolygon([s.x, s.y], opening)).length, 0, style);
  }
});

test("faces E3: an SS6 Jet pupil cluster with an SS4 Crystal catch-light in its upper right place", () => {
  const { stones } = designFaceFeatures(skin(), [face()], { style: "colour", eyes: "E3", ...ctx(false) });
  assert.ok(gapsOk(stones));
  const near = stones.filter((s) => s.designed && Math.hypot(s.x - 20, s.y - 20) <= 1.6);
  assert.equal(near.filter((s) => s.d === 4).length, 0);
  assert.equal(near.filter((s) => s.d === 2 && s.color === "jet").length, 3);
  const light = near.filter((s) => s.d === 1.5 && s.color === "crystal-clear");
  assert.equal(light.length, 1);
  assert.ok(light[0].x > 20 && light[0].y < 20);
});

test("faces E1: the AI's stones kept, the pupil moved to the iris centre, stray colours cleaned", () => {
  // The AI's SS20 pupil 0.7 mm off the iris centre, its iris Sapphire.
  const pupil = { x: 20.6, y: 20.4, d: 4.7, color: "jet" };
  const stones = [pupil, ...skin()
    .filter((s) => Math.hypot(s.x - pupil.x, s.y - pupil.y) - (s.d + pupil.d) / 2 >= 0.1)
    .map((s) => (Math.hypot(s.x - 20, s.y - 20) < 2.6 ? { ...s, color: "sapphire" } : s))];
  // A stray colour inside the opening, in the white.
  const stray = stones.find((s) => Math.abs(s.x - 23.5) < 1.1 && Math.abs(s.y - 20) < 1.1 && s.d === 2);
  stray.color = "emerald";
  const { stones: out, faces } = designFaceFeatures(stones, [face()], { style: "colour", eyes: "E1", discs: [], readStone: () => null, ...ctx(false) });
  assert.ok(gapsOk(out));
  assert.ok(out.some((s) => s.d === 4.7 && s.color === "jet" && Math.hypot(s.x - 20, s.y - 20) < 1e-9));
  assert.ok(faces[0].eyes[0].pupilMovedMm > 0.5);
  assert.notEqual(out.find((s) => s.x === stray.x && s.y === stray.y)?.color, "emerald");
});

test("faces stencil: a Crystal band separates the eye from dark stones around it", () => {
  const points = face();
  const stones = skin().map((s) => ({ ...s, color: s.y < 17 ? "jet" : "crystal-clear" }));
  const { stones: designed } = designFaceFeatures(stones, [points], { style: "stencil", eyes: "E2", ...ctx(false) });
  const { stones: out, crystal } = finishFaceFeatures(designed, [points], { style: "stencil", eyes: "E2" });
  assert.ok(crystal > 0);
  const opening = faceRegions(points).eyes[0].opening;
  const dark = out.filter((s) => !s.designed && s.color === "jet" && s.x > 15 && s.x < 25);
  for (const s of dark) assert.ok(!insidePolygon([s.x, s.y], opening) && Math.min(...opening.map((p) => Math.hypot(p[0] - s.x, p[1] - s.y))) > EYE_BAND_MM - 0.5);
  // Other styles leave the stones as they are.
  assert.equal(finishFaceFeatures(designed, [points], { style: "halftone", eyes: "E2" }).crystal, 0);
});

test("faces lips: L1 one tone; L2 upper darker with a dark line (colour), outlined Crystal (stencil), a regular mix (halftone)", () => {
  const L = (id) => lightness(STONE_COLORS[id].fill);
  const one = designFaceFeatures(skin(), [face()], { style: "colour", lips: "L1", ...ctx(false) });
  assert.equal(one.faces[0].lips.colours.length, 1);
  assert.ok(gapsOk(one.stones));
  const two = designFaceFeatures(skin(), [face()], { style: "colour", lips: "L2", ...ctx(false) });
  const [upper, lower, line] = two.faces[0].lips.colours;
  assert.ok(L(upper) < L(lower) && L(line) < L(upper));
  assert.ok(two.faces[0].lips.line > 0 && gapsOk(two.stones));
  const stencil = designFaceFeatures(skin(), [face()], { style: "stencil", lips: "L2", ...ctx(false) });
  assert.ok(stencil.faces[0].lips.outline > 0 && gapsOk(stencil.stones));
  const lipStones = (r, inUpper) => r.stones.filter((s) => s.designed && s.d === 2 && insidePolygon([s.x, s.y], inUpper ? faceRegions(face()).lips.upper : faceRegions(face()).lips.lower));
  assert.ok(lipStones(stencil, true).every((s) => s.color === "crystal-clear"));
  assert.ok(designFaceFeatures(skin(), [face()], { style: "stencil", lips: "L1", ...ctx(false) }).stones.filter((s) => s.designed).every((s) => s.color === "jet"));
  const big = face({ big: true });
  const half = designFaceFeatures(skin(), [big], { style: "halftone", lips: "L2", ...ctx(false) });
  const share = (inUpper) => {
    const st = half.stones.filter((s) => s.designed && s.d === 2 && insidePolygon([s.x, s.y], inUpper ? faceRegions(big).lips.upper : faceRegions(big).lips.lower));
    return st.filter((s) => s.color === "jet").length / st.length;
  };
  assert.ok(share(true) > share(false));
  assert.ok(gapsOk(half.stones));
});

test("faces teeth: Crystal teeth in the open mouth, the line between the rows only with T2; closed mouths unchanged", () => {
  for (const style of ["colour", "stencil"]) {
    const t1 = designFaceFeatures(skin(), [face({ open: true })], { style, teeth: "T1", ...ctx(true) });
    const t2 = designFaceFeatures(skin(), [face({ open: true })], { style, teeth: "T2", ...ctx(true) });
    assert.ok(gapsOk(t1.stones) && gapsOk(t2.stones), style);
    assert.equal(t1.faces[0].teeth.line, 0);
    assert.ok(t2.faces[0].teeth.bothRows && t2.faces[0].teeth.line > 0, style);
    const lineColour = style === "colour" ? "silver" : "jet";
    assert.ok(t2.stones.some((s) => s.designed && s.d === 1.5 && s.color === lineColour && Math.abs(s.y - 42) < 0.3), style);
    assert.ok(t1.stones.some((s) => s.designed && s.color === "crystal-clear"), style);
  }
  const closed = designFaceFeatures(skin(), [face()], { style: "colour", teeth: "T2", ...ctx(false) });
  assert.equal(closed.faces[0].teeth.skipped, "mouth closed");
  assert.equal(closed.stones.filter((s) => s.designed).length, 0);
});

test("faces: the eye moves to the AI's pupil when the service found one near the landmark iris", () => {
  const near = designFaceFeatures(skin(), [face()], { style: "colour", eyes: "E2", pupils: [[21.5, 20.8]], ...ctx(false) });
  assert.ok(near.stones.some((s) => s.designed && s.d === 4 && s.x === 21.5 && s.y === 20.8));
  assert.equal(near.faces[0].eyes[0].pupilSnapMm, Math.round(Math.hypot(1.5, 0.8) * 100) / 100);
  assert.ok(gapsOk(near.stones));
  // Too far (beyond 1.5 iris radii): the landmark stays.
  const far = designFaceFeatures(skin(), [face()], { style: "colour", eyes: "E2", pupils: [[26, 20]], ...ctx(false) });
  assert.equal(far.faces[0].eyes[0].pupilSnapMm, null);
  assert.ok(far.stones.some((s) => s.designed && s.d === 4 && s.x === 20 && s.y === 20));
});

test("faces T2: no line when only one row of teeth shows (a smile)", () => {
  const smile = { ...ctx(true), aiLightness: (x, y) => (y < 42.5 ? 90 : 20) };
  const t2 = designFaceFeatures(skin(), [face({ open: true })], { style: "colour", teeth: "T2", ...smile });
  assert.equal(t2.faces[0].teeth.bothRows, false);
  assert.equal(t2.faces[0].teeth.line, 0);
  assert.ok(t2.stones.some((s) => s.designed && s.color === "crystal-clear"));
});

test("faces lips in colour: the colours the AI drew (its discs), the upper lip darker, the line in the same hue", () => {
  const regions = faceRegions(face({ big: true }));
  const discs = [];
  for (let x = 22; x <= 38; x += 1) for (let y = 34; y <= 50; y += 1) {
    if (insidePolygon([x, y], regions.lips.upper) || insidePolygon([x, y], regions.lips.lower)) discs.push([x, y, 2]);
  }
  const readStone = (x, y) => (insidePolygon([x, y], regions.lips.upper) ? "siam" : "rose");
  const L = (id) => lightness(STONE_COLORS[id].fill);
  const one = designFaceFeatures(skin(), [face({ big: true })], { style: "colour", lips: "L1", discs, readStone, ...ctx(false) });
  assert.ok(["siam", "rose"].includes(one.faces[0].lips.colours[0]));
  const two = designFaceFeatures(skin(), [face({ big: true })], { style: "colour", lips: "L2", discs, readStone, ...ctx(false) });
  const [upper, lower, line] = two.faces[0].lips.colours;
  assert.equal(upper, "siam");
  assert.equal(lower, "rose");
  assert.ok(L(line) < L(upper) && !["jet", "hematite", "jet-hematite", "black-diamond", "graphite"].includes(line), line);
});
