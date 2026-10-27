import "dotenv/config";
import { loadTokens } from "../etsy/token-store.js";
import { createControlApp, loadControlConfig } from "./app.js";

// The control panel (PN-05), run by launchd as com.is.control in the repository folder:
// http://127.0.0.1:3010 (IS_CONTROL_PORT). Loopback only; the tunnel never reaches it.

const config = loadControlConfig();
const app = createControlApp({ config, loadTokens });

app.listen(config.port, config.host, () => {
  console.log(`IS control panel at http://${config.host}:${config.port}`);
});
