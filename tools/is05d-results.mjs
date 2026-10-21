// IS-05d skin shadow experiment, images and numbers for docs/IS-05d-results.md, run by hand (no
// provider or strass call):
//   node tools/is05d-results.mjs <runs dir> [--final]
// <runs dir> holds services/strass/scripts/is05d_runs.py's layouts (<name>.<variant>.json). Images
// go to docs/IS-05d-results/, numbers to docs/IS-05d-results/numbers.json:
//   woman-face.jpg     rs-woman face and neck per variant: AI image, tinted default, tinted variant,
//                      per-stone ΔE map of the skin stones;
//   closeup-<id>.jpg   the four faces: eye and cheek windows, AI image and tinted per variant;
//   numbers.json       per design and variant: stones per colour in the skin area, per-stone ΔE (fill
//                      and rendered), skin ΔE, skin ΔE at 3 mm, and what changed against the default.
// The drawing helpers follow tools/is05c-results.mjs.
import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { renderTinted, tintCanvasMm } from "../src/render/tinted.js";
import { StoneLayout } from "../src/stones/StoneLayout.js";
import { deltaE2000, discLab, mean, srgbToLab } from "./colour-diff.mjs";
import { CAT_LAB, SAMPLE_SHARE, decodeRgba, delivered, measure, summary } from "./is05b-measure.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = path.join(ROOT, "docs/IS-05d-results");
const RUNS = process.argv[2];
if (!RUNS) throw new Error("usage: node tools/is05d-results.mjs <runs dir>");
const GAP = 10, LABEL_H = 34, PX_PER_MM = 30;
mkdirSync(OUT, { recursive: true });

const RS_IMG = path.join(ROOT, "services/strass/prototype/img");
const DESIGNS = [
  { id: "rs-woman", run: "woman", ai: path.join(RS_IMG, "N2_woman.png"), face: true },
  { id: "rs-portrait", run: "portrait", ai: path.join(RS_IMG, "N2_portrait.png"), face: true },
  { id: "rs-einstein", run: "einstein", ai: path.join(RS_IMG, "N2_einstein.png"), face: true },
  { id: "rs-jesus", run: "jesus", ai: path.join(RS_IMG, "N2_jesus.png"), face: true },
  { id: "rs-dog", run: "dog", ai: path.join(RS_IMG, "N2_dog.png") },
  { id: "cat-rule", run: "cat", ai: path.join(ROOT, "tools/fixtures/is03b-ai/cat-rule-output.png") }
];
export const VARIANTS = ["default", "warm-1.5", "warm-3", "mixed", "warm-1.5-mixed", "warm-3-mixed"];
const TAG = { default: "default", "warm-1.5": "A 1.5", "warm-3": "A 3", mixed: "B", "warm-1.5-mixed": "C (A 1.5 + B)", "warm-3-mixed": "C (A 3 + B)" };
// Face and neck of rs-woman, frame mm (as tools/is05c-results.mjs).
const WOMAN_FACE = { x: 46, y: 15, w: 77, h: 123 };
const AREA_MM = 3;

const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const runOf = (d, v) => load(path.join(RUNS, `${d.run}.${v}.json`));
const tally = (xs) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const L = (id) => CAT_LAB[id][0];

// ---- the delivered design in AI-image (frame) mm (as tools/is05c-results.mjs) -------------------

function design(layout) {
  const { stoneLayout, kept } = delivered(layout);
  const [ox, oy] = layout.report.offsetMm;
  const shift = [kept[0].x - stoneLayout.stones[0].xMm + ox, kept[0].y - stoneLayout.stones[0].yMm + oy];
  return { stoneLayout, kept, shift, s: layout.report.mmPerPx };
}

function stoneRecords(des, img) {
  return des.stoneLayout.stones.map((st, i) => {
    const x = st.xMm + des.shift[0], y = st.yMm + des.shift[1];
    const ai = discLab(img, x / des.s, y / des.s, SAMPLE_SHARE * st.sizeMm / 2 / des.s);
    return { i, x, y, d: st.sizeMm, color: st.color, ai, de: ai ? deltaE2000(ai, CAT_LAB[st.color]) : null };
  });
}

