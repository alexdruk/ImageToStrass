// PN-01: everything a buyer can see, download or read says PatternNifty. "IS" is the internal project
// name only; as a brand it is the standalone, upper-case word: "IS design", "Made with IS",
// "IS-XXXX-XXXX", "IS · PREVIEW", "%%Creator: IS", "/Producer (IS)". Words that only contain it
// ("THIS", "IS_FAKE", "ISO") and the English "is" are not the brand.

export { BRAND } from "../src/brand.js";
const OLD_BRAND = /(?<![A-Za-z0-9_])IS(?![A-Za-z0-9_])/g;

// Each place in text where the old brand stands, with a little context, or [].
export function findOldBrand(text) {
  const raw = String(text);
  return [...raw.matchAll(OLD_BRAND)].map((m) => JSON.stringify(raw.slice(Math.max(0, m.index - 20), m.index + 22)));
}
