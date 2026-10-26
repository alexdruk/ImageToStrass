import { BRAND } from "../brand.js";

// PDF metadata (spec section 9): Producer and Creator "PatternNifty" (BRAND). PdfDocument.js (copied unchanged from
// RS) writes no Info dictionary, so it is added afterwards as a standard incremental update: an
// Info object, a one-entry cross-reference section and a trailer pointing back (/Prev) to the
// original one. The original bytes are kept as they are.

const latin1 = (text) => Buffer.from(text, "latin1");
const pdfString = (value) => `(${String(value).replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1")})`;

// PDF bytes (as PdfDocument.toBytes() writes them) + { title } -> PDF bytes with the Info.
export function withInfo(pdfBytes, { title } = {}) {
  const pdf = Buffer.from(pdfBytes);
  const tail = pdf.subarray(Math.max(0, pdf.length - 1024)).toString("latin1");
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)?.[1]);
  const size = Number(/\/Size (\d+)/.exec(tail.slice(tail.lastIndexOf("trailer")))?.[1]);
  const root = /\/Root (\d+ \d+ R)/.exec(tail.slice(tail.lastIndexOf("trailer")))?.[1];
  if (!Number.isInteger(prev) || !Number.isInteger(size) || !root) throw new Error("Not a PdfDocument PDF.");

  const fields = [["Producer", BRAND], ["Creator", BRAND], ...(title ? [["Title", title]] : [])];
  const object = `\n${size} 0 obj\n<< ${fields.map(([k, v]) => `/${k} ${pdfString(v)}`).join(" ")} >>\nendobj\n`;
  const objectOffset = pdf.length + 1;
  const xrefOffset = pdf.length + object.length;
  const update = object +
    `xref\n${size} 1\n${String(objectOffset).padStart(10, "0")} 00000 n \n` +
    `trailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.concat([pdf, latin1(update)]);
}
