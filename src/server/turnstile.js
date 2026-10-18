// Cloudflare Turnstile check (spec section 13). Without TURNSTILE_SECRET_KEY the check is
// skipped (local development); the server says so once at start-up.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstile({ secret, fetch = globalThis.fetch }) {
  return async function verify(token, ip) {
    if (!secret) {
      return true;
    }

    if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
      return false;
    }

    try {
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        body: new URLSearchParams({ secret, response: token, remoteip: ip ?? "" }),
        signal: AbortSignal.timeout(10_000)
      });
      const body = await response.json();

      return body?.success === true;
    } catch {
      return false;
    }
  };
}
