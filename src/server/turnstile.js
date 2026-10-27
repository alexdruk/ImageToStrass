import crypto from "node:crypto";

// Cloudflare Turnstile check (spec section 13). Without TURNSTILE_SECRET_KEY the check is
// skipped (local development); the server says so once at start-up. A token is good for one
// request: siteverify refuses a token it has seen, and this server also remembers the tokens it
// accepted (a token lives 300 s; they are kept 10 minutes) and refuses them without a call.
// Cloudflare's documented test secret keys accept the same dummy token every time, so with those
// only siteverify decides.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const USED_KEEP_MS = 10 * 60 * 1000;
const TEST_SECRET = /^[123]x0{31}AA$/;

export function createTurnstile({ secret, fetch = globalThis.fetch, now = () => Date.now() }) {
  const used = new Map();
  const remember = !TEST_SECRET.test(secret ?? "");

  return async function verify(token, ip) {
    if (!secret) {
      return true;
    }

    if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
      return false;
    }

    const key = crypto.createHash("sha256").update(token).digest("hex");
    for (const [old, at] of used) {
      if (now() - at > USED_KEEP_MS) used.delete(old);
    }
    if (used.has(key)) {
      return false;
    }
    if (remember) used.set(key, now());

    try {
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        body: new URLSearchParams({ secret, response: token, remoteip: ip ?? "" }),
        signal: AbortSignal.timeout(10_000)
      });
      const body = await response.json();

      if (body?.success !== true) used.delete(key);
      return body?.success === true;
    } catch {
      used.delete(key);
      return false;
    }
  };
}
