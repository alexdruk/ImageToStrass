import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { findLeaks } from "./leak-words.mjs";
import { FILE_NAME, PLACEHOLDER, howToPdf, siteOf } from "./make-how-to-pdf.mjs";
import { findOldBrand } from "./brand-words.mjs";

// IS-06 listing texts (spec section 11.1): docs/etsy-listing.md carries the required lines, and the
// listing's one-page docs/PatternNifty-how-to-download.pdf opens and sends the buyer to
// patternnifty.com/download. Everything the buyer reads says PatternNifty, never IS (PN-01).

const DOCS = new URL("../docs/", import.meta.url);
const LISTING = readFileSync(new URL("etsy-listing.md", DOCS), "utf8");
const block = (heading) => LISTING.split(`## ${heading}\n`)[1].match(/```\n([\s\S]*?)\n```/)[1];

async function pdfText(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const { info } = await doc.getMetadata();
  return {
    pages: doc.numPages,
    size: page.view.slice(2),
    text: (await page.getTextContent()).items.map((i) => i.str).join(" "),
    info
  };
}

test("listing: title, personalization instructions, size line, expectations and the generic AI disclosure", () => {
  const title = block("Title");
  assert.ok(title.length <= 140, `title is ${title.length} characters`);
  assert.equal(block("Personalization instructions"), "Enter your PatternNifty code, for example PN-7K3Q-9XPA");
  const description = block("Description");
  assert.ok(description.includes("Size depends on your image, usually 13 to 30 cm on the longest side. You see the exact size before you buy."));
  assert.ok(description.includes("Designs are created with the help of AI tools."));
  // What to expect (IS-07b): an artistic version, stylised faces, up to 3 designs, the two B&W styles.
  assert.ok(description.includes("Your design is an artistic rhinestone version of your photo"));
  assert.ok(description.includes("faces are stylised rather than photographic"));
  assert.ok(description.includes("You can try up to 3 designs and you only buy if you like one."));
  assert.ok(description.includes("Black & white comes in two styles: Bold and Shaded."));
  assert.ok(description.includes("Go to patternnifty.com and upload"));
  assert.ok(description.includes("Go to patternnifty.com/download"));
  for (const heading of ["Title", "Description", "Personalization instructions"]) assert.deepEqual(findOldBrand(block(heading)), [], heading);
  // No price, payment or contact collection off Etsy (spec 11.1); no provider (spec 12).
  assert.doesNotMatch(description, /[$€£]|https?:|@|e-?mail/i);
  assert.deepEqual(findLeaks(LISTING), []);
  const tags = block("Tags (suggestions, 13 at most, 20 characters each)").split(/,\s*/);
  assert.ok(tags.length <= 13 && tags.every((t) => t.length <= 20));
});

test("how-to PDF: one Letter page that sends the buyer to patternnifty.com/download, PatternNifty only", async () => {
  const committed = await pdfText(readFileSync(new URL(FILE_NAME, DOCS)));
  assert.equal(committed.pages, 1);
  assert.deepEqual(committed.size, [612, 792]);
  assert.match(committed.text, /\/download/);
  assert.equal(FILE_NAME, "PatternNifty-how-to-download.pdf");
  assert.match(committed.text, /patternnifty\.com\/download/);
  assert.match(committed.text, /PN-7K3Q-9XPA/);
  assert.equal(committed.info.Producer, "PatternNifty");
  assert.deepEqual(findOldBrand(`${committed.text} ${JSON.stringify(committed.info)}`), []);
  assert.deepEqual(findLeaks(committed.text), []);

  const made = await pdfText(howToPdf("https://is.example/"));
  assert.match(made.text, /is\.example\/download/);
  assert.equal(siteOf(""), PLACEHOLDER);
});
