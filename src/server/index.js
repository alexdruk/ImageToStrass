import "dotenv/config";
import { openDatabase } from "../db/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = openDatabase(config.dbFile);
const app = createApp({ db, config });

app.listen(config.port, () => {
  console.log(
    `ImageToStrass running at http://localhost:${config.port}` +
    (config.fake ? " (IS_FAKE=1)" : "")
  );
});
