import express from "express";
import "dotenv/config";
import { etsyApiRequest } from "./etsy-api.js";
import { loadShop, saveShop } from "./shop-store.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode
} from "./etsy-oauth.js";
import { saveTokens } from "./token-store.js";

const app = express();
const PORT = Number(process.env.PORT || 3003);

const pendingAuth = new Map();

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
    return res.status(400).send(
      "Missing OAuth code or state."
    );
  }

  const pending = pendingAuth.get(state);
  pendingAuth.delete(state);

  if (!pending) {
    return res.status(400).send(
      "Invalid or expired OAuth state."
    );
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
	  <p>Etsy connection established successfully.</p>    `);
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

app.listen(PORT, () => {
  console.log(
    `ImageToStrass running at http://localhost:${PORT}`
  );
});