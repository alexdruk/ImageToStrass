// PatternNifty-how-to-download.pdf (spec section 11.1): the one-page file attached to the Etsy
// listing, which tells the buyer where to download (made the design first) or where to make it
// (bought first, PN-08: the order page). Run by hand:
//   node tools/make-how-to-pdf.mjs https://patternnifty.com
// The address comes from the argument, else PUBLIC_BASE_URL; with neither, a placeholder is printed
// in its place, and the file must be made again once the domain exists (spec section 19).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PdfDocument } from "../src/export/PdfDocument.js";
import { withInfo } from "../src/export/pdfInfo.js";
import { BRAND } from "../src/brand.js";

export const PLACEHOLDER = "[site address]";
export const FILE_NAME = `${BRAND}-how-to-download.pdf`;
const OUT = new URL(`../docs/${FILE_NAME}`, import.meta.url).pathname;

// US Letter, points.
const W = 612;
const H = 792;
const M = 64;
const BLUE = [0.07, 0.2, 0.56];
const INK = [0.05, 0.09, 0.19];
const MUTED = [0.36, 0.39, 0.47];

// "https://example.com/" -> "example.com"
export function siteOf(base) {
  if (!base) return PLACEHOLDER;
  return String(base).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function howToPdf(base) {
  const site = siteOf(base);
  const doc = new PdfDocument({ widthPt: W, heightPt: H });

  doc.setFillColor(BLUE);
  doc.drawRect(0, H - 96, W, 96, { fill: true, stroke: false });
  // "PatternNifty" in 30 pt Helvetica is 157 pt wide.
  doc.drawText(M, H - 58, BRAND, { sizePt: 30, color: [1, 1, 1] });
  doc.drawText(M + 172, H - 55, "rhinestone templates", { sizePt: 14, color: [0.85, 0.89, 1] });

  let y = H - 160;
  const line = (text, { size = 13, color = INK, gap = 1.45, x = M } = {}) => {
    doc.drawText(x, y, text, { sizePt: size, color });
    y -= size * gap;
  };

  line("How to get your rhinestone template", { size: 22, gap: 1.7 });
  line("Thank you for your order! There are two ways to your files.", { color: MUTED, gap: 2.4 });

  // One way (PN-08): a numbered badge, its question and its step, the address large, then notes.
  const part = (n, question, step, address, notes) => {
    doc.setFillColor(BLUE);
    doc.drawCircle(M + 13, y + 5, 13, { fill: true, stroke: false });
    doc.drawText(M + 9, y, String(n), { sizePt: 14, color: [1, 1, 1] });
    line(question, { x: M + 40, size: 17, gap: 1.5 });
    line(step, { x: M + 40, size: 13, color: INK, gap: 1.9 });
    line(address, { x: M + 40, size: 20, color: BLUE, gap: 1.6 });
    notes.forEach((text, i) => line(text, { x: M + 40, size: 12, color: MUTED, gap: i === notes.length - 1 ? 2.8 : 1.5 }));
  };
  part(1, "Made your design before buying?", `Go to ${site}/download and enter your code.`, `${site}/download`, [
    "It is the code you put in the Personalization field on Etsy, for example PN-7K3Q-9XPA.",
    "Tick the box and click Download ZIP."
  ]);
  part(2, "No design yet?", `Go to ${site}/order and enter your Etsy order number.`, `${site}/order`, [
    "You find it in your Etsy purchases and in Etsy's order email.",
    "Upload your photo, try up to 3 designs, pick one and download your files."
  ]);

  y -= 6;
  doc.setStrokeColor([0.87, 0.89, 0.93]);
  doc.setLineWidth(1);
  doc.drawLine(M, y + 18, W - M, y + 18);
  line("You get SVG, production sheets (PDF), AI, EPS, DXF and PNG at your design's natural size.", { size: 11, color: MUTED });
  line("Payments usually appear within 10 minutes of checkout; both pages check again automatically.", { size: 11, color: MUTED });
  line("Your files can be downloaded for 30 days from the day you get them.", { size: 11, color: MUTED, gap: 2 });
  line("Need help? Send us a message on Etsy with your order number.", { size: 11, color: MUTED });

  return withInfo(doc.toBytes(), { title: `How to download your ${BRAND} design` });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("dotenv/config");
  const base = process.argv[2] || process.env.PUBLIC_BASE_URL || "";
  writeFileSync(OUT, howToPdf(base));
  console.log(`Wrote ${OUT} for ${siteOf(base)}/download`);
  if (!base) console.log("No address given: make it again once the domain exists.");
}
