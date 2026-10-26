// GET /health (spec section 15): the database, the strass service and the Etsy token age.
// The answer carries only booleans and numbers, never error texts.

const STRASS_TIMEOUT_MS = 3000;

// Etsy refresh tokens last 90 days; past that the shop must be reconnected.
const ETSY_REFRESH_TOKEN_DAYS = 90;

function checkDatabase(db) {
  try {
    return { ok: db.prepare("SELECT 1 AS one").get().one === 1 };
  } catch {
    return { ok: false };
  }
}

async function checkStrass(config, fetchFn) {
  if (config.fake) {
    return { ok: true, skipped: true };
  }

  try {
    const response = await fetchFn(`${config.strassServiceUrl}/health`, {
      signal: AbortSignal.timeout(STRASS_TIMEOUT_MS)
    });
    const body = response.ok ? await response.json() : null;

    return {
      ok: body?.ok === true && body?.modelsLoaded === true,
      busy: body?.busy === true
    };
  } catch {
    return { ok: false };
  }
}

async function checkEtsy(loadTokens) {
  let tokens;

  try {
    tokens = await loadTokens();
  } catch {
    return { ok: false, connected: false };
  }

  if (!tokens?.refresh_token) {
    return { ok: false, connected: false };
  }

  // Tokens are stored with expires_at = time of issue + expires_in.
  const issuedAt = Number(tokens.expires_at) - Number(tokens.expires_in);
  const ageHours = Number.isFinite(issuedAt)
    ? Math.max(0, (Date.now() / 1000 - issuedAt) / 3600)
    : null;

  return {
    ok: ageHours !== null && ageHours < ETSY_REFRESH_TOKEN_DAYS * 24,
    connected: true,
    tokenAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10
  };
}

export async function checkHealth({ db, config, loadTokens, fetch }) {
  const [strass, etsy] = await Promise.all([
    checkStrass(config, fetch),
    checkEtsy(loadTokens)
  ]);
  const database = checkDatabase(db);

  return {
    ok: database.ok && strass.ok && etsy.ok,
    fake: config.fake,
    db: database,
    strass,
    etsy
  };
}

// launchd start (com.is.server, spec section 15): polls the strass service until it is healthy.
// Resolves true when it is (at once in fake mode), false after timeoutMs.
export async function waitForStrass({
  config, fetch, timeoutMs = 5 * 60 * 1000, intervalMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await checkStrass(config, fetch)).ok) return true;
    if (Date.now() + intervalMs > until) return false;
    await sleep(intervalMs);
  }
}
