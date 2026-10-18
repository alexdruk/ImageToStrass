// Settings from the environment (spec section 18). Read once at start-up.

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
    turnstileSecret: env.TURNSTILE_SECRET_KEY || ""
  };
}
