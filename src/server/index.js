import "dotenv/config";
import { openDatabase } from "../db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDatabase(config.dbFile);
const app = createApp({ db, config });

// Designs that were queued when the server stopped are queued again (spec section 7).
app.locals.pipeline.recover();

if (!config.turnstileSecret) {
  console.warn("TURNSTILE_SECRET_KEY is not set: uploads are not checked by Turnstile.");
}

// Loopback only: cloudflared reaches the server at http://127.0.0.1:3003 (spec section 15).
app.listen(config.port, config.host, () => {
  console.log(
    `ImageToStrass running at http://${config.host}:${config.port}` +
    (config.fake ? " (IS_FAKE=1)" : "")
  );
});
