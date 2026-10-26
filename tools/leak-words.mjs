// The words of spec section 12's check: no HTTP response, header, page or file the buyer gets may
// contain them. The model name and the first 40 characters of every prompt variant come from the
// code, so the list follows any change there. Matching is case-insensitive.
import { BW_STYLES, buildPrompt } from "../src/pipeline/prompt.js";
import { loadConfig } from "../src/server/config.js";

export function leakWords(env = process.env) {
  const model = loadConfig(env).provider.model;
  return [
    "openai", "gpt", "dall", "prompt", model,
    buildPrompt({ mode: "colour" }).slice(0, 40),
    ...BW_STYLES.map((bwStyle) => buildPrompt({ mode: "bw", bwStyle }).slice(0, 40))
  ].filter((word, i, all) => word && all.indexOf(word) === i);
}

// The generic words: a random token the server makes (an IS code, a nonce, an ETag, an id) can
// spell them by chance. The model name and the prompt text are always matched as they are.
const GENERIC = ["openai", "gpt", "dall", "prompt"];
// Random tokens of a known form, too short for looksRandom: IS codes (spec section 5; Crockford
// base32, upper case, so "GPT" can be three of their symbols) and the ids the Turnstile widget gives
// itself (cf-chl-widget-<5 random characters>, its response field <id>_response).
const KNOWN_TOKENS = [/IS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/g, /cf-chl-widget-[A-Za-z0-9]+/g];
const RUN = /[A-Za-z0-9_-]+/g;
const RANDOM_MIN_LENGTH = 12;
const RANDOM_MIN_CHANGES = 3;

const kind = (ch) => (/[a-z]/.test(ch) ? "l" : /[A-Z]/.test(ch) ? "u" : /[0-9]/.test(ch) ? "d" : "");

// A run of letters, digits, "-" and "_" that looks random: at least RANDOM_MIN_LENGTH long and its
// characters switch between lower case, upper case and digits at least RANDOM_MIN_CHANGES times
// ("-" and "_" ignored). Words, header names and model-like names ("x-openai-request-id",
// "ChatGPT-4o") switch less; base64 and base32 tokens switch far more.
export function looksRandom(run) {
  if (run.length < RANDOM_MIN_LENGTH) return false;
  let changes = 0, last = "";
  for (const ch of run) {
    const k = kind(ch);
    if (!k) continue;
    if (last && k !== last) changes++;
    last = k;
  }
  return changes >= RANDOM_MIN_CHANGES;
}

// text with the random tokens blanked out (same length): KNOWN_TOKENS and random-looking runs.
function withoutRandomTokens(text) {
  const blank = (m) => " ".repeat(m.length);
  return KNOWN_TOKENS.reduce((t, re) => t.replace(re, blank), text).replace(RUN, (m) => (looksRandom(m) ? blank(m) : m));
}

// The words found in text (each once), or []. A generic word counts only outside random tokens.
export function findLeaks(text, words = leakWords()) {
  const raw = String(text);
  const lower = raw.toLowerCase();
  const masked = withoutRandomTokens(raw).toLowerCase();
  return words.filter((word) => (GENERIC.includes(word.toLowerCase()) ? masked : lower).includes(word.toLowerCase()));
}
