import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_ALPHABET,
  extractCodes,
  generateCode,
  normalizeCode,
  randomCode
} from "../src/db/codes.js";

const CODE_FORMAT = /^PN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

test("alphabet is Crockford base32 without I, L, O, U", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(new Set(CODE_ALPHABET).size, 32);

  for (const letter of "ILOU") {
    assert.ok(!CODE_ALPHABET.includes(letter), letter);
  }
});

test("random codes have the PN-XXXX-XXXX format and use the whole alphabet", () => {
  const seen = new Set();

  for (let i = 0; i < 2000; i += 1) {
    const code = randomCode();
    assert.match(code, CODE_FORMAT);

    for (const symbol of code.slice(3).replace("-", "")) {
      seen.add(symbol);
    }
  }

  assert.equal(seen.size, 32);
});

test("generated codes normalise to themselves", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = randomCode();
    assert.equal(normalizeCode(code), code);
  }
});

test("generateCode retries on a collision and gives up after maxTries", () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
  const randomInt = () => values.shift();
  const taken = new Set(["PN-0000-0000"]);

  assert.equal(generateCode((c) => taken.has(c), { randomInt }), "PN-1111-1111");
  assert.throws(() => generateCode(() => true, { maxTries: 3 }), /unique code/);
});

test("normalisation: upper-case, optional prefix, spaces and dashes", () => {
  const expected = "PN-7K3Q-9XPA";

  for (const input of [
    "PN-7K3Q-9XPA",
    "pn-7k3q-9xpa",
    "PN7K3Q9XPA",
    "7K3Q9XPA",
    "7k3q-9xpa",
    " PN 7K3Q 9XPA ",
    "Pn - 7K3Q - 9XPA",
    "PN_7K3Q_9XPA"
  ]) {
    assert.equal(normalizeCode(input), expected, input);
  }
});

test("normalisation: O→0, I→1, L→1 (ambiguous letters) on the 8 symbols only", () => {
  assert.equal(normalizeCode("PN-O0O0-0000"), "PN-0000-0000");
  assert.equal(normalizeCode("PN-I1I1-1111"), "PN-1111-1111");
  assert.equal(normalizeCode("PN-L1L1-1111"), "PN-1111-1111");
  assert.equal(normalizeCode("pn-oil0-lio1"), "PN-0110-1101");
  assert.equal(normalizeCode("PN-7K3Q-9XPO"), "PN-7K3Q-9XP0");
  assert.equal(normalizeCode("pn 7k3q 9xpo"), "PN-7K3Q-9XP0");
  assert.equal(normalizeCode("pn7k3q9xpa"), "PN-7K3Q-9XPA");
  // A bare body that starts with "PN" is a code whose first symbols are P and N.
  assert.equal(normalizeCode("PN3Q9XPA"), "PN-PN3Q-9XPA");
  // A bare body that starts with "IS" is a code whose first symbol is I → 1.
  assert.equal(normalizeCode("IS3Q9XPA"), "PN-1S3Q-9XPA");
});

test("normalisation rejects non-codes and the old IS- codes", () => {
  for (const input of [
    "",
    "PN-",
    "PN-7K3Q-9XP",          // 7 symbols
    "PN-7K3Q-9XPAB",        // 9 symbols
    "PN-7K3Q-9XPU",         // U is not in the alphabet
    "PN-7K3Q-9XP!",
    "XX-7K3Q-9XPA",
    "PN:7K3Q9XPA",
    "IS-7K3Q-9XPA",         // codes made before PN-01 are no longer read
    "is 7k3q 9xpa",
    null,
    undefined,
    12345678
  ]) {
    assert.equal(normalizeCode(input), null, String(input));
  }
});

test("extractCodes finds every code in a personalization text", () => {
  assert.deepEqual(extractCodes("PN-7K3Q-9XPA"), ["PN-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("my code is: pn 7k3q 9xpa thanks"), ["PN-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("PN7K3Q9XPA"), ["PN-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("P N - 7K3Q - 9XPA"), ["PN-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("PN-7K3Q-9XPO"), ["PN-7K3Q-9XP0"]);
  assert.deepEqual(extractCodes("PN-7K3Q-9XPI pn-lllL-0000"), ["PN-7K3Q-9XP1", "PN-1111-0000"]);
  assert.deepEqual(
    extractCodes("PN-7K3Q-9XPA and PN_ABCD_EFGH, again pn-7k3q-9xpa"),
    ["PN-7K3Q-9XPA", "PN-ABCD-EFGH"]
  );
  assert.deepEqual(extractCodes("PN-7K3Q-9XPU"), []);
  // Old IS- codes are no longer matched.
  assert.deepEqual(extractCodes("IS-7K3Q-9XPA"), []);
  assert.deepEqual(extractCodes("no code here"), []);
  assert.deepEqual(extractCodes(undefined), []);
});
