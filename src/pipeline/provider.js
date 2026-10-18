// From Rhinestone-Studio @38cd831 server/redraw/handler.mjs
// IMG-022: sends the image to the image edit endpoint. No npm dependency: Node global fetch,
// FormData and Blob. fetch and timers are injectable so tests never touch the network or wait on
// real time.
// IS (spec section 7.3): only the provider call is kept (two attempts, the safety refusal retried
// once, a timeout not retried, abort on cancel). The routes, access code, limiter and fake routes
// are not copied. The result is { png, width, height } (the output's pixel size, read from its PNG
// header) or { error: 'declined' | 'failed', detail }; `detail` is for
// the local log and events table only and never reaches the browser (spec section 12).
import { buildPrompt } from './prompt.js';

export const IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIMEOUT = Symbol('timeout');

export const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
});

function messageOf(body) {
  return body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
}

function isPngBase64(b64) {
  if (typeof b64 !== 'string' || b64.length < 12) return false;
  return Buffer.from(b64.slice(0, 12), 'base64').subarray(0, 8).equals(PNG_SIGNATURE);
}

// IMG-023 (D7): the safety-system refusal. Matched case-insensitively on error.message.
const SAFETY_SYSTEM_PATTERN = /safety system/i;

// settings: { apiKey, model, quality, timeoutMs }.
export function createProvider({ settings, fetch = globalThis.fetch, timers = DEFAULT_TIMERS, logger = console }) {
  // One request. Resolves a Response, or TIMEOUT; rejects if fetch itself rejects.
  async function attemptOnce(pngBuffer, prompt, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const form = new FormData();
      form.append('model', settings.model);
      form.append('prompt', prompt);
      form.append('image', new Blob([pngBuffer], { type: 'image/png' }), 'source.png');
      form.append('quality', settings.quality);
      // IS (spec 7.3): the provider picks the output shape from the input's.
      form.append('size', 'auto');
      form.append('background', 'transparent');
      form.append('output_format', 'png');
      form.append('n', '1');
      const timeout = new Promise((resolve) => { timer = timers.setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, settings.timeoutMs); });
      const request = fetch(IMAGE_EDITS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: form,
        signal: controller.signal
      });
      request.catch(() => {});
      return await Promise.race([request, timeout]);
    } finally {
      timers.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // Resolves null when `signal` aborted (the upstream call is aborted too, so no paid call is
  // left running for nobody), otherwise { png } or { error, detail }.
  async function redraw(pngBuffer, promptOptions, signal = new AbortController().signal) {
    const prompt = buildPrompt(promptOptions);
    let response = null;
    let body = null;
    let timedOut = false;
    for (let attempt = 1; attempt <= 2 && !signal.aborted; attempt++) {
      let outcome;
      try {
        outcome = await attemptOnce(pngBuffer, prompt, signal);
      } catch {
        outcome = null; // fetch rejected (DNS, reset, abort)
      }
      if (signal.aborted) return null;
      response = null;
      // A timed-out call is usually still running, and billed, upstream, so it is not retried.
      if (outcome === TIMEOUT) { timedOut = true; break; }
      if (outcome === null || outcome.status >= 500) continue;
      response = outcome;
      body = null;
      try { body = await response.json(); } catch { body = null; }
      if (response.status >= 400 && response.status < 500) {
        // IMG-023 (D7): every 4xx is logged with its status and message -- never the key, the
        // prompt, the image or a request header. IS: the server log lives in logs/, outside public/.
        logger.warn(`Provider answered ${response.status}: ${messageOf(body)}`);
        // A safety-system refusal is retried once, within the same two-attempt budget.
        if (SAFETY_SYSTEM_PATTERN.test(messageOf(body)) && attempt < 2) continue;
      }
      break;
    }
    if (signal.aborted) return null;
    const failed = (detail) => ({ error: 'failed', detail });
    if (timedOut) return failed('provider-timeout');
    if (!response) return failed('provider-unreachable');

    const message = messageOf(body);
    if (response.status >= 400 && response.status < 500 && SAFETY_SYSTEM_PATTERN.test(message)) return { error: 'declined', detail: 'provider-declined' };
    if (response.status === 429) return failed('provider-rate-limited');
    if (response.status === 401 || response.status === 403) return failed('provider-auth');
    if (response.status !== 200) return failed(`provider-${response.status}`);
    const b64 = body && Array.isArray(body.data) && body.data[0] ? body.data[0].b64_json : null;
    if (!isPngBase64(b64)) return failed('provider-no-image');
    const png = Buffer.from(b64, 'base64');
    // IS: the output's pixel size (IHDR width and height), when the PNG is long enough to hold them.
    const size = png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : {};
    return { png, ...size };
  }

  return { redraw };
}
