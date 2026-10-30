import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BRAND } from "./brand-words.mjs";
import { CHROME, launchBrowser } from "./browser-cdp.mjs";
import { etsyMock } from "./etsy-mock.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { findLeaks } from "./leak-words.mjs";

// PN-08 follow-up (spec section 10): a buyer who bought first works on a prepaid code with the steps
// 1 Upload, 2 Prepare, 3 Design, 4 Download, and no screen ever mentions ordering on Etsy or
// entering a code there; the header shows the code. A new visitor's home screen is unchanged. In
// fake mode (IS_FAKE=1, Etsy mocked) in an isolated headless Chrome with a throw-away profile,
// started and stopped by this test only, at desktop and 390 px width.

const PHOTO = new URL("../services/strass/tests/fixtures/photos/cat.jpg", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/etsy/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const RECEIPT = read("shop-receipts.json").results[0];
const SHOP = read("shop.json");
const IS_LISTING = 1850000001;
const WIDTHS = [
  { name: "desktop", width: 1280, height: 860, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true }
];

const OPEN_STEPS = "Upload,Prepare,Design,Result,Your code";
const PREPAID_STEPS = "Upload,Prepare,Design,Download";
// The Etsy step's texts: ordering or checking out on Etsy, the Personalization field, pasting or
// entering a code there, "Get your code", "only buy if", and the links for buyers without a code.
const ETSY_STEP = [
  /personali[sz]ation/i, /check(ing)? ?out/i, /\bpaste\b/i, /code on Etsy/i, /Get your code/i,
  /only buy/i, /Open the Etsy listing/i, /Already bought on Etsy/i, /without a code/i, /Order within/i
];

// Runs in every new document: on each change of the page, the visible text and the step indicator
// are checked, so a text shown only for a moment is caught too.
const WATCH = `(() => {
  const bad = [${ETSY_STEP.map(String).join(", ")}];
  const seen = new Set();
  window.__etsySeen = seen;
  const check = () => {
    const where = location.pathname;
    if (where.startsWith("/order")) return;
    const text = document.body ? document.body.innerText : "";
    for (const re of bad) if (re.test(text)) seen.add(where + ": " + re);
    const steps = document.getElementById("steps");
    if (steps && !steps.hidden) {
      const labels = [...steps.querySelectorAll(".label")].map((l) => l.textContent).join(",");
      if (labels !== ${JSON.stringify(PREPAID_STEPS)}) seen.add(where + ": steps " + labels);
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  });
})();`;

for (const w of WIDTHS) {
  test(`prepaid flow, ${w.name} (${w.width} px): steps Upload, Prepare, Design, Download; never the Etsy step`, { skip: !existsSync(CHROME) && "Chrome not found", timeout: 180_000 }, async () => {
    const at = Math.floor(Date.now() / 1000) - 60;
    const receipt = {
      ...RECEIPT, receipt_id: 3820000001, status: "Paid", refunds: [], is_paid: true,
      create_timestamp: at, created_timestamp: at, update_timestamp: at, updated_timestamp: at,
      transactions: [{ ...RECEIPT.transactions[0], transaction_id: 4820000001, receipt_id: 3820000001, listing_id: IS_LISTING, quantity: 1, paid_timestamp: at, variations: [] }]
    };
    const mock = etsyMock({ shop: SHOP, receipts: () => [receipt] });
    const server = await startFakeServer({
      stageMs: 300,
      env: { IS_ETSY_LISTING_IDS: String(IS_LISTING) },
      deps: { request: mock.request, loadShop: async () => SHOP }
    });
    const browser = await launchBrowser();
    const { page } = browser;
    const problems = [];
    try {
      assert.equal((await server.app.locals.poller.runOnce()).ok, true);
      await page.viewport(w.width, w.height, w.mobile);
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

      const steps = () => page.eval(`(() => { const s = document.getElementById("steps"); return s.hidden ? null : {
        labels: [...s.querySelectorAll(".label")].map((l) => l.textContent).join(","),
        current: s.querySelector("li.current .label")?.textContent ?? null }; })()`);
      let code = null;
      // The watcher's findings live in the document: kept before each new one.
      const collect = async () => problems.push(...await page.eval("[...(window.__etsySeen || [])]"));
      const reload = async (url) => { await collect(); await page.goto(url); };
      // Each screen of the prepaid flow: its step, the code in the header, no provider words, nothing
      // wider than the screen.
      async function screen(name, ready, current) {
        await page.waitFor(ready, { what: `${name} screen` });
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const s = await steps();
        if (s?.labels !== PREPAID_STEPS || s.current !== current) problems.push(`${name}: steps ${JSON.stringify(s)}, expected ${current} current`);
        const shown = await page.eval(`(() => { const c = document.querySelector("#code-chip"), m = document.querySelector(".brand-name");
          const visible = (el) => !!el && !el.hidden && el.offsetParent !== null && el.getBoundingClientRect().right <= innerWidth;
          return { chip: visible(c) ? c.textContent : null, mark: visible(m) ? m.textContent : null,
            overflow: document.documentElement.scrollWidth - innerWidth,
            source: document.documentElement.outerHTML, text: document.body.innerText }; })()`);
        if (shown.chip !== code) problems.push(`${name}: header code ${JSON.stringify(shown.chip)}`);
        if (shown.mark !== BRAND) problems.push(`${name}: wordmark ${JSON.stringify(shown.mark)}`);
        if (shown.overflow > 0) problems.push(`${name}: ${shown.overflow} px wider than the screen`);
        for (const word of [...findLeaks(shown.source), ...findLeaks(shown.text)]) problems.push(`${name}: leak ${word}`);
      }

      // A new visitor's home screen stays as it was: five steps, the Etsy steps, the order link.
      await page.goto(`${server.url}/`);
      await page.waitFor("document.querySelector('#drop')", { what: "home" });
      assert.deepEqual(await steps(), { labels: OPEN_STEPS, current: "Upload" });
      const home = await page.eval("document.querySelector('main').innerText");
      assert.match(home, /Get your code/);
      assert.match(home, /Enter your code on Etsy and check out/);
      assert.match(home, /Already bought on Etsy\? Enter your order number/);
      assert.equal(await page.eval("!!document.querySelector('#how-prepaid')"), false);

      // From here on every new document watches for the Etsy step (the order page itself is the
      // way in, and is left out).
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
      await page.goto(`${server.url}/order`);
      await page.waitFor("document.querySelector('#order')", { what: "order" });
      await page.eval(`(() => { document.querySelector('#order').value = ${JSON.stringify(String(receipt.receipt_id))}; document.querySelector('#form').requestSubmit(); })()`);
      await page.waitFor("document.querySelector('.order-codes a')", { what: "order found" });
      code = await page.eval("document.querySelector('.order-codes code').textContent");
      assert.equal(server.q.getCode(code).status, "prepaid");
      await page.click(".order-codes a");

      // 1 Upload: the prepaid steps, the prepaid how-it-works, no order link.
      await screen("upload", "location.pathname === '/' && document.querySelector('#prepaid-note')", "Upload");
      assert.equal(await page.eval("!!document.querySelector('#how-prepaid') && !document.querySelector('.order-link')"), true);
      await page.click("#consent");
      await page.setFiles("#file", [PHOTO]);

      // 2 Prepare: the expectation line says nothing about buying.
      const prepareReady = "location.pathname.endsWith('/prepare') && document.querySelector('#busy')?.hidden && document.querySelector('#canvas').width > 0 && !document.querySelector('#bg').disabled";
      await screen("prepare", prepareReady, "Prepare");
      assert.match(await page.eval("document.querySelector('.expect').textContent"), /pick the one you like\.$/);

      // 3 Design: Working, then the result.
      await page.click("#create");
      await screen("working", "location.pathname.endsWith('/working') && document.querySelector('#stages li.current')", "Design");
      await screen("result", "location.pathname.includes('/result/') && document.querySelectorAll('.pane img').length === 2 && [...document.images].every((i) => i.complete && i.naturalWidth > 0)", "Design");
      const result = await page.eval("location.pathname");
      assert.equal(await page.eval("document.querySelector('#use').textContent"), "Use this design and download");

      // A screen opened afresh (a reload, a link): the steps wait for the session, then are the prepaid ones.
      await reload(`${server.url}/c/${code}/prepare`);
      await screen("prepare-reload", prepareReady, "Prepare");
      await reload(`${server.url}${result}`);
      await screen("result-reload", "document.querySelector('#use') && document.querySelectorAll('.pane img').length === 2", "Design");

      // 4 Download: picked, paid, the files.
      await page.click("#use");
      await screen("download", "location.pathname === '/download' && document.querySelector('#state .notice.ok') && document.querySelector('#withdrawal')", "Download");
      assert.equal(await page.eval("document.querySelector('#download-lede').textContent"), "Enter your PatternNifty code to download your files.");
      assert.equal(server.q.getCode(code).status, "paid");
      await page.click("#withdrawal");
      const zip = await fetch(await page.eval("document.querySelector('#dl').href"));
      assert.equal(zip.status, 200);
      await reload(`${server.url}/download?code=${code}`);
      await screen("download-reload", "document.querySelector('#state .notice.ok') && !document.querySelector('#download-lede').hidden", "Download");

      // The watcher saw no Etsy step text on any screen, at any moment.
      await collect();
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
      await server.stop();
    }
  });
}
