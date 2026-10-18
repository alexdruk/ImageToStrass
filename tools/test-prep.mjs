import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import {
  DEFAULT_SETTINGS, applyAdjustments, crop, levels, normalizeSettings, rotate, tone
} from "../src/prep/adjust.js";
import {
  createUploadDir, storeNew, uploadDir, writeAttemptInputs, writeCodeJson
} from "../src/prep/archive.js";
import { BadFile, decodeToWork } from "../src/prep/decode.js";
import { detectFormat } from "../src/prep/formats.js";
import { preparePng, previewPng, readRgba } from "../src/prep/prepare.js";
import { svgProblem } from "../src/prep/svg.js";

const FIXTURES = new URL("./fixtures/upload/", import.meta.url).pathname;
const fixture = (name) => readFileSync(path.join(FIXTURES, name));

// One fixture per accepted format, plus decoder edge cases. lossless: pixels must match
// photo.png exactly; otherwise the mean channel difference must stay small.
const DECODES = [
  { file: "photo.png", format: "png", lossless: true, alpha: true },
  { file: "photo.jpg", format: "jpeg", alpha: false },
  { file: "photo.bmp", format: "bmp", lossless: true, alpha: false },
  { file: "photo.tif", format: "tiff", lossless: true, alpha: true },
  { file: "photo.webp", format: "webp", alpha: true },
  { file: "photo.avif", format: "avif", alpha: true },
  { file: "drawing.svg", format: "svg", size: [2048, 1536] },
  { file: "photo-v5.bmp", format: "bmp", lossless: true, alpha: true },
  { file: "photo-16bit.png", format: "png", alpha: true },
  { file: "photo-exif6.jpg", format: "jpeg", alpha: false },
  { file: "photo-cmyk.jpg", format: "jpeg", alpha: false },
  { file: "animated.webp", format: "webp", alpha: true }
];

const MALICIOUS = [
  "malicious-script.svg", "malicious-script-prefixed.svg", "malicious-foreign-object.svg",
  "malicious-onload.svg", "malicious-external-href.svg", "malicious-file-href.svg",
  "malicious-css-url.svg", "malicious-entity.svg"
];

async function reference() {
  return readRgba(fixture("photo.png"));
}

// Mean absolute RGB difference over the opaque pixels of the reference.
function meanDiff(a, b) {
  let sum = 0;
  let n = 0;

  for (let i = 0; i < a.data.length; i += 4) {
    if (b.data[i + 3] === 255) {
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
  }

  return sum / n;
}

function pngWithHeader(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR");
  const chunk = Buffer.alloc(12 + 13);
  chunk.writeUInt32BE(13, 0);
  type.copy(chunk, 4);
  ihdr.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, ihdr])), 21);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk, Buffer.alloc(64)]);
}

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "is-prep-"));
}

