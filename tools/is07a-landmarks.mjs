// IS-07a (tools only, never used by the app): compares the layouts the strass service makes with its
// MediaPipe face landmarks and with RS's dlib ones (services/strass/scripts/is07a_landmarks.py), as
// IS delivers them: natural size, cleanup, hole fill, B&W mapping (spec 7.5, 7.6), acceptance (7.4).
//
//   node tools/is07a-landmarks.mjs JOBS.json RUN_DIR OUT_DIR [--html TITLE]
//
// JOBS.json: is07a_landmarks.py's jobs ([{ id, path }]); RUN_DIR: its output (results.json and
// ID-mediapipe.json, ID-dlib.json). A job whose id has "-bw" is a black & white design. Writes
// OUT_DIR/summary.json, OUT_DIR/ID.jpg for every design where the two differ (AI image with both
// models' eye boxes and pupils | plain dlib | plain MediaPipe | tinted dlib | tinted MediaPipe,
// cropped to the face), and OUT_DIR/table.md, or with --html OUT_DIR/../landmarks.html.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mapBlackAndWhiteFromImage } from "../src/pipeline/bw.js";
import { cleanedLayout } from "../src/pipeline/cleanup.js";
import { acceptLayout } from "../src/pipeline/design.js";
import { loadConfig } from "../src/server/config.js";
import { plainPng, rgba, strip, tintedPng } from "./exp-holes.mjs";

const MODELS = ["dlib", "mediapipe"];
const MARK = { dlib: "#d62828", mediapipe: "#1d4ed8" };
const PPMM = 24;
const PUPIL_TOLERANCE_MM = 0.05;

const config = loadConfig({});

// The delivered StoneLayout and its acceptance, as the pipeline makes them.
function delivered(layout, ai, bw) {
  const natural = cleanedLayout(layout, { fillHolesIn: config.fillHoles ? ai : null, serviceFillNeighbours: config.serviceFillNeighbours });
  const check = acceptLayout(natural);
  const stoneLayout = bw
    ? mapBlackAndWhiteFromImage(natural.stoneLayout, ai, { ...layout.report, originMm: natural.originMm }, config.bwThreshold, natural.voted)
    : natural.stoneLayout;
  return { stoneLayout, check, originMm: natural.originMm, gaps: natural.gaps };
}

const keyOf = (s) => `${s.xMm.toFixed(3)},${s.yMm.toFixed(3)},${s.sizeMm},${s.color}`;

// Frame mm -> the delivered StoneLayout's mm.
const toDelivered = (layout, d) => ([x, y]) => [x - layout.report.offsetMm[0] - d.originMm[0], y - layout.report.offsetMm[1] - d.originMm[1]];

