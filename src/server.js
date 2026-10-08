import express from "express";
import "dotenv/config";
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
app.listen(PORT, () => {
  console.log(
    `ImageToStrass running at http://localhost:${PORT}`
  );
});