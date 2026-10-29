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

test("listing (PN-07): title, personalization, settings, expectations, deletion, AI disclosure and tags", () => {
  const title = block("Title");
  assert.ok(title.length <= 140, `title is ${title.length} characters`);
  assert.ok(title.startsWith("Photo to Rhinestone Template, See Your Design Before You Buy"));
  assert.equal(block("Personalization instructions"), "Make your design first at patternnifty.com, then paste its code here, e.g. PN-7K3Q-9XPA. Several designs: one code each.");
  // The settings: Digital files, not Made to order; the field title exactly Personalization, 100 characters.
  assert.match(LISTING, /\| Type \| Digital files \|/);
  assert.match(LISTING, /\| When made \| The newest year/);
  assert.match(LISTING, /\| Personalization field title \| Exactly `Personalization`/);
  assert.match(LISTING, /\| Personalization character limit \| 100/);
  assert.match(LISTING, /\| Personalization \| \*\*On, required\*\*, no add-on price \|/);
  assert.match(LISTING, /\| Digital file \| `docs\/PatternNifty-how-to-download\.pdf`/);
  const description = block("Description");
  assert.ok(description.startsWith("See your rhinestone design before you buy. Pay only if you like it."));
  assert.ok(description.includes("Designs are created with the help of AI tools."));
  // What to expect (IS-07b), the size, the 30-day deletion (D7) and the two B&W styles.
  assert.ok(description.includes("Your design is an artistic rhinestone version of your photo, not a copy of it: faces are stylised rather than photographic."));
  assert.ok(description.includes("Black & white comes in two styles: Bold (strong, graphic) and Shaded (more detail)."));
  assert.ok(description.includes("usually 13 to 30 cm (5 to 12 in) on the longest side"));
  assert.ok(description.includes("Your photo and designs are deleted 30 days after your last visit, or 30 days after payment."));
  assert.ok(description.includes("up to 3 designs"));
  assert.ok(description.includes("Go to patternnifty.com and upload"));
  assert.ok(description.includes("Go to patternnifty.com/download"));
  for (const heading of ["Title", "Description", "Personalization instructions"]) assert.deepEqual(findOldBrand(block(heading)), [], heading);
  // No price, payment or contact collection off Etsy (spec 11.1); no provider (spec 12).
  assert.doesNotMatch(description, /[$€£]|https?:|@|e-?mail/i);
  assert.deepEqual(findLeaks(LISTING), []);
  const tags = block("Tags (13 at most, 20 characters each)").split(/,\s*/);
  assert.equal(tags.length, 13);
  assert.ok(tags.every((t) => t.length <= 20), tags.filter((t) => t.length > 20).join());
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