// The face's view in frame mm: around both models' eye boxes, or pupils without eye boxes.
function faceView(row, s) {
  const pts = [];
  for (const m of MODELS) {
    for (const e of row[m].eyes || []) for (const [x, y] of e) pts.push([x * s, y * s]);
    for (const p of row[m].pupilsAtMm) pts.push(p);
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(14, 2.2 * (Math.max(...xs) - Math.min(...xs)), 2.2 * (Math.max(...ys) - Math.min(...ys)));
  return { x0: cx - span / 2, y0: cy - 0.4 * span, w: span, h: 0.95 * span };
}

// The AI image cropped to the view (frame mm), with each model's eye boxes (the 0.6-width circle
// the pupils are looked for in) and pupils.
async function aiPanel(file, s, view, row) {
  const meta = await sharp(file).metadata();
  const left = Math.round(view.x0 / s), top = Math.round(view.y0 / s), W = Math.round(view.w / s), H = Math.round(view.h / s);
  const padded = await sharp(file).extend({ left: Math.max(0, -left), top: Math.max(0, -top), right: Math.max(0, left + W - meta.width), bottom: Math.max(0, top + H - meta.height), background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const crop = await sharp(padded).extract({ left: Math.max(0, left), top: Math.max(0, top), width: W, height: H })
    .resize(Math.round(view.w * PPMM), Math.round(view.h * PPMM)).flatten({ background: "#e9edf5" }).png().toBuffer();
  const canvas = createCanvas(Math.round(view.w * PPMM), Math.round(view.h * PPMM));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(crop), 0, 0);
  const at = (xmm, ymm) => [(xmm - view.x0) * PPMM, (ymm - view.y0) * PPMM];
  for (const m of MODELS) {
    ctx.strokeStyle = MARK[m];
    ctx.lineWidth = 3;
    for (const e of row[m].eyes || []) {
      const cx = e.reduce((a, p) => a + p[0], 0) / e.length, cy = e.reduce((a, p) => a + p[1], 0) / e.length;
      const bw = Math.max(Math.max(...e.map((p) => p[0])) - Math.min(...e.map((p) => p[0])), 20);
      ctx.beginPath();
      e.forEach(([x, y], i) => { const [u, v] = at(x * s, y * s); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
      ctx.closePath();
      ctx.stroke();
      const [u, v] = at(cx * s, cy * s);
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(u, v, 0.6 * bw * s * PPMM, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    row[m].pupilsAtMm.forEach(([x, y], i) => {
      const [u, v] = at(x, y);
      ctx.beginPath();
      ctx.arc(u, v, (row[m].pupilsMm[i] / 2) * PPMM, 0, 2 * Math.PI);
      ctx.lineWidth = 4;
      ctx.stroke();
    });
  }
  return canvas.toBuffer("image/png");
}

const fmtFace = (f) => f ?? "none";

if (import.meta.url === `file://${process.argv[1]}`) {
  const [jobsFile, runDir, outDir, flag, title] = process.argv.slice(2);
  const html = flag === "--html";
  mkdirSync(outDir, { recursive: true });
  const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));
  const results = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
  const summary = [];
  for (const job of jobs) {
    const row = results[job.id];
    if (!row) continue;
    const bw = job.id.includes("-bw");
    const ai = await rgba(job.path);
    const layouts = Object.fromEntries(MODELS.map((m) => [m, JSON.parse(readFileSync(path.join(runDir, `${job.id}-${m}.json`), "utf8"))]));
    const d = Object.fromEntries(MODELS.map((m) => [m, delivered(layouts[m], ai, bw)]));
    const keys = Object.fromEntries(MODELS.map((m) => [m, new Set(d[m].stoneLayout.stones.map(keyOf))]));
    const finalChanged = [...keys.mediapipe].filter((k) => !keys.dlib.has(k)).length + [...keys.dlib].filter((k) => !keys.mediapipe.has(k)).length;
    const pupilsDiffer = row.dlib.pupilsAtMm.length !== row.mediapipe.pupilsAtMm.length || row.pupilDistMm.some((x) => x > PUPIL_TOLERANCE_MM);
    const differs = row.dlib.face !== row.mediapipe.face || Boolean(row.dlib.eyes) !== Boolean(row.mediapipe.eyes) || pupilsDiffer || row.onlyDlib + row.onlyMediapipe > 0 || finalChanged > 0;
    const item = {
      id: job.id, mode: bw ? "bw" : "colour", differs,
      faceFound: { dlib: Boolean(row.dlib.eyes), mediapipe: Boolean(row.mediapipe.eyes) },
      face: { dlib: row.dlib.face, mediapipe: row.mediapipe.face },
      pupils: { dlib: row.dlib.pupilsAtMm.length, mediapipe: row.mediapipe.pupilsAtMm.length },
      pupilDistMm: row.pupilDistMm,
      serviceStonesChanged: row.onlyDlib + row.onlyMediapipe,
      serviceViolations: { dlib: row.dlib.violations, mediapipe: row.mediapipe.violations },
      finalStones: { dlib: d.dlib.stoneLayout.count, mediapipe: d.mediapipe.stoneLayout.count },
      finalStonesChanged: finalChanged,
      check: Object.fromEntries(MODELS.map((m) => [m, { ok: d[m].check.ok, violations: d[m].check.violations, minGapMm: Math.round(d[m].gaps.minGapMm * 1e4) / 1e4 }])),
      image: null
    };
    if (differs) {
      const s = layouts.dlib.report.mmPerPx;
      const view = faceView(row, s);
      if (view) {
        const panels = [{ png: await aiPanel(job.path, s, view, row), label: "AI image: dlib red, MediaPipe blue" }];
        for (const kind of ["plain", "tinted"]) {
          for (const m of MODELS) {
            const [x0, y0] = toDelivered(layouts[m], d[m])([view.x0, view.y0]);
            const v = { x0, y0, w: view.w, h: view.h };
            const png = kind === "plain"
              ? plainPng(d[m].stoneLayout, v, PPMM)
              : await tintedPng(d[m].stoneLayout, v, PPMM, { bwGap: bw ? config.bwGap : null });
            panels.push({ png, label: `${kind} ${m === "dlib" ? "dlib" : "MediaPipe"}` });
          }
        }
        item.image = `${job.id}.jpg`;
        writeFileSync(path.join(outDir, item.image), await strip(null, panels, 360));
      }
    }
    summary.push(item);
    console.log(item.id, item.differs ? "DIFFERS" : "same", JSON.stringify(item.face), "final", item.finalStonesChanged, JSON.stringify(item.check));
  }
  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);

  const head = ["Design", "Mode", "Face found (dlib / MP)", "Face (dlib → MP)", "Pupils (dlib → MP)", "Pupil distance mm", "Service stones changed", "Delivered stones changed", "Violations dlib / MP", "Accepted dlib / MP"];
  const cells = (r) => [r.id, r.mode, `${r.faceFound.dlib ? "yes" : "no"} / ${r.faceFound.mediapipe ? "yes" : "no"}`,
    `${fmtFace(r.face.dlib)} → ${fmtFace(r.face.mediapipe)}`, `${r.pupils.dlib} → ${r.pupils.mediapipe}`,
    r.pupilDistMm.length ? r.pupilDistMm.map((x) => (x === null ? "–" : x.toFixed(2))).join(", ") : "–",
    String(r.serviceStonesChanged), String(r.finalStonesChanged),
    `${r.check.dlib.violations} / ${r.check.mediapipe.violations}`, `${r.check.dlib.ok ? "yes" : "no"} / ${r.check.mediapipe.ok ? "yes" : "no"}`];
  if (!html) {
    const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...summary.map((r) => `| ${cells(r).join(" | ")} |`)];
    writeFileSync(path.join(outDir, "table.md"), `${lines.join("\n")}\n`);
  } else {
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const rel = path.basename(outDir);
    const body = [
      `<h1>${esc(title || "IS-07a landmarks")}</h1>`,
      "<p>dlib (RS 38cd831, test only) against MediaPipe (the service from IS-07a), DEFAULT rules, the same AI image. Delivered = after natural size, cleanup, hole fill and B&amp;W mapping; Accepted = the IS acceptance check.</p>",
      `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`,
      ...summary.map((r) => `<tr class="${r.differs ? "d" : ""}">${cells(r).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`),
      "</table>",
      ...summary.filter((r) => r.image).map((r) => `<h2>${esc(r.id)}</h2><img src="${rel}/${esc(r.image)}" alt="${esc(r.id)}">`)
    ];
    const style = "body{font:14px system-ui,sans-serif;margin:24px;color:#111;background:#fff}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:3px 6px;font-size:12px}tr.d{background:#eef3ff}img{max-width:100%;border:1px solid #ccd}";
    writeFileSync(path.join(path.dirname(outDir), "landmarks.html"), `<!doctype html><meta charset="utf-8"><title>IS-07a landmarks</title><style>${style}</style>${body.join("\n")}\n`);
  }
}
