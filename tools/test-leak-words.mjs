import assert from "node:assert/strict";
import { test } from "node:test";
import { findLeaks, leakWords, looksRandom } from "./leak-words.mjs";

// Spec section 12's word check: random tokens (codes, nonces, ETags, ids) can spell a word by
// chance and must not fail the check; the words themselves still must.

test("leak words: a random token that happens to contain a word is not a leak", () => {
  const headers = JSON.stringify([
    ["content-disposition", 'attachment; filename="PN-7GPT-K2M9.zip"'],
    ["etag", 'W/"4a1-Q7xkGpT9vL2mN8rB4sW1aZ"'],
    ["content-security-policy", "script-src 'nonce-b3Rk0gptX9aLq2Wm7Z' 'self'"],
    ["x-request-id", "dALl7Hq2-9xKprOmPt4QzR1"]
  ]);
  assert.deepEqual(findLeaks(headers), []);
  assert.deepEqual(findLeaks("/c/PN-GPTQ-DA11/result/1"), []);
  assert.deepEqual(findLeaks('<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-xgpt4_response">'), []);
  assert.equal(looksRandom("Q7xkGpT9vL2mN8rB4sW1aZ"), true);
});

test("leak words: the words themselves still fail, in text, header names and model-like names", () => {
  const words = leakWords({});
  for (const [text, want] of [
    ["made with OpenAI", ["openai"]],
    [JSON.stringify([["x-openai-request-id", "abc"]]), ["openai"]],
    ["ChatGPT-4o", ["gpt"]],
    ["chatgpt4turbo", ["gpt"]],
    ["dall-e-3", ["dall"]],
    ["the prompt was", ["prompt"]],
    ["model: gpt-image-2.5-sunburst", ["gpt", "gpt-image-2.5-sunburst"]]
  ]) assert.deepEqual(findLeaks(text, words), want, text);
  // A word next to a random token is still found.
  assert.deepEqual(findLeaks("Q7xkGpT9vL2mN8rB4sW1aZ gpt", words), ["gpt"]);
  assert.equal(looksRandom("x-openai-request-id"), false);
});
