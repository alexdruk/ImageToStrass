import { randomToken, createPkcePair } from "./crypto.js";

const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

export const ETSY_SCOPES = [
  "shops_r",
  "listings_r",
  "listings_w",
  "transactions_r"
];

export function createAuthorizationRequest(config) {
  const state = randomToken(32);
  const { verifier, challenge } = createPkcePair();

  const url = new URL(ETSY_AUTHORIZE_URL);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.etsyKeystring);
  url.searchParams.set("redirect_uri", config.etsyRedirectUri);
  url.searchParams.set("scope", ETSY_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    url: url.toString(),
    state,
    verifier
  };
}

export async function exchangeAuthorizationCode(config, code, verifier) {
  const body = new URLSearchParams();

  body.set("grant_type", "authorization_code");
  body.set("client_id", config.etsyKeystring);
  body.set("redirect_uri", config.etsyRedirectUri);
  body.set("code", code);
  body.set("code_verifier", verifier);

  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Etsy token exchange failed (${response.status}): ${
        data.error_description || data.error || "Unknown error"
      }`
    );
  }

  return data;
}

export async function refreshAccessToken(config, refreshToken) {
  const body = new URLSearchParams();

  body.set("grant_type", "refresh_token");
  body.set("client_id", config.etsyKeystring);
  body.set("refresh_token", refreshToken);

  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Etsy token refresh failed (${response.status}): ${
        data.error_description || data.error || "Unknown error"
      }`
    );
  }

  return data;
}