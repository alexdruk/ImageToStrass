import express from "express";
import { createPoller } from "../etsy/poller.js";
import { loadShop } from "../etsy/shop-store.js";
import { loadTokens } from "../etsy/token-store.js";
import { createQueries } from "../db/queries.js";
import { createPipeline } from "../pipeline/design.js";
import { createBackgroundRemover } from "../prep/background.js";
import { fileIpHasher } from "./client.js";
import { adminRoutes } from "./admin.js";
import { createDelivery } from "./delivery.js";
import { checkHealth } from "./health.js";
import { createLimits } from "./limits.js";
import { designRoutes } from "./designs.js";
import { etsyRoutes } from "./etsy-routes.js";
import { createTurnstile } from "./turnstile.js";
import { uploadRoutes } from "./upload.js";
import { webappRoutes } from "./webapp.js";
import { wwwRedirect } from "./www-redirect.js";

// deps (tests): pipeline, background, verifyTurnstile, hashIp, now, fetch, loadTokens; Etsy: request (the
// Etsy API, for the poller and the routes), exchange, saveTokens, saveShop, loadShop, poller.
export function createApp({ db, config, deps = {} }) {
const app = express();
// Statements are prepared on first use, so a broken database still lets /health answer 503.
let queries = null;
const q = new Proxy({}, { get: (_target, name) => (queries ??= createQueries(db))[name] });
const background = deps.background ||
  createBackgroundRemover({ config, fetch: deps.fetch || fetch });

const pipeline = deps.pipeline || createPipeline({ q, config, fetch: deps.fetch || fetch });
const verifyTurnstile = deps.verifyTurnstile ||
  createTurnstile({ secret: config.turnstileSecret, fetch: deps.fetch || fetch });

const delivery = createDelivery({ q, config });
// Started by index.js (tests run it by hand).
const poller = deps.poller || createPoller({
  q, delivery, config,
  getShop: deps.loadShop || (() => loadShop(config.etsy.shopFile)),
  ...(deps.request && { request: deps.request })
});

app.disable("x-powered-by");
app.locals.background = background;
app.locals.pipeline = pipeline;
app.locals.poller = poller;

app.use(wwwRedirect(config));

const hashIp = deps.hashIp || fileIpHasher(config.ipKeyFile);
// Spec 13; deps.now (tests) moves the clock.
const limits = createLimits({ q, config, ...(deps.now && { now: deps.now }) });

app.use(uploadRoutes({ q, config, background, verifyTurnstile, hashIp, limits }));

app.use(express.json({ limit: "16kb" }));
app.use(designRoutes({ q, pipeline, verifyTurnstile, limits, hashIp }));
app.use(webappRoutes({ q, config, background, delivery, poller }));
app.use(express.static("public"));

app.get("/health", async (_req, res) => {
  const health = await checkHealth({
    db,
    config,
    loadTokens: deps.loadTokens || loadTokens,
    fetch: deps.fetch || fetch
  });

  res.status(health.ok ? 200 : 503).json(health);
});

app.use(etsyRoutes({ config, deps }));
app.use(adminRoutes({ q, config, pipeline, poller, delivery, deps }));

return app;
}