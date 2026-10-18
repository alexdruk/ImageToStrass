import assert from "node:assert/strict";
import { test } from "node:test";
import * as crypto from "../src/etsy/crypto.js";
import * as api from "../src/etsy/etsy-api.js";
import * as oauth from "../src/etsy/etsy-oauth.js";
import * as shopStore from "../src/etsy/shop-store.js";
import * as tokenStore from "../src/etsy/token-store.js";

test("the Etsy modules in src/etsy/ keep their exports", () => {
  assert.deepEqual(Object.keys(crypto).sort(), ["createPkcePair", "randomToken"]);
  assert.deepEqual(Object.keys(api).sort(), ["etsyApiRequest", "getAccessToken"]);
  assert.deepEqual(
    Object.keys(oauth).sort(),
    ["ETSY_SCOPES", "createAuthorizationRequest", "exchangeAuthorizationCode", "refreshAccessToken"]
  );
  assert.deepEqual(Object.keys(shopStore).sort(), ["loadShop", "saveShop"]);
  assert.deepEqual(Object.keys(tokenStore).sort(), ["loadTokens", "saveTokens"]);
});

test("the scopes include transactions_r for the poller", () => {
  assert.deepEqual(oauth.ETSY_SCOPES, ["shops_r", "listings_r", "listings_w", "transactions_r"]);
});

test("the authorization request is a PKCE S256 request to Etsy", () => {
  const auth = oauth.createAuthorizationRequest({
    etsyKeystring: "key",
    etsyRedirectUri: "https://example.trycloudflare.com/oauth/callback"
  });
  const url = new URL(auth.url);

  assert.equal(url.origin + url.pathname, "https://www.etsy.com/oauth/connect");
  assert.equal(url.searchParams.get("client_id"), "key");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.trycloudflare.com/oauth/callback");
  assert.equal(url.searchParams.get("scope"), "shops_r listings_r listings_w transactions_r");
  assert.equal(url.searchParams.get("state"), auth.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(auth.verifier.length >= 43);
});
