import express from "express";
import { etsyApiRequest } from "../etsy/etsy-api.js";
import { loadShop, saveShop } from "../etsy/shop-store.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode
} from "../etsy/etsy-oauth.js";
import { loadTokens, saveTokens } from "../etsy/token-store.js";
import { createQueries } from "../db/queries.js";
import { createPipeline } from "../pipeline/design.js";
import { createBackgroundRemover } from "../prep/background.js";
import { fileIpHasher } from "./client.js";
import { checkHealth } from "./health.js";
import { designRoutes } from "./designs.js";
import { createTurnstile } from "./turnstile.js";
import { uploadRoutes } from "./upload.js";

export function createApp({ db, config, deps = {} }) {
const app = express();
const pendingAuth = new Map();
// Statements are prepared on first use, so a broken database still lets /health answer 503.
let queries = null;
const q = new Proxy({}, { get: (_target, name) => (queries ??= createQueries(db))[name] });
const background = deps.background ||
  createBackgroundRemover({ config, fetch: deps.fetch || fetch });

const pipeline = deps.pipeline || createPipeline({ q, config, fetch: deps.fetch || fetch });
const verifyTurnstile = deps.verifyTurnstile ||
  createTurnstile({ secret: config.turnstileSecret, fetch: deps.fetch || fetch });

app.disable("x-powered-by");
app.locals.background = background;
app.locals.pipeline = pipeline;

app.use(uploadRoutes({
  q,
  config,
  background,
  verifyTurnstile,
  hashIp: deps.hashIp || fileIpHasher(config.ipKeyFile)
}));

app.use(express.json({ limit: "16kb" }));
app.use(designRoutes({ pipeline, verifyTurnstile }));
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

app.get("/", (_req, res) => {
  res.send(`
    <h1>ImageToStrass</h1>
    <p>Etsy Seller App: imagetotemplate</p>
    <p><a href="/auth/etsy">Connect Etsy</a></p>
  `);
});

app.get("/auth/etsy", (_req, res) => {
  const config = {
    etsyKeystring: process.env.ETSY_KEYSTRING,
    etsyRedirectUri: process.env.ETSY_REDIRECT_URI
  };

  if (!config.etsyKeystring) {
    return res.status(500).send("ETSY_KEYSTRING is not configured.");
  }

  if (!config.etsyRedirectUri) {
    return res.status(500).send("ETSY_REDIRECT_URI is not configured.");
  }

  const auth = createAuthorizationRequest(config);

  pendingAuth.set(auth.state, {
    verifier: auth.verifier,
    createdAt: Date.now()
  });

  res.redirect(auth.url);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `Etsy authorization failed: ${error_description || error}`
    );
  }

  if (!code || !state) {
    return res.status(400).send("Missing OAuth code or state.");
  }

  const pending = pendingAuth.get(state);
  pendingAuth.delete(state);

  if (!pending) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }

  try {
    const tokens = await exchangeAuthorizationCode(
      {
        etsyKeystring: process.env.ETSY_KEYSTRING,
        etsyRedirectUri: process.env.ETSY_REDIRECT_URI
      },
      code,
      pending.verifier
    );

    await saveTokens({
      ...tokens,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in
    });

    console.log("Etsy OAuth authorization successful.");

    return res.send(`
      <h1>Etsy connected</h1>
      <p>OAuth authorization completed successfully.</p>
      <p>Etsy connection established successfully.</p>
    `);
  } catch (error) {
    console.error(error.message);
    return res.status(502).send(
      "Etsy token exchange failed. Check the server log for details."
    );
  }
});

app.get("/etsy/status", async (_req, res) => {
  try {
    const user = await etsyApiRequest("/application/users/me");

    const shop = await etsyApiRequest(
      `/application/users/${user.user_id}/shops`
    );

    await saveShop(shop);

    res.json({
      connected: true,
      user_id: user.user_id,
      shop_id: shop.shop_id,
      shop_name: shop.shop_name
    });
  } catch (error) {
    console.error("Etsy status check failed:", error.message);

    res.status(502).json({
      connected: false,
      error: "Unable to retrieve Etsy shop status."
    });
  }
});

