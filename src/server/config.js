// Settings from the environment (spec section 18). Read once at start-up.

import { BW_GAPS } from "../render/bw-gaps.js";
import { BW_STYLES } from "../pipeline/prompt.js";

function positive(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

// Comma-separated Etsy listing ids -> numbers (anything else is ignored).
function listingIds(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3003),
    host: "127.0.0.1",
    // IS_FAKE=1: no provider and no strass calls; the pipeline uses the fixture layout.
    fake: env.IS_FAKE === "1",
    strassServiceUrl: (env.STRASS_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, ""),
    dataDir: "data",
    dbFile: "data/is.sqlite",
    archiveDir: "data/archive",
    deliveryDir: "data/delivery",
    tmpDir: "data/tmp",
    ipKeyFile: "data/ip-hash.key",
    turnstileSecret: env.TURNSTILE_SECRET_KEY || "",
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    listingUrl: env.IS_ETSY_LISTING_URL || "",
    // /admin, /auth/etsy and the Etsy routes: this Mac only, or this token in the x-admin-token header.
    adminToken: env.ADMIN_TOKEN || "",
    // Etsy (spec section 11). The keystring and secret are read by src/etsy/ itself.
    etsy: {
      keystring: env.ETSY_KEYSTRING || "",
      redirectUri: env.ETSY_REDIRECT_URI || "",
      listingIds: listingIds(env.IS_ETSY_LISTING_IDS),
      pollMs: positive(env.ETSY_POLL_SECONDS, 180) * 1000,
      // The connected shop (id and name) and the poller's state; the tokens are in data/etsy-tokens.enc.
      shopFile: "data/etsy-shop.json",
      stateFile: "data/etsy-poller.json"
    },
    // Design pipeline (spec section 7). The key is read here and passed only to the provider client.
    provider: {
      apiKey: env.OPENAI_API_KEY || "",
      model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
      quality: env.OPENAI_IMAGE_QUALITY || "high",
      timeoutMs: positive(env.PROVIDER_TIMEOUT_SECONDS, 300) * 1000
    },
    layoutTimeoutMs: positive(env.LAYOUT_TIMEOUT_SECONDS, 180) * 1000,
    bwThreshold: positive(env.BW_THRESHOLD, 55),
    // Black & white prompt style (exp-bw-stencil; spec 7.2): "halftone" unless BW_STYLE is "stencil".
    bwStyle: BW_STYLES.includes(env.BW_STYLE) ? env.BW_STYLE : BW_STYLES[0],
    // Hole fill after the overlap cleanup (spec 7.5): on unless IS_FILL_HOLES=0.
    fillHoles: env.IS_FILL_HOLES !== "0",
    // The service's own fill stones take their neighbours' colour too (spec 7.5; off unless
    // IS_SERVICE_FILL_NEIGHBOURS=1).
    serviceFillNeighbours: env.IS_SERVICE_FILL_NEIGHBOURS === "1",
    // Stone placement (exp-engine, docs/exp-engine.md): "concept" places every stone with the design
    // concept's engine (src/engine/); anything else keeps today's pipeline.
    engine: env.IS_ENGINE === "concept" ? "concept" : "today",
    // Black & white: the tinted view's gap rule (spec 8, step 4; tinted.js BW_GAPS, "crystal"
    // unless BW_GAP names another).
    bwGap: BW_GAPS.includes(env.BW_GAP) ? env.BW_GAP : "crystal"
  };
}