// Skin and fur: warm AI colour (hue 30–78°, chroma 12–60, L* ≥ 25), as tools/is05c-results.mjs.
const isSkinAi = (lab) => {
  const c = Math.hypot(lab[1], lab[2]), h = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360;
  return c >= 12 && c <= 60 && h >= 30 && h <= 78 && lab[0] >= 25;
};

// ---- light mixing --------------------------------------------------------------------------------

function labToLinear([l, a, b]) {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) * 27 / 24389);
  const [X, Y, Z] = [0.95047 * f(fx), f(fy), 1.08883 * f(fz)];
  return [3.240479 * X - 1.53715 * Y - 0.498535 * Z, -0.969256 * X + 1.875992 * Y + 0.041556 * Z, 0.055648 * X - 0.204043 * Y + 1.057311 * Z];
}
function linearToLab(lin) {
  const v = lin.map((c) => Math.max(0, Math.min(1, c))).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return srgbToLab(v.map((c) => c * 255));
}
const mixLab = (labs) => {
  const lin = labs.map(labToLinear);
  return linearToLab([0, 1, 2].map((k) => mean(lin.map((c) => c[k]))));
};

// ΔE2000 at AREA_MM per skin stone: the light mix of the catalogue fills of the skin stones within
// AREA_MM of its centre against the light mix of the AI colours under them (what reads from a step
// back, where single stones no longer separate).
function areaDe(skin) {
  return skin.map((q) => {
    const nb = skin.filter((o) => Math.hypot(o.x - q.x, o.y - q.y) <= AREA_MM);
    return deltaE2000(mixLab(nb.map((o) => o.ai)), mixLab(nb.map((o) => CAT_LAB[o.color])));
  });
}

// Mean colour of an RGBA image over a disc (px), mixed in linear light, transparent as white.
function discMix(img, cx, cy, r) {
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(img.height - 1, cy + r); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(img.width - 1, cx + r); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      const p = (y * img.width + x) * 4, a = img.data[p + 3] / 255;
      for (let k = 0; k < 3; k++) acc[k] += lin8(img.data[p + k] * a + 255 * (1 - a));
      n++;
    }
  }
  return linearToLab(acc.map((v) => v / n));
}
const lin8 = (v8) => (v8 / 255 <= 0.04045 ? v8 / 255 / 12.92 : ((v8 / 255 + 0.055) / 1.055) ** 2.4);

// Rendered ΔE2000 at AREA_MM per stone in `which`: the AI image against the tinted render, each
// averaged in linear light over a disc of radius AREA_MM around the stone (gaps and highlights in
// both), and the L* difference (render − AI).
async function renderedArea(layout, img, which) {
  const { stoneLayout, kept } = delivered(layout);
  const [offX, offY] = layout.report.offsetMm;
  const s = layout.report.mmPerPx;
  const box = tintCanvasMm(stoneLayout);
  const rendered = renderTinted(stoneLayout, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * 10), background: "white" });
  const rimg = await decodeRgba(rendered.png);
  return which.map((i) => {
    const st = kept[i], placed = stoneLayout.stones[i];
    const ai = discMix(img, (st.x + offX) / s, (st.y + offY) / s, AREA_MM / s);
    const rl = discMix(rimg, (placed.xMm - box.minXmm) * rendered.scale, (placed.yMm - box.minYmm) * rendered.scale, AREA_MM * rendered.scale);
    return { de: deltaE2000(ai, rl), dL: rl[0] - ai[0], dC: Math.hypot(rl[1], rl[2]) - Math.hypot(ai[1], ai[2]) };
  });
}

// ---- drawing (as tools/is05c-results.mjs) --------------------------------------------------------

function label(text, width) {
  const canvas = createCanvas(width, LABEL_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, LABEL_H);
  ctx.fillStyle = "#0b1f4d";
  ctx.font = "bold 20px Helvetica, Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, LABEL_H / 2);
  return canvas.toBuffer("image/png");
}

