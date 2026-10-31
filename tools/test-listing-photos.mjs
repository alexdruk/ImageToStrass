import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import sharp from "sharp";
import { findOldBrand } from "./brand-words.mjs";
import { findLeaks } from "./leak-words.mjs";

// PN-04b, PN-04c, PN-04i: the committed Etsy listing photos (tools/make-listing-photos.mjs; the designs they are made
// from are git-ignored, so only the committed files are checked here).

const DIR = new URL("../docs/listing/photos/", import.meta.url);
const README = readFileSync(new URL("README.md", DIR), "utf8");
const PHOTOS = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).sort();

test("listing photos: 2700 x 2025 sRGB JPGs under 1 MB, no metadata but the colour profile", async () => {
  assert.deepEqual(PHOTOS.map((f) => f.slice(0, 2)), ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);
  for (const f of PHOTOS) {
    const file = new URL(f, DIR);
    assert.ok(statSync(file).size < 1024 * 1024, `${f} is ${statSync(file).size} bytes`);
    const m = await sharp(file.pathname).metadata();
    assert.equal(m.format, "jpeg", f);
    assert.deepEqual([m.width, m.height], [2700, 2025], f);
    assert.equal(m.space, "srgb", f);
    assert.ok(m.icc, `${f} has no colour profile`);
    assert.equal(m.exif ?? m.xmp ?? m.iptc, undefined, `${f} carries metadata`);
  }
  const overview = await sharp(new URL("overview.png", DIR).pathname).metadata();
  assert.ok(overview.width <= 2000, `overview.png is ${overview.width} px wide`);
});

test("listing photos README: every photo in order with alt text of at most 250 characters", () => {
  const rows = README.split("\n").filter((l) => /^\| \d+ \| \[/.test(l)).map((l) => l.split(" | "));
  assert.deepEqual(rows.map((r) => r[1].match(/\[(.+?)\]/)[1]), PHOTOS);
  for (const r of rows) {
    const alt = r[2].replace(/ \|$/, "");
    assert.ok(alt.length > 0 && alt.length <= 250, `${r[1]}: alt text is ${alt.length} characters`);
  }
  assert.deepEqual(findLeaks(README), []);
  assert.deepEqual(findOldBrand(README), []);
  assert.doesNotMatch(README, /[$€£]|https?:/);
});