test("file signatures decide the format, not the name", () => {
  for (const { file, format } of DECODES) {
    assert.equal(detectFormat(fixture(file)), format, file);
  }

  assert.equal(detectFormat(fixture("not-an-image.png")), null);
  assert.equal(detectFormat(Buffer.from("GIF89a......")), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
  assert.equal(detectFormat(Buffer.from("<html><svg></svg></html>")), null);
  assert.equal(detectFormat(Buffer.from("﻿  <svg xmlns='http://www.w3.org/2000/svg'/>")), "svg");
});

test("one fixture per format decodes to work.png: sRGB RGBA, metadata stripped", async () => {
  const ref = await reference();

  for (const { file, format, lossless, alpha, size = [240, 180] } of DECODES) {
    const work = await decodeToWork(fixture(file), format);
    const meta = await sharp(work.png).metadata();

    assert.equal(meta.format, "png", file);
    assert.deepEqual([work.width, work.height], size, file);
    assert.deepEqual([meta.width, meta.height], size, file);
    assert.equal(meta.channels, 4, file);
    assert.equal(meta.depth, "uchar", file);
    assert.equal(meta.space, "srgb", file);
    assert.equal(meta.exif, undefined, `${file}: EXIF stripped`);
    assert.equal(meta.icc, undefined, `${file}: ICC stripped`);
    assert.equal(meta.orientation, undefined, `${file}: orientation stripped`);

    if (format === "svg") {
      continue;
    }

    const got = await readRgba(work.png);

    if (lossless) {
      const visible = (img) => Buffer.from(img.data).filter((_, i) => alpha || i % 4 !== 3);
      assert.deepEqual(visible(got), visible(ref), `${file}: exact pixels`);
    } else {
      assert.ok(meanDiff(got, ref) < 12, `${file}: mean difference ${meanDiff(got, ref)}`);
    }

    // The left quarter is transparent in the source; formats without alpha come out opaque.
    assert.equal(got.data[3], alpha ? 0 : 255, `${file}: alpha at the left edge`);
    assert.equal(got.data[(90 * 240 + 200) * 4 + 3], 255, `${file}: alpha on the right`);
  }
});

test("long side is limited to 2048 px and small images are not enlarged", async () => {
  const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#123456" } }).png().toBuffer();
  const work = await decodeToWork(big, "png");
  assert.deepEqual([work.width, work.height], [2048, 683]);
});

test("images over 100 megapixels are refused before decoding", async () => {
  await assert.rejects(decodeToWork(pngWithHeader(10_001, 10_000), "png"), BadFile);

  const bmpHeader = Buffer.alloc(54);
  bmpHeader.write("BM", 0, "latin1");
  bmpHeader.writeUInt32LE(54, 10);
  bmpHeader.writeUInt32LE(40, 14);
  bmpHeader.writeInt32LE(20_000, 18);
  bmpHeader.writeInt32LE(20_000, 22);
  bmpHeader.writeUInt16LE(24, 28);
  await assert.rejects(decodeToWork(bmpHeader, "bmp"), BadFile);
});

test("broken files and unknown formats are BadFile", async () => {
  await assert.rejects(decodeToWork(fixture("broken.png"), "png"), BadFile);
  await assert.rejects(decodeToWork(fixture("not-an-image.png"), null), BadFile);
  // A JPEG body with a PNG claim: the decoder's own sniffing must agree.
  await assert.rejects(decodeToWork(fixture("photo.jpg"), "png"), BadFile);
});

test("malicious SVG fixtures are refused", async () => {
  for (const file of MALICIOUS) {
    assert.equal(detectFormat(fixture(file)), "svg", file);
    assert.ok(svgProblem(fixture(file).toString("utf8")), file);
    await assert.rejects(decodeToWork(fixture(file), "svg"), BadFile, file);
  }

  assert.equal(svgProblem(fixture("drawing.svg").toString("utf8")), null);
  assert.equal(svgProblem('<svg><image href="data:image/png;base64,AAAA"/></svg>'), null);
  assert.ok(svgProblem('<svg><a href = "javascript:alert(1)">x</a></svg>'));
  assert.ok(svgProblem("<svg><image href=//evil.example/x.png /></svg>"));
  assert.ok(svgProblem('<svg><use xlink:href="other.svg#a"/></svg>'));
  assert.ok(svgProblem('<svg><rect ONCLICK="x()"/></svg>'));
});

test("adjust: settings are validated", () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.deepEqual(
    normalizeSettings({ rotate: 90, brightness: -100, extra: 1, crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }),
    { ...DEFAULT_SETTINGS, rotate: 90, brightness: -100, crop: { x: 0.1, y: 0, w: 0.9, h: 1 } }
  );

  for (const bad of [
    { rotate: 45 }, { brightness: 101 }, { contrast: 1.5 }, { saturation: "10" },
    { crop: { x: 0.5, y: 0, w: 0.6, h: 1 } }, { crop: { x: 0, y: 0, w: 0, h: 1 } }, null
  ]) {
    assert.throws(() => normalizeSettings(bad), RangeError, JSON.stringify(bad));
  }
});

test("adjust: rotation and crop move pixels exactly", async () => {
  const img = await reference();

  let turned = img;
  for (let i = 0; i < 4; i += 1) {
    turned = rotate(turned, 90);
  }
  assert.deepEqual(Buffer.from(turned.data), Buffer.from(img.data));

  const r90 = rotate(img, 90);
  assert.deepEqual([r90.width, r90.height], [180, 240]);
  // The top-left source pixel lands at the top-right after a clockwise turn.
  assert.deepEqual([...r90.data.subarray((179) * 4, 180 * 4)], [...img.data.subarray(0, 4)]);
  assert.deepEqual(Buffer.from(rotate(rotate(img, 180), 180).data), Buffer.from(img.data));
  assert.deepEqual(Buffer.from(rotate(r90, 270).data), Buffer.from(img.data));

  const c = crop(img, { x: 0.5, y: 0.5, w: 0.25, h: 0.5 });
  assert.deepEqual([c.width, c.height], [60, 90]);
  assert.deepEqual([...c.data.subarray(0, 4)], [...img.data.subarray((90 * 240 + 120) * 4, (90 * 240 + 121) * 4)]);
});

