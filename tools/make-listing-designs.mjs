// PN-04a: real example designs for the Etsy listing, run by hand (real provider and strass calls):
//   node tools/make-listing-designs.mjs <subjects.json> [--out=<dir>] [--full=<dir>] [--only=<id>,...] [--extra=<n>]
//   node tools/make-listing-designs.mjs --overview [--out=<dir>]
//   node tools/make-listing-designs.mjs --copies [--out=<dir>]
// <subjects.json>: [{ id, photo, modes: ["colour", "bw-stencil", "bw-halftone"], adjustments?,
// source: { title, url, author, licence } }]; photo is relative to the file; adjustments are the
// buyer's own settings (spec 6.3, e.g. a crop), none if left out. Each subject goes through the web
// app itself, in this process (createApp, the real background removal and pipeline, spec 6 and 7, no
// setting changed): upload with background removal on, the subject's adjustments, then one Create
// design per mode; the pipeline's own acceptance and automatic re-run apply. A failed or declined
// design is made once more at most, and --extra=<n> caps those extra runs over the whole batch.
// The app runs on its own in-memory database and a data folder under data/listing/ (git-ignored): no
// buyer code is created in data/is.sqlite, no buyer limit (per IP, daily cap) is used, nothing under
// data/archive/ is read or written. The AI images and layouts stay in data/listing/runs/.
// Written to data/listing/designs/<id>-<mode>/ (git-ignored): the full-size prepared.png and tinted.png
// and stats.json (design: the mode id above; the design's result, spec 7.7; the adjustments; the
// photo's source and licence); to <out>/<id>-<mode>/ (default docs/listing/designs/, committed): the
// same with both images at SMALL_PX on the long side.
// --overview: <out>/overview.png (at most OVERVIEW_W wide), every design in data/listing/designs/, its
// prepared photo next to its tinted render, labelled with subject, mode and natural size.
// --copies: the <out>/ copies made again from data/listing/designs/.
// --full=<dir>: the full-size files there instead of data/listing/designs/ (test runs that must not
// replace a listing design, PN-10).
// --replay=<attempt folder>: no provider call; the design is drawn again from that attempt's stored
// AI image (ai.png), through the same upload, layout service (STRASS_SERVICE_URL) and pipeline, so a
// changed layout rule can be applied to an existing design (PN-04h). One subject, one mode.
import "dotenv/config";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { createQueries } from "../src/db/queries.js";
import { createPipeline } from "../src/pipeline/design.js";
import { createBackgroundRemover } from "../src/prep/background.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import sharp from "sharp";
import { etsyTestConfig, noEtsy } from "./etsy-mock.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const OUT = path.resolve(arg("out") || path.join(ROOT, "docs/listing/designs"));
const FULL = path.resolve(arg("full") || path.join(ROOT, "data/listing/designs"));
const RUNS = path.join(ROOT, "data/listing/runs");
const SMALL_PX = 1200;
const OVERVIEW_W = 2000;
const MODES = {
  "colour": { mode: "colour" },
  "bw-stencil": { mode: "bw", bwStyle: "stencil" },
  "bw-halftone": { mode: "bw", bwStyle: "halftone" }
};
const MODE_NAMES = { "colour": "Colour", "bw-stencil": "Black & white Bold", "bw-halftone": "Black & white Shaded" };
const TRIES = 2;
const REPLAY = arg("replay") && path.resolve(arg("replay"));
let extras = arg("extra") === undefined ? Infinity : Number(arg("extra"));

