
import express from "express";
import { createDesign, getDesign } from "./design-store.js";
import { MONOGRAM_FRAMES } from "./monogram-frames.js";
import "dotenv/config";
import { etsyApiRequest } from "./etsy-api.js";
import { loadShop, saveShop } from "./shop-store.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode
} from "./etsy-oauth.js";
import { saveTokens } from "./token-store.js";

const app = express();

app.use(express.json({ limit: "16kb" }));
app.use(express.static("public"));
const PORT = Number(process.env.PORT || 3003);
const pendingAuth = new Map();

app.get("/", (_req, res) => {
  res.send(`
    <h1>ImageToStrass</h1>
    <p>Etsy Seller App: imagetotemplate</p>
    <p><a href="/auth/etsy">Connect Etsy</a></p>
      <p><a href="/customizer">Create a monogram</a></p>
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


// ETSY-006 CUSTOMIZER ROUTES

app.get("/customizer", (_req, res) => {
  res.sendFile("customizer.html", { root: "public" });
});

app.get("/api/frames", (_req, res) => {
  res.json({ count: MONOGRAM_FRAMES.length, results: MONOGRAM_FRAMES });
});

app.post("/api/designs", async (req, res) => {
  const body = req.body || {};
  const language = body.language;
  const letters = typeof body.letters === "string"
    ? body.letters.normalize("NFC").trim().toUpperCase()
    : "";
  const frameId = body.frameId;

  if (!["en", "fr", "de", "es", "it"].includes(language)) {
    return res.status(400).json({ error: "Invalid language." });
  }

  if (!/^\p{L}{1,3}$/u.test(letters)) {
    return res.status(400).json({
      error: "Enter between 1 and 3 letters only."
    });
  }

  if (!MONOGRAM_FRAMES.some((frame) => frame.id === frameId)) {
    return res.status(400).json({ error: "Invalid frame selection." });
  }

  try {
    const design = await createDesign({ language, letters, frameId });
    return res.status(201).json(design);
  } catch (error) {
    console.error("Design save failed:", error.message);
    return res.status(500).json({ error: "Unable to save design." });
  }
});

app.get("/api/designs/:designId", async (req, res) => {
  try {
    const design = await getDesign(req.params.designId);

    if (!design) {
      return res.status(404).json({ error: "Design not found." });
    }

    return res.json(design);
  } catch (error) {
    console.error("Design retrieval failed:", error.message);
    return res.status(500).json({ error: "Unable to retrieve design." });
  }
});

app.listen(PORT, () => {
  console.log(`ImageToStrass running at http://localhost:${PORT}`);
});