test("adjust: neutral settings copy; tone sliders and auto enhance behave", async () => {
  const img = await reference();
  const same = applyAdjustments(img, {});
  assert.deepEqual(Buffer.from(same.data), Buffer.from(img.data));
  assert.notEqual(same.data, img.data, "a copy, not the input");

  const grey = tone(img, { ...DEFAULT_SETTINGS, saturation: -100 });
  for (let i = 0; i < grey.data.length; i += 4) {
    assert.ok(Math.abs(grey.data[i] - grey.data[i + 1]) <= 1 && Math.abs(grey.data[i + 1] - grey.data[i + 2]) <= 1);
    assert.equal(grey.data[i + 3], img.data[i + 3], "alpha kept");
  }

  const dark = tone(img, { ...DEFAULT_SETTINGS, brightness: -100 });
  const light = tone(img, { ...DEFAULT_SETTINGS, brightness: 100 });
  const flat = tone(img, { ...DEFAULT_SETTINGS, contrast: -100 });
  const mean = (x) => x.data.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0) / (x.data.length * 0.75);
  assert.ok(mean(dark) < mean(img) && mean(img) < mean(light));
  assert.ok(flat.data.every((v, i) => i % 4 === 3 || v === 128), "contrast -100 is flat grey");

  // A low-contrast image is stretched to (nearly) the full range.
  const dull = { ...img, data: img.data.map((v, i) => (i % 4 === 3 ? v : 100 + Math.round(v / 5))) };
  const { lo, hi } = levels(dull);
  assert.ok(lo >= 100 && hi <= 151 && hi > lo);
  const enhanced = levels(tone(dull, { ...DEFAULT_SETTINGS, autoEnhance: true }));
  assert.ok(enhanced.lo <= 2 && enhanced.hi >= 253, JSON.stringify(enhanced));
});

test("prepare: the server applies the settings to the full image", async () => {
  const work = (await decodeToWork(fixture("photo.png"), "png")).png;
  const png = await preparePng(work, { rotate: 270, crop: { x: 0, y: 0, w: 1, h: 0.5 }, contrast: 20 });
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height, meta.channels], [180, 120, 4]);

  const big = await sharp({ create: { width: 2048, height: 1000, channels: 4, background: "#808080ff" } }).png().toBuffer();
  const preview = await sharp(await previewPng(big)).metadata();
  assert.deepEqual([preview.width, preview.height], [1024, 500]);
});

test("archive: upload and attempt folders are numbered and never overwritten", () => {
  const root = tmp();

  try {
    const code = "IS-AAAA-BBBB";
    writeCodeJson(root, { code, status: "open" });
    writeCodeJson(root, { code, status: "paid" });
    assert.equal(JSON.parse(readFileSync(path.join(root, code, "code.json"), "utf8")).status, "paid");

    assert.equal(createUploadDir(root, code).k, 1);
    // A folder made by hand (or left by a crash) is skipped, never reused.
    mkdirSync(uploadDir(root, code, 3));
    assert.equal(createUploadDir(root, code).k, 4);
    assert.equal(createUploadDir(root, code).k, 5);

    const dir = uploadDir(root, code, 1);
    storeNew(dir, "work.png", "a");
    assert.throws(() => storeNew(dir, "work.png", "b"), /EEXIST/);
    assert.equal(readFileSync(path.join(dir, "work.png"), "utf8"), "a");

    writeFileSync(path.join(dir, "original.jpg"), "jpeg bytes");
    const inputs = { originalFile: path.join(dir, "original.jpg"), preparedPng: Buffer.from("png"), settings: { uploadId: 1 } };
    const attempt = writeAttemptInputs(root, code, 1, inputs);
    assert.equal(readFileSync(path.join(attempt, "original.jpg"), "utf8"), "jpeg bytes");
    assert.deepEqual(JSON.parse(readFileSync(path.join(attempt, "settings.json"), "utf8")), { uploadId: 1 });
    assert.ok(existsSync(path.join(attempt, "prepared.png")));
    assert.throws(() => writeAttemptInputs(root, code, 1, inputs), /EEXIST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
