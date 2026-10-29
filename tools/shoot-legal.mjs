// PN-07 screenshots for docs/legal/screens/, run by hand: the privacy, terms, contact and legal
// notice pages at 390 px in an isolated headless Chrome, on the fake server (temporary data folder).
// The fake server reads no .env, so the seller's details show "Not set": their values never go into
// the repository.
//   node tools/shoot-legal.mjs
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { launchBrowser } from "./browser-cdp.mjs";
import { startFakeServer } from "./fake-server.mjs";

const OUT = new URL("../docs/legal/screens/", import.meta.url).pathname;
const WIDTH = 390;

mkdirSync(OUT, { recursive: true });
const server = await startFakeServer();
const browser = await launchBrowser();
try {
  const { page } = browser;
  await page.viewport(WIDTH, 844, true);
  // No entry animation, so every shot shows the settled page.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const name of ["privacy", "terms", "contact", "legal"]) {
    await page.goto(`${server.url}/${name}`);
    await page.waitFor("document.querySelector('.prose .updated')");
    await page.eval("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))");
    const overflow = await page.eval("document.documentElement.scrollWidth - innerWidth");
    // Taken at 2x, stored at 1x width.
    await sharp(await page.screenshot()).resize({ width: WIDTH }).png({ compressionLevel: 9, palette: true }).toFile(`${OUT}${name}-390.png`);
    console.log(`docs/legal/screens/${name}-390.png (overflow ${overflow}px)`);
  }
} finally {
  await browser.close();
  await server.stop();
}