app.get("/etsy/listings", async (req, res) => {
  const state = req.query.state || "active";
  const allowedStates = [
    "active",
    "inactive",
    "sold_out",
    "draft",
    "expired"
  ];

  const limit = Number(req.query.limit ?? 25);
  const offset = Number(req.query.offset ?? 0);

  if (
    !allowedStates.includes(state) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return res.status(400).json({
      error: "Invalid state, limit, or offset."
    });
  }

  try {
    const shop = await loadShop();

    if (!shop) {
      return res.status(409).json({
        error: "Shop information is not saved. Check Etsy connection first."
      });
    }

    const params = new URLSearchParams({
      state,
      limit: String(limit),
      offset: String(offset)
    });

    const data = await etsyApiRequest(
      `/application/shops/${shop.shop_id}/listings?${params}`
    );

    res.json({
      count: data.count,
      results: (data.results || []).map((listing) => ({
        listing_id: listing.listing_id,
        title: listing.title,
        state: listing.state,
        url: listing.url,
        quantity: listing.quantity,
        is_personalizable: listing.is_personalizable,
        is_customizable: listing.is_customizable
      }))
    });
  } catch (error) {
    console.error("Etsy listings retrieval failed:", error.message);

    res.status(502).json({
      error: "Unable to retrieve Etsy listings."
    });
  }
});

app.get("/etsy/orders", async (req, res) => {
  const limit = Number(req.query.limit ?? 25);
  const offset = Number(req.query.offset ?? 0);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return res.status(400).json({
      error: "Invalid limit or offset."
    });
  }

  try {
    const shop = await loadShop();

    if (!shop) {
      return res.status(409).json({
        error: "Shop information is not saved. Check Etsy connection first."
      });
    }

    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset)
    });

    const data = await etsyApiRequest(
      `/application/shops/${shop.shop_id}/receipts?${params}`
    );

    res.json({
      count: data.count,
      results: (data.results || []).map((receipt) => ({
        receipt_id: receipt.receipt_id,
        status: receipt.status,
        is_paid: receipt.is_paid,
        is_shipped: receipt.is_shipped,
        is_canceled: receipt.is_canceled,
        create_timestamp: receipt.create_timestamp,
        update_timestamp: receipt.update_timestamp
      }))
    });
  } catch (error) {
    console.error("Etsy orders retrieval failed:", error.message);

    res.status(502).json({
      error: "Unable to retrieve Etsy orders."
    });
  }
});


app.get("/etsy/orders/:receiptId/transactions", async (req, res) => {
  const receiptId = Number(req.params.receiptId);

  if (!Number.isSafeInteger(receiptId) || receiptId < 1) {
    return res.status(400).json({
      error: "Invalid receipt ID."
    });
  }

  try {
    const shop = await loadShop();

    if (!shop) {
      return res.status(409).json({
        error: "Shop information is not saved. Check Etsy connection first."
      });
    }

    const data = await etsyApiRequest(
      `/application/shops/${shop.shop_id}/receipts/${receiptId}/transactions`
    );

    res.json({
      receipt_id: receiptId,
      count: data.count,
      results: (data.results || []).map((transaction) => ({
        transaction_id: transaction.transaction_id,
        listing_id: transaction.listing_id,
        title: transaction.title,
        quantity: transaction.quantity,
        personalization: (transaction.variations || [])
          .filter((variation) => variation.property_id === 54)
          .map((variation) => ({
            name: variation.formatted_name,
            value: variation.formatted_value
          }))
      }))
    });
  } catch (error) {
    console.error(
      "Etsy order transactions retrieval failed:",
      error.message
    );

    res.status(502).json({
      error: "Unable to retrieve order transactions."
    });
  }
});

app.get("/etsy/listings/:listingId/personalization", async (req, res) => {
  const listingId = Number(req.params.listingId);

  if (!Number.isSafeInteger(listingId) || listingId < 1) {
    return res.status(400).json({
      error: "Invalid listing ID."
    });
  }

  try {
    const data = await etsyApiRequest(
      `/application/listings/${listingId}/personalization`
    );

    res.json({
      listing_id: listingId,
      personalization_questions: data.personalization_questions || []
    });
  } catch (error) {
    console.error("Listing personalization retrieval failed:", error.message);

    res.status(502).json({
      error: "Unable to retrieve listing personalization."
    });
  }
});


app.post("/etsy/listings/:listingId/personalization", async (req, res) => {
  const listingId = Number(req.params.listingId);
  const testListingId = 4436491091;

  if (listingId !== testListingId) {
    return res.status(403).json({
      error: "This route is restricted to the designated test listing."
    });
  }

  try {
    const shop = await loadShop();

    if (!shop) {
      return res.status(409).json({
        error: "Shop information is not saved."
      });
    }

    const result = await etsyApiRequest(
      `/application/shops/${shop.shop_id}/listings/${listingId}/personalization`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          personalization_questions: [
            {
              question_text: "Design ID",
              instructions: "Enter the Design ID shown after accepting your design.",
              question_type: "text_input",
              required: true,
              max_allowed_characters: 50
            }
          ]
        })
      }
    );

    res.status(201).json(result);
  } catch (error) {
    console.error("Personalization configuration failed:", error.message);

    res.status(502).json({
      error: "Unable to configure listing personalization."
    });
  }
});


return app;
}