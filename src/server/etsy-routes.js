import express from "express";
import { etsyApiRequest } from "../etsy/etsy-api.js";
import { createAuthorizationRequest, exchangeAuthorizationCode } from "../etsy/etsy-oauth.js";
import { loadShop, saveShop } from "../etsy/shop-store.js";
import { saveTokens } from "../etsy/token-store.js";
import { adminOnly, isAdmin } from "./admin-access.js";

// Connecting the Etsy shop (spec section 11.2) and the Etsy read routes kept from before IS-06.
// /auth/etsy and /etsy/* answer only on this Mac or with ADMIN_TOKEN (admin-access.js).
//
// /oauth/callback is where Etsy sends the browser back, through the tunnel (its address must be
// public), so it cannot carry the admin header. It is accepted from an admin, or with the state of
// an authorization that an admin started at /auth/etsy in the last 10 minutes (random, used once,
// and tied to the PKCE verifier only this server holds). Anything else gets the plain 404.

const PENDING_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

// deps (tests): exchange, saveTokens, request, saveShop, loadShop replace the real Etsy calls.
export function etsyRoutes({ config, deps = {}, log = console }) {
  const router = express.Router();
  const exchange = deps.exchange || exchangeAuthorizationCode;
  const storeTokens = deps.saveTokens || saveTokens;
  const request = deps.request || etsyApiRequest;
  const storeShop = deps.saveShop || ((shop) => saveShop(shop, config.etsy.shopFile));
  const readShop = deps.loadShop || (() => loadShop(config.etsy.shopFile));
  const pendingAuth = new Map();
  const admin = adminOnly(config);
  const oauthConfig = () => ({ etsyKeystring: config.etsy.keystring, etsyRedirectUri: config.etsy.redirectUri });

  function takePending(state) {
    const now = Date.now();
    for (const [key, value] of pendingAuth) if (now - value.createdAt > PENDING_MS) pendingAuth.delete(key);
    const pending = typeof state === "string" ? pendingAuth.get(state) : null;
    if (pending) pendingAuth.delete(state);
    return pending ?? null;
  }

  // The shop of the connected account, saved to data/etsy-shop.json for the poller.
  async function connectedShop() {
    const user = await request("/application/users/me");
    const shop = await request(`/application/users/${user.user_id}/shops`);
    await storeShop(shop);
    return { user, shop };
  }

  router.get("/auth/etsy", admin, (_req, res) => {
    const settings = oauthConfig();
    if (!settings.etsyKeystring) return res.status(500).send("ETSY_KEYSTRING is not configured.");
    if (!settings.etsyRedirectUri) return res.status(500).send("ETSY_REDIRECT_URI is not configured.");

    const auth = createAuthorizationRequest(settings);
    if (pendingAuth.size >= MAX_PENDING) pendingAuth.delete(pendingAuth.keys().next().value);
    pendingAuth.set(auth.state, { verifier: auth.verifier, createdAt: Date.now() });
    res.redirect(auth.url);
  });

  router.get("/oauth/callback", async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    const pending = takePending(state);

    if (!pending && !isAdmin(req, config)) return res.status(404).json({ error: "not-found" });
    // Plain text, so nothing from the query can become markup.
    res.set("Cache-Control", "no-store").type("text/plain");
    if (error) return res.status(400).send(`Etsy authorization failed: ${String(description || error).slice(0, 200)}`);
    if (!code || !state) return res.status(400).send("Missing OAuth code or state.");
    if (!pending) return res.status(400).send("Invalid or expired OAuth state.");

    try {
      const tokens = await exchange(oauthConfig(), String(code), pending.verifier);
      await storeTokens({ ...tokens, expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in });
      const { shop } = await connectedShop();
      log.log("Etsy OAuth authorization successful.");
      return res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Etsy connected</title>
        <h1>Etsy connected</h1>
        <p>Shop connected: ${String(shop.shop_name || "").replace(/[^\w .-]/g, "")}. You can close this tab;
        the admin page on the Mac (http://127.0.0.1:${config.port}/admin) shows the poller.</p>`);
    } catch (failure) {
      log.error(`Etsy connect failed: ${failure.message}`);
      return res.status(502).send("Etsy token exchange failed. Check the server log for details.");
    }
  });

  router.use("/etsy", admin);

  router.get("/etsy/status", async (_req, res) => {
    try {
      const { user, shop } = await connectedShop();
      res.json({ connected: true, user_id: user.user_id, shop_id: shop.shop_id, shop_name: shop.shop_name });
    } catch (failure) {
      log.error(`Etsy status check failed: ${failure.message}`);
      res.status(502).json({ connected: false, error: "Unable to retrieve Etsy shop status." });
    }
  });

  router.get("/etsy/listings", async (req, res) => {
    const state = req.query.state || "active";
    const limit = Number(req.query.limit ?? 25);
    const offset = Number(req.query.offset ?? 0);
    if (!["active", "inactive", "sold_out", "draft", "expired"].includes(state) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: "Invalid state, limit, or offset." });
    }

    try {
      const shop = await readShop();
      if (!shop) return res.status(409).json({ error: "Shop information is not saved. Check Etsy connection first." });
      const params = new URLSearchParams({ state, limit: String(limit), offset: String(offset) });
      const data = await request(`/application/shops/${shop.shop_id}/listings?${params}`);
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
    } catch (failure) {
      log.error(`Etsy listings retrieval failed: ${failure.message}`);
      res.status(502).json({ error: "Unable to retrieve Etsy listings." });
    }
  });

  router.get("/etsy/listings/:listingId/personalization", async (req, res) => {
    const listingId = Number(req.params.listingId);
    if (!Number.isSafeInteger(listingId) || listingId < 1) return res.status(400).json({ error: "Invalid listing ID." });

    try {
      const data = await request(`/application/listings/${listingId}/personalization`);
      res.json({ listing_id: listingId, personalization_questions: data.personalization_questions || [] });
    } catch (failure) {
      log.error(`Listing personalization retrieval failed: ${failure.message}`);
      res.status(502).json({ error: "Unable to retrieve listing personalization." });
    }
  });

  return router;
}
