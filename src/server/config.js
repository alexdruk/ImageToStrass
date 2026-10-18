// Settings from the environment (spec section 18). Read once at start-up.

function positive(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3003),
    host: "127.0.0.1",
    // IS_FAKE=1: no provider and no strass calls; the pipeline uses the fixture layout.
    fake: env.IS_FAKE === "1",
    strassServiceUrl: (env.STRASS_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, ""),
    dbFile: "data/is.sqlite",
    archiveDir: "data/archive",
    tmpDir: "data/tmp",
    ipKeyFile: "data/ip-hash.key",
    turnstileSecret: env.TURNSTILE_SECRET_KEY || "",
    // Design pipeline (spec section 7). The key is read here and passed only to the provider client.
    provider: {
      apiKey: env.OPENAI_API_KEY || "",
      model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
      quality: env.OPENAI_IMAGE_QUALITY || "high",
      timeoutMs: positive(env.PROVIDER_TIMEOUT_SECONDS, 300) * 1000
    },
    layoutTimeoutMs: positive(env.LAYOUT_TIMEOUT_SECONDS, 180) * 1000,
    bwThreshold: positive(env.BW_THRESHOLD, 55)
  };
}
