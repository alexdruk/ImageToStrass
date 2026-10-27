import "dotenv/config";
import { mkdirSync } from "node:fs";
import { openDatabase } from "../db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { waitForStrass } from "./health.js";

const config = loadConfig();
// The log folder (IS_LOG_DIR); launchd writes this server's output there.
mkdirSync(config.logsDir, { recursive: true });

// launchd (com.is.server) starts the server with --wait-for-strass: it waits for the strass
// service's health check, and after 5 minutes without one exits non-zero so launchd tries again.
if (process.argv.includes("--wait-for-strass")) {
  if (!(await waitForStrass({ config, fetch }))) {
    console.error(`The strass service at ${config.strassServiceUrl} was not healthy within 5 minutes.`);
    process.exit(1);
  }
}

const db = openDatabase(config.dbFile);
const app = createApp({ db, config });

// Designs that were queued when the server stopped are queued again (spec section 7).
app.locals.pipeline.recover();
// Etsy receipts -> paid codes (spec section 11.3), now and every ETSY_POLL_SECONDS.
app.locals.poller.start();

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