async function grid(panels, cols, cellH, file) {
  const scaled = await Promise.all(panels.map(async (p) => {
    const { data, info } = await sharp(p.png).flatten({ background: "#ffffff" }).resize({ height: cellH }).png().toBuffer({ resolveWithObject: true });
    return { png: data, width: info.width, label: p.label };
  }));
  const cellW = Math.max(...scaled.map((s) => s.width));
  const rows = Math.ceil(scaled.length / cols);
  const width = cols * cellW + (cols - 1) * GAP, height = rows * (cellH + LABEL_H) + (rows - 1) * GAP;
  const composite = [];
  scaled.forEach((s, i) => {
    const left = (i % cols) * (cellW + GAP), top = Math.floor(i / cols) * (cellH + LABEL_H + GAP);
    composite.push({ input: label(s.label, cellW), left, top }, { input: s.png, left: left + Math.round((cellW - s.width) / 2), top: top + LABEL_H });
  });
  await sharp({ create: { width, height, channels: 3, background: "#e6e9ef" } }).composite(composite)
    .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(OUT, file));
  return file;
}

async function aiWindow(aiFile, s, win, pxPerMm = PX_PER_MM) {
  const meta = await sharp(aiFile).metadata();
  const left = Math.max(0, Math.round(win.x / s)), top = Math.max(0, Math.round(win.y / s));
  const width = Math.min(meta.width - left, Math.round(win.w / s)), height = Math.min(meta.height - top, Math.round(win.h / s));
  return sharp(aiFile).extract({ left, top, width, height }).flatten({ background: "#ffffff" })
    .resize({ width: Math.round(win.w * pxPerMm), height: Math.round(win.h * pxPerMm), fit: "fill", kernel: "nearest" }).png().toBuffer();
}

async function tintedWindow(des, win, pxPerMm = PX_PER_MM) {
  const w = { minXmm: win.x - des.shift[0], minYmm: win.y - des.shift[1], widthMm: win.w, heightMm: win.h };
  const reach = 8;
  const near = des.stoneLayout.stones.filter((s) => s.xMm > w.minXmm - reach && s.xMm < w.minXmm + w.widthMm + reach &&
    s.yMm > w.minYmm - reach && s.yMm < w.minYmm + w.heightMm + reach);
  const sub = new StoneLayout({ layerId: "win", stones: near });
  const box = tintCanvasMm(sub);
  const tinted = renderTinted(sub, { longSidePx: Math.round(Math.max(box.widthMm, box.heightMm) * pxPerMm), background: "white" });
  const left = Math.max(0, Math.round((w.minXmm - box.minXmm) * tinted.scale)), top = Math.max(0, Math.round((w.minYmm - box.minYmm) * tinted.scale));
  const width = Math.min(Math.round(w.widthMm * tinted.scale), tinted.widthPx - left), height = Math.min(Math.round(w.heightMm * tinted.scale), tinted.heightPx - top);
  return sharp(tinted.png).extract({ left, top, width, height }).png().toBuffer();
}

const DE_CLASSES = [[5, "#2e9e4f"], [10, "#c9d62f"], [15, "#f0a020"], [20, "#e0502a"], [Infinity, "#8e1020"]];
function deMap(des, win, deOf, pxPerMm) {
  const w = Math.round(win.w * pxPerMm), h = Math.round(win.h * pxPerMm);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  des.stoneLayout.stones.forEach((st, i) => {
    const de = deOf(i);
    if (de == null) return;
    const x = (st.xMm + des.shift[0] - win.x) * pxPerMm, y = (st.yMm + des.shift[1] - win.y) * pxPerMm;
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
    ctx.fillStyle = DE_CLASSES.find(([lim]) => de < lim)[1];
    ctx.beginPath();
    ctx.arc(x, y, (st.sizeMm / 2) * pxPerMm, 0, 2 * Math.PI);
    ctx.fill();
  });
  return canvas.toBuffer("image/png");
}

// Eye window (both pupils of the default layout plus 7 mm, frame mm) and the cheek window below it:
// as wide, from 2 mm under the lower pupil, 1.2 times as high as the eye window.
function windows(layout) {
  const r = layout.report;
  if (!r.pupilsAtMm?.length) return null;
  const eyes = r.pupilsAtMm.map(([x, y], k) => ({ x: x + r.offsetMm[0], y: y + r.offsetMm[1], r: r.pupilsMm[k] / 2 + 4 }));
  const x0 = Math.min(...eyes.map((e) => e.x - e.r)) - 3, x1 = Math.max(...eyes.map((e) => e.x + e.r)) + 3;
  const y0 = Math.min(...eyes.map((e) => e.y - e.r)) - 3, y1 = Math.max(...eyes.map((e) => e.y + e.r)) + 3;
  const eye = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const cheek = { x: x0, y: Math.max(...eyes.map((e) => e.y)) + 2 + Math.max(...eyes.map((e) => e.r - 4)), w: eye.w, h: 1.2 * eye.h };
  return { eye, cheek };
}

