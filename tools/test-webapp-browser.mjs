import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CHROME, launchBrowser } from "./browser-cdp.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { runFlow } from "./webapp-flow.mjs";

// IS-05 "Done when": the full flow runs in fake mode in a desktop and a 390 px-wide browser, and no
// screen, response or page source contains the words of spec section 12. An isolated headless
// Chrome with a throw-away profile, started and stopped by this test only.

const PHOTO = new URL("../services/strass/tests/fixtures/photos/cat.jpg", import.meta.url).pathname;
const WIDTHS = [
  { name: "desktop", width: 1280, height: 860, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true }
];

for (const w of WIDTHS) {
  test(`full flow in fake mode, ${w.name} (${w.width} px)`, { skip: !existsSync(CHROME) && "Chrome not found", timeout: 180_000 }, async () => {
    // Each pipeline stage stays busy a moment so the Working screen is really shown.
    const server = await startFakeServer({ stageMs: 600 });
    const browser = await launchBrowser();
    try {
      const result = await runFlow({ page: browser.page, server, ...w, photo: PHOTO });
      assert.deepEqual(result.leaks, []);
      assert.ok(result.responses > 20, "responses were checked");
      assert.equal(result.overflow, 0, "nothing is wider than the screen");
      assert.ok(result.zipBytes > 100_000);
      assert.equal(server.q.getCode(result.code).downloads, 1);
    } finally {
      await browser.close();
      await server.stop();
    }
  });
}