// The web app on its own data folder and in-memory database. Only the limits' numbers are raised:
// they count this database's designs, never the live site's.
async function startApp(root) {
  const base = loadConfig();
  if (base.fake) throw new Error("IS_FAKE=1 is set: the listing designs need the real pipeline.");
  const config = {
    ...base,
    dataDir: root,
    dbFile: ":memory:",
    archiveDir: path.join(root, "archive"),
    deliveryDir: path.join(root, "delivery"),
    tmpDir: path.join(root, "tmp"),
    backupDir: path.join(root, "backup"),
    ipKeyFile: path.join(root, "ip-hash.key"),
    etsy: etsyTestConfig(base.etsy, root),
    designsPerIpPerDay: 1000,
    dailyDesignCap: 1000
  };
  const db = openDatabase(config.dbFile);
  const q = createQueries(db);
  const background = createBackgroundRemover({ config, log: console });
  const pipeline = createPipeline({ q, config, log: console, provider: REPLAY ? replayProvider(REPLAY) : null });
  const app = createApp({ db, config, deps: { verifyTurnstile: async () => true, background, pipeline, request: noEtsy } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    config, q, url, background, pipeline,
    async stop() {
      await pipeline.idle();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  };
}

// The stored AI image of an attempt as the provider's answer (--replay).
function replayProvider(dir) {
  const png = readFileSync(path.join(dir, "ai.png"));
  return {
    async redraw() {
      const { width, height } = await sharp(png).metadata();
      return { png, width, height };
    }
  };
}

async function upload(app, file) {
  const body = new FormData();
  body.append("consent", "1");
  body.append("image", new Blob([readFileSync(file)]), path.basename(file));
  const answer = await (await fetch(`${app.url}/api/upload`, { method: "POST", body })).json();
  if (!answer.code) throw new Error(`upload of ${file} refused: ${JSON.stringify(answer)}`);
  await app.background.idle();
  const status = await (await fetch(`${app.url}/api/uploads/${answer.code}/1`)).json().catch(() => ({}));
  if (!existsSync(path.join(app.config.archiveDir, answer.code, "uploads", "1", "cutout.png"))) {
    throw new Error(`background removal of ${file} failed: ${JSON.stringify(status)}`);
  }
  return answer.code;
}

// One Create design -> the final attempt row (a re-run followed to the attempt that replaced it).
async function design(app, code, settings, adjustments = {}) {
  const response = await fetch(`${app.url}/api/attempts/${code}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload: 1, removeBackground: true, adjustments, ...settings })
  });
  const created = await response.json();
  if (response.status !== 202) throw new Error(`Create design refused: ${JSON.stringify(created)}`);
  await app.pipeline.idle();
  let row = app.q.getAttempt(code, created.attempt);
  const chain = [row];
  while (row.result?.rerunAs) chain.push(row = app.q.getAttempt(code, row.result.rerunAs));
  return { row, chain };
}

async function makeSubject(subject, base) {
  const root = path.join(RUNS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${subject.id}`);
  mkdirSync(root, { recursive: true });
  const app = await startApp(root);
  const report = [];
  try {
    const code = await upload(app, path.resolve(base, subject.photo));
    for (const modeId of subject.modes) {
      let made = null;
      for (let t = 1; t <= TRIES && !made; t++) {
        if (t > 1 && extras-- <= 0) break;
        const { row, chain } = await design(app, code, MODES[modeId], subject.adjustments);
        const steps = chain.map((a) => `${a.n}:${a.status}${a.result?.rejected ? ` rejected ${JSON.stringify(a.result.rejected)}` : ""}${a.error_code ? ` (${a.error_code})` : ""}`);
        console.log(`${subject.id} ${modeId} try ${t}: ${steps.join(" -> ")}`);
        report.push({ id: subject.id, mode: modeId, try: t, attempts: steps });
        if (row.status === "done") made = row;
      }
      if (!made) continue;
      const dir = path.join(app.config.archiveDir, code, `attempt-${made.n}`);
      const full = path.join(FULL, `${subject.id}-${modeId}`), out = path.join(OUT, `${subject.id}-${modeId}`);
      const { outputPx, ...result } = made.result;
      const stats = { subject: subject.id, design: modeId, ...result, adjustments: subject.adjustments ?? {}, photo: subject.source };
      for (const d of [full, out]) {
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
      }
      for (const name of ["prepared.png", "tinted.png"]) {
        copyFileSync(path.join(dir, name), path.join(full, name));
        await small(path.join(full, name), path.join(out, name));
      }
      console.log(`  ${result.stones} stones, ${result.widthMm} x ${result.heightMm} mm (${result.widthIn} x ${result.heightIn} in), coverage ${result.coverage}`);
    }
  } finally {
    await app.stop();
  }
  return report;
}

// The committed copy: SMALL_PX on the long side (never enlarged), a 256-colour PNG (by eye the same
// as the full colours at this size, less than half the bytes).
const SMALL_PNG = { compressionLevel: 9, palette: true, quality: 100, effort: 10 };
async function small(from, to) {
  writeFileSync(to, await sharp(readFileSync(from))
    .resize(SMALL_PX, SMALL_PX, { fit: "inside", withoutEnlargement: true })
    .png(SMALL_PNG).toBuffer());
}

async function copies() {
  for (const d of readdirSync(FULL).filter((d) => existsSync(path.join(FULL, d, "stats.json")))) {
    mkdirSync(path.join(OUT, d), { recursive: true });
    copyFileSync(path.join(FULL, d, "stats.json"), path.join(OUT, d, "stats.json"));
    for (const name of ["prepared.png", "tinted.png"]) await small(path.join(FULL, d, name), path.join(OUT, d, name));
    console.log(path.join(OUT, d));
  }
}

// overview.png: one row per design, prepared photo | tinted render, each ROW_H high, a label above.
async function overview() {
  const ROW_H = 460, GAP = 16, LABEL_H = 40, CELL_W = 460;
  const order = Object.keys(MODES);
  const designs = readdirSync(FULL).filter((d) => existsSync(path.join(FULL, d, "stats.json")))
    .map((d) => ({ d, stats: JSON.parse(readFileSync(path.join(FULL, d, "stats.json"), "utf8")) }))
    .sort((a, b) => a.stats.subject.localeCompare(b.stats.subject) || order.indexOf(a.stats.design) - order.indexOf(b.stats.design));
  if (!designs.length) throw new Error(`no designs in ${FULL}`);
  const cols = 2;
  const pairW = 2 * CELL_W + GAP;
  const rows = Math.ceil(designs.length / cols);
  const W = cols * pairW + (cols + 1) * GAP * 2;
  if (W > OVERVIEW_W) throw new Error(`overview ${W} px wide, more than ${OVERVIEW_W}`);
  const H = rows * (ROW_H + LABEL_H + GAP * 2) + GAP;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  for (const [i, { d, stats }] of designs.entries()) {
    const x0 = GAP * 2 + (i % cols) * (pairW + GAP * 2), y0 = GAP + Math.floor(i / cols) * (ROW_H + LABEL_H + GAP * 2);
    ctx.fillStyle = "#14285a";
    ctx.font = "bold 19px sans-serif";
    ctx.fillText(`${stats.subject} · ${MODE_NAMES[stats.design]} · ${stats.widthMm} × ${stats.heightMm} mm (${stats.widthIn} × ${stats.heightIn} in) · ${stats.stones} stones`, x0, y0 + 28);
    for (const [j, name] of ["prepared.png", "tinted.png"].entries()) {
      const img = await loadImage(readFileSync(path.join(FULL, d, name)));
      const s = Math.min(CELL_W / img.width, ROW_H / img.height);
      const w = img.width * s, h = img.height * s;
      const cx = x0 + j * (CELL_W + GAP), cy = y0 + LABEL_H;
      ctx.fillStyle = "#f3f5f9";
      ctx.fillRect(cx, cy, CELL_W, ROW_H);
      ctx.drawImage(img, cx + (CELL_W - w) / 2, cy + (ROW_H - h) / 2, w, h);
    }
  }
  const file = path.join(OUT, "overview.png");
  writeFileSync(file, await sharp(await canvas.encode("png")).png(SMALL_PNG).toBuffer());
  console.log(`${file} ${W} x ${H}`);
}

if (process.argv.includes("--overview")) {
  await overview();
} else if (process.argv.includes("--copies")) {
  await copies();
} else {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: node tools/make-listing-designs.mjs <subjects.json> [--out=<dir>] [--full=<dir>] [--only=<id>,...] [--extra=<n>] | --overview | --copies");
  const only = arg("only")?.split(",");
  const subjects = JSON.parse(readFileSync(file, "utf8")).filter((s) => !only || only.includes(s.id));
  if (REPLAY && (subjects.length !== 1 || subjects[0].modes.length !== 1)) throw new Error("--replay draws one subject in one mode");
  const report = [];
  for (const subject of subjects) {
    for (const m of subject.modes) if (!MODES[m]) throw new Error(`${subject.id}: unknown mode ${m}`);
    report.push(...await makeSubject(subject, path.dirname(path.resolve(file))));
  }
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(path.join(RUNS, `report-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
