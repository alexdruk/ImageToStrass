import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_ALPHABET,
  extractCodes,
  generateCode,
  normalizeCode,
  randomCode
} from "../src/db/codes.js";

const CODE_FORMAT = /^IS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

test("alphabet is Crockford base32 without I, L, O, U", () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(new Set(CODE_ALPHABET).size, 32);

  for (const letter of "ILOU") {
    assert.ok(!CODE_ALPHABET.includes(letter), letter);
  }
});

test("random codes have the IS-XXXX-XXXX format and use the whole alphabet", () => {
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
  const taken = new Set(["IS-0000-0000"]);

  assert.equal(generateCode((c) => taken.has(c), { randomInt }), "IS-1111-1111");
  assert.throws(() => generateCode(() => true, { maxTries: 3 }), /unique code/);
});

test("normalisation: upper-case, optional prefix, spaces and dashes", () => {
  const expected = "IS-7K3Q-9XPA";

  for (const input of [
    "IS-7K3Q-9XPA",
    "is-7k3q-9xpa",
    "IS7K3Q9XPA",
    "7K3Q9XPA",
    "7k3q-9xpa",
    " IS 7K3Q 9XPA ",
    "Is - 7K3Q - 9XPA",
    "IS_7K3Q_9XPA"
  ]) {
    assert.equal(normalizeCode(input), expected, input);
  }
});

test("normalisation: O→0, I→1, L→1 (ambiguous letters)", () => {
  assert.equal(normalizeCode("IS-O0O0-0000"), "IS-0000-0000");
  assert.equal(normalizeCode("IS-I1I1-1111"), "IS-1111-1111");
  assert.equal(normalizeCode("IS-L1L1-1111"), "IS-1111-1111");
  assert.equal(normalizeCode("is-oil0-lio1"), "IS-0110-1101");
  assert.equal(normalizeCode("IS-7K3Q-9XPO"), "IS-7K3Q-9XP0");
  // A bare body that starts with "IS" is a code whose first symbol is I → 1.
  assert.equal(normalizeCode("IS3Q9XPA"), "IS-1S3Q-9XPA");
});

test("normalisation rejects non-codes", () => {
  for (const input of [
    "",
    "IS-",
    "IS-7K3Q-9XP",          // 7 symbols
    "IS-7K3Q-9XPAB",        // 9 symbols
    "IS-7K3Q-9XPU",         // U is not in the alphabet
    "IS-7K3Q-9XP!",
    "XX-7K3Q-9XPA",
    "IS:7K3Q9XPA",
    null,
    undefined,
    12345678
  ]) {
    assert.equal(normalizeCode(input), null, String(input));
  }
});

test("extractCodes finds every code in a personalization text", () => {
  assert.deepEqual(extractCodes("IS-7K3Q-9XPA"), ["IS-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("my code is: is 7k3q 9xpa thanks"), ["IS-7K3Q-9XPA"]);
  assert.deepEqual(extractCodes("IS-7K3Q-9XPO"), ["IS-7K3Q-9XP0"]);
  assert.deepEqual(
    extractCodes("IS-7K3Q-9XPA and IS_ABCD_EFGH, again is-7k3q-9xpa"),
    ["IS-7K3Q-9XPA", "IS-ABCD-EFGH"]
  );
  assert.deepEqual(extractCodes("IS-7K3Q-9XPU"), []);
  assert.deepEqual(extractCodes("no code here"), []);
  assert.deepEqual(extractCodes(undefined), []);
});
