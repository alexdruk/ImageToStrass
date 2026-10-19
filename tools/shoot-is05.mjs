// IS-05 screenshots for docs/IS-05-results.md, run by hand: the whole flow in fake mode (no provider
// or strass call, temporary data folder) in an isolated headless Chrome, at 1280 px and 390 px.
//   node tools/shoot-is05.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { launchBrowser } from "./browser-cdp.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { runFlow } from "./webapp-flow.mjs";

const OUT = new URL("../docs/IS-05-results/", import.meta.url).pathname;
const PHOTO = new URL("../services/strass/tests/fixtures/photos/cat.jpg", import.meta.url).pathname;
const WIDTHS = [
  { name: "desktop", width: 1280, height: 860, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true }
];

mkdirSync(OUT, { recursive: true });
// The report names no checked word: the list holds prompt text, which never goes into docs/.
const report = { runs: [] };

for (const w of WIDTHS) {
  const server = await startFakeServer({ stageMs: 2500 });
  const browser = await launchBrowser();
  const shots = [];
  try {
    const result = await runFlow({
      page: browser.page, server, ...w, photo: PHOTO,
      async shot(name) {
        const png = await browser.page.screenshot();
        const file = `${w.name}-${name}.jpg`;
        // Phone shots are taken at 2x and stored at 1x width for the document.
        await sharp(png).resize({ width: w.width }).jpeg({ quality: 82, mozjpeg: true }).toFile(`${OUT}${file}`);
        shots.push(file);
      }
    });
    report.runs.push({ ...w, code: result.code, leaks: result.leaks.length, responses: result.responses, zipBytes: result.zipBytes, overflow: result.overflow, shots });
    console.log(`${w.name}: ${shots.length} screens, ${result.responses} responses, leaks ${result.leaks.length}, overflow ${result.overflow}px`);
  } finally {
    await browser.close();
    await server.stop();
  }
}
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
