// The words of spec section 12's check: no HTTP response, header, page or file the buyer gets may
// contain them. The model name and the first 40 characters of both prompt variants come from the
// code, so the list follows any change there. Matching is case-insensitive.
import { buildPrompt } from "../src/pipeline/prompt.js";
import { loadConfig } from "../src/server/config.js";

export function leakWords(env = process.env) {
  const model = loadConfig(env).provider.model;
  return [
    "openai", "gpt", "dall", "prompt", model,
    buildPrompt({ mode: "colour" }).slice(0, 40),
    buildPrompt({ mode: "bw" }).slice(0, 40)
  ].filter((word, i, all) => word && all.indexOf(word) === i);
}

// The words found in text (each once), or [].
export function findLeaks(text, words = leakWords()) {
  const lower = String(text).toLowerCase();
  return words.filter((word) => lower.includes(word.toLowerCase()));
}