// ---- final DEFAULT (warm_shadow on, 3 ΔE): rs-woman face and neck --------------------------------
// node tools/is05d-results.mjs <runs dir> --final, with <runs dir>/rs-woman.{default,final}.json:
// AI image on white, the AI image's RGB as the service reads it (alpha ignored), tinted without
// warm_shadow, tinted final DEFAULT and the final per-stone ΔE map, to woman-face-final.jpg.

async function finalWoman() {
  const ai = path.join(RS_IMG, "N2_woman.png");
  const img = await decodeRgba(ai);
  const before = load(path.join(RUNS, "rs-woman.default.json")), final = load(path.join(RUNS, "rs-woman.final.json"));
  const s = final.report.mmPerPx;
  const des = design(final);
  const recs = stoneRecords(des, img);
  const inFace = (q) => q.x >= WOMAN_FACE.x && q.x <= WOMAN_FACE.x + WOMAN_FACE.w && q.y >= WOMAN_FACE.y && q.y <= WOMAN_FACE.y + WOMAN_FACE.h;
  const face = recs.filter((q) => q.ai && isSkinAi(q.ai) && inFace(q));
  const rgb = await sharp(ai).removeAlpha().png().toBuffer();
  const panels = [
    { png: await aiWindow(ai, s, WOMAN_FACE, 8), label: "AI image on white" },
    { png: await aiWindow(rgb, s, WOMAN_FACE, 8), label: "AI image RGB (as the service reads it)" },
    { png: await tintedWindow(design(before), WOMAN_FACE, 8), label: "tinted · without warm_shadow" },
    { png: await tintedWindow(des, WOMAN_FACE, 8), label: "tinted · final DEFAULT" },
    { png: deMap(des, WOMAN_FACE, (i) => (recs[i].ai && isSkinAi(recs[i].ai) ? recs[i].de : null), 8), label: `ΔE · face skin ${r2(mean(face.map((q) => q.de)))}` }
  ];
  const changed = final.stones.filter((q, k) => q[3] !== before.stones[k][3]).length;
  console.log(JSON.stringify({ file: await grid(panels, 5, 620, "woman-face-final.jpg"), changed, faceSkin: face.length, byColour: tally(face.map((q) => q.color)) }));
}
if (process.argv[3] === "--final") {
  await finalWoman();
  process.exit(0);
}

// ---- runs ---------------------------------------------------------------------------------------

