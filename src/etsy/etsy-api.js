import "dotenv/config";
import { loadTokens, saveTokens } from "./token-store.js";
import { refreshAccessToken } from "./etsy-oauth.js";

const ETSY_API_BASE = "https://api.etsy.com/v3";

function getConfig() {
  return {
    etsyKeystring: process.env.ETSY_KEYSTRING
  };
}

export async function getAccessToken() {
  const tokens = await loadTokens();

  if (!tokens) {
    throw new Error("Etsy account is not connected.");
  }

  const expiresAt = tokens.expires_at || 0;
  const now = Math.floor(Date.now() / 1000);

  if (now < expiresAt - 60) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error("Etsy refresh token is missing.");
  }

  const refreshed = await refreshAccessToken(
    getConfig(),
    tokens.refresh_token
  );

  const updatedTokens = {
    ...tokens,
    ...refreshed,
    expires_at: now + refreshed.expires_in
  };

  await saveTokens(updatedTokens);

  return updatedTokens.access_token;
}

export async function etsyApiRequest(path, options = {}) {
  const accessToken = await getAccessToken();

  const headers = new Headers(options.headers || {});

  headers.set(
    "x-api-key",
    `${process.env.ETSY_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`
  );

  headers.set(
    "Authorization",
    `Bearer ${accessToken}`
  );

  const response = await fetch(
    `${ETSY_API_BASE}${path}`,
    {
      ...options,
      headers
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Etsy API request failed (${response.status}): ${text}`
    );
  }

  return response.json();
}