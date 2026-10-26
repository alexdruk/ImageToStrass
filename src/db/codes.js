import crypto from "node:crypto";

// Codes (spec section 5): PN-XXXX-XXXX, 8 symbols of Crockford base32, 40 bits. Codes made before
// PN-01 (IS-XXXX-XXXX) stay in the database as they are but are no longer read.

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const AMBIGUOUS = { O: "0", I: "1", L: "1" };

// Personalization text may hold several codes; each match is then normalised.
const CODE_IN_TEXT = /P\s*N[\s\-_]*([0-9A-Z]{4})[\s\-_]*([0-9A-Z]{4})/gi;

function formatCode(body) {
  return `PN-${body.slice(0, 4)}-${body.slice(4)}`;
}

export function randomCode(randomInt = crypto.randomInt) {
  let body = "";

  for (let i = 0; i < 8; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  return formatCode(body);
}

// exists(code) → true when the code is already taken (checked against the codes table).
export function generateCode(exists, { randomInt, maxTries = 10 } = {}) {
  for (let i = 0; i < maxTries; i += 1) {
    const code = randomCode(randomInt);

    if (!exists(code)) {
      return code;
    }
  }

  throw new Error("Unable to allocate a unique code.");
}

// Returns the canonical "PN-XXXX-XXXX", or null when the input is not a code.
// Upper-case; O→0, I→1, L→1 on the 8 symbols; spaces, dashes and the PN prefix are optional.
export function normalizeCode(input) {
  if (typeof input !== "string") {
    return null;
  }

  let body = input.toUpperCase().replace(/[\s\-_]/g, "");

  if (body.length === 10 && body.startsWith("PN")) {
    body = body.slice(2);
  }

  if (body.length !== 8) {
    return null;
  }

  body = body.replace(/[OIL]/g, (letter) => AMBIGUOUS[letter]);

  for (const symbol of body) {
    if (!CODE_ALPHABET.includes(symbol)) {
      return null;
    }
  }

  return formatCode(body);
}

// Every distinct code found in a free text (Etsy personalization), in order of appearance.
export function extractCodes(text) {
  if (typeof text !== "string") {
    return [];
  }

  const codes = [];

  for (const match of text.matchAll(CODE_IN_TEXT)) {
    const code = normalizeCode(match[1] + match[2]);

    if (code && !codes.includes(code)) {
      codes.push(code);
    }
  }

  return codes;
}