const numbers = {};
for (const d of DESIGNS) {
  const img = await decodeRgba(d.ai);
  const base = runOf(d, "default");
  const baseRecs = stoneRecords(design(base), img);
  const rows = [];
  for (const v of VARIANTS) {
    const layout = runOf(d, v);
    const des = design(layout);
    const recs = stoneRecords(des, img);
    const skin = recs.filter((q) => q.ai && isSkinAi(q.ai));
    const area = areaDe(skin);
    const all = summary(await measure(layout, img));
    const geometry = JSON.stringify(layout.stones.map((q) => q.slice(0, 3))) === JSON.stringify(base.stones.map((q) => q.slice(0, 3)));
    const changed = geometry ? layout.stones.map((q, k) => [base.stones[k][3], q[3]]).filter(([a, b]) => a !== b) : null;
    const skinChanged = geometry ? recs.filter((q, k) => q.color !== baseRecs[k].color) : [];
    const row = {
      variant: v, stones: layout.report.stones, geometry,
      facePupils: ["face", "pupilsMm", "pupilsAtMm"].every((k) => JSON.stringify(layout.report[k]) === JSON.stringify(base.report[k])),
      changed: changed && changed.length, transitions: changed && tally(changed.map(([a, b]) => `${a} → ${b}`)),
      changedInSkin: skinChanged.filter((q) => q.ai && isSkinAi(q.ai)).length,
      deStone: r2(all.b.mean), deRendered: r2(all.c.mean),
      skin: skin.length, skinDe: r2(mean(skin.map((q) => q.de))), skinDL: r2(mean(skin.map((q) => L(q.color) - q.ai[0]))),
      skinAreaDe: r2(mean(area)), skinByColour: tally(skin.map((q) => q.color))
    };
    {
      const ra = await renderedArea(layout, img, skin.map((q) => q.i));
      row.skinRendered = { de: r2(mean(ra.map((x) => x.de))), dL: r2(mean(ra.map((x) => x.dL))), dC: r2(mean(ra.map((x) => x.dC))) };
      skin.forEach((q, k) => { q.rendered = ra[k]; });
    }
    if (d.id === "rs-woman") {
      const inFace = (q) => q.x >= WOMAN_FACE.x && q.x <= WOMAN_FACE.x + WOMAN_FACE.w && q.y >= WOMAN_FACE.y && q.y <= WOMAN_FACE.y + WOMAN_FACE.h;
      const fk = skin.map((q, k) => [q, area[k]]).filter(([q]) => inFace(q));
      // The jaw and neck shadow: face-window skin stones with AI L* 25–40 (IS-05c section 2.2).
      const sh = fk.filter(([q]) => q.ai[0] < 40);
      row.face = { n: fk.length, de: r2(mean(fk.map(([q]) => q.de))), areaDe: r2(mean(fk.map(([, a]) => a))), rendered: r2(mean(fk.map(([q]) => q.rendered.de))), byColour: tally(fk.map(([q]) => q.color)) };
      row.shadow = {
        n: sh.length, de: r2(mean(sh.map(([q]) => q.de))), areaDe: r2(mean(sh.map(([, a]) => a))), dL: r2(mean(sh.map(([q]) => L(q.color) - q.ai[0]))),
        mixDL: r2(mean(sh.map(([q]) => mixLab(fk.filter(([o]) => Math.hypot(o.x - q.x, o.y - q.y) <= AREA_MM).map(([o]) => CAT_LAB[o.color]))[0] - q.ai[0]))),
        rendered: { de: r2(mean(sh.map(([q]) => q.rendered.de))), dL: r2(mean(sh.map(([q]) => q.rendered.dL))), dC: r2(mean(sh.map(([q]) => q.rendered.dC))) },
        byColour: tally(sh.map(([q]) => q.color))
      };
    }
    rows.push(row);
    console.log(d.id, v, JSON.stringify({ ...row, skinByColour: undefined, transitions: undefined }));
  }
  numbers[d.id] = { rows };

  // Images: rs-woman face and neck; eye and cheek close-ups for the faces.
  if (d.id === "rs-woman") {
    const s = base.report.mmPerPx;
    const aiPng = await aiWindow(d.ai, s, WOMAN_FACE, 8);
    const defPng = await tintedWindow(design(base), WOMAN_FACE, 8);
    const panels = [];
    for (const v of VARIANTS) {
      const des = design(runOf(d, v));
      const recs = stoneRecords(des, img);
      const map = deMap(des, WOMAN_FACE, (i) => (recs[i].ai && isSkinAi(recs[i].ai) ? recs[i].de : null), 8);
      const row = rows.find((r) => r.variant === v);
      panels.push({ png: aiPng, label: "AI image" }, { png: defPng, label: "tinted · default" },
        { png: await tintedWindow(des, WOMAN_FACE, 8), label: `tinted · ${TAG[v]}` },
        { png: map, label: `ΔE · face ${row.face.de} · 3 mm ${row.face.areaDe}` });
    }
    numbers[d.id].faceFile = await grid(panels, 4, 620, "woman-face.jpg");
  }
  if (d.face) {
    const win = windows(base);
    const panels = [];
    for (const [name, w] of Object.entries(win)) {
      panels.push({ png: await aiWindow(d.ai, base.report.mmPerPx, w), label: `AI image · ${name}` });
      for (const v of VARIANTS) panels.push({ png: await tintedWindow(design(runOf(d, v)), w), label: TAG[v] });
    }
    numbers[d.id].windows = win;
    numbers[d.id].closeupFile = await grid(panels, 7, 300, `closeup-${d.id}.jpg`);
  }
}
writeFileSync(path.join(OUT, "numbers.json"), JSON.stringify(numbers, null, 1));
