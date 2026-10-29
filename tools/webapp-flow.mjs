// The IS-05 flow in a browser (spec section 10): upload, prepare, working, result, try again (Black
// & white Bold, then Shaded: IS-07b), use this design, code screen, download (every state, the
// withdrawal tick box: PN-07), and the four legal pages (PN-07), linked from every screen's footer. Used by
// tools/test-webapp-browser.mjs (checks only) and tools/shoot-is05.mjs (with screenshots).
// Every response the page receives, and the page source and text of every screen, are checked for
// the words of spec section 12, and for the old brand: every screen shows the PatternNifty wordmark,
// once the buyer has a code its PN code, and never "IS" as a brand (PN-01).
import { BRAND, findOldBrand } from "./brand-words.mjs";
import { findLeaks } from "./leak-words.mjs";

const FOOTER_LINKS = ["/privacy", "/terms", "/contact", "/legal"];
// PN-07: the waiting-time notes (spec section 10).
const WAIT_PREPARE = "Your design takes a few minutes, usually 2 to 5, longer when it is busy. You can leave this page: your code brings you back.";
const WITHDRAWAL = "I agree that my download starts now and that I lose any right to withdraw from the purchase.";
const TEXT_TYPES = /^(text\/|application\/(json|javascript)|image\/svg)/;

export async function runFlow({ page, server, width, height, mobile, photo, shot = async () => {} }) {
  const leaks = [];
  const brand = [];
  const seen = [];
  let code = null;
  const responses = new Map();

  await page.send("Network.enable");
  page.on("Network.responseReceived", ({ requestId, response }) => responses.set(requestId, response));
  page.on("Network.loadingFinished", async ({ requestId }) => {
    const response = responses.get(requestId);
    if (!response || !response.url.startsWith(server.url)) return;
    seen.push(response.url);
    const where = `response ${response.url.slice(server.url.length)}`;
    for (const word of findLeaks(JSON.stringify(response.headers))) leaks.push(`${where} header: ${word}`);
    if (!TEXT_TYPES.test(response.mimeType)) return;
    try {
      const { body, base64Encoded } = await page.send("Network.getResponseBody", { requestId });
      const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      for (const word of findLeaks(text)) leaks.push(`${where}: ${word}`);
    } catch { /* body no longer kept (a navigation away); the API test reads every route itself */ }
  });

  // The page source and visible text of the current screen.
  async function checkScreen(name) {
    const { source, text } = await page.eval("({ source: document.documentElement.outerHTML, text: document.body.innerText })");
    for (const word of findLeaks(source)) leaks.push(`screen ${name} source: ${word}`);
    for (const word of findLeaks(text)) leaks.push(`screen ${name} text: ${word}`);
    for (const at of findOldBrand(source)) brand.push(`screen ${name} source: ${at}`);
    const shown = await page.eval(`(() => {
      const visible = (el) => !!el && !el.hidden && el.offsetParent !== null && el.getBoundingClientRect().right <= innerWidth;
      const mark = document.querySelector(".brand-name"), chip = document.querySelector("#code-chip");
      return { mark: visible(mark) ? mark.textContent : null, chip: visible(chip) ? chip.textContent : null };
    })()`);
    if (shown.mark !== BRAND) brand.push(`screen ${name}: wordmark ${JSON.stringify(shown.mark)}`);
    // PN-07: Privacy · Terms · Contact · Legal notice in the footer of every screen.
    const footer = await page.eval("[...document.querySelectorAll('.footer a')].filter((a) => a.offsetParent).map((a) => a.getAttribute('href')).join(' ')");
    for (const href of FOOTER_LINKS) if (!footer.split(" ").includes(href)) brand.push(`screen ${name}: no footer link ${href}`);
    if (code && shown.chip !== code) brand.push(`screen ${name}: code chip ${JSON.stringify(shown.chip)}`);
  }
  const imagesLoaded = "[...document.images].every((i) => i.complete && i.naturalWidth > 0)";
  const path = () => page.eval("location.pathname");
  async function screen(name, ready) {
    await page.waitFor(ready, { what: `${name} screen` });
    await page.eval("document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))");
    await checkScreen(name);
    await shot(name);
  }
  const setPayment = (code, state) => fetch(`${server.url}/api/test/payment/${code}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state })
  }).then((r) => r.json());
  const prepareReady = "location.pathname.endsWith('/prepare') && document.querySelector('#busy')?.hidden && document.querySelector('#canvas').width > 0 && !document.querySelector('#bg').disabled";

  await page.viewport(width, height, mobile);
  // No entry animations, so every screenshot shows the settled screen.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await page.goto(`${server.url}/`);

  // 1 Upload.
  await screen("upload", "document.querySelector('#drop') && !document.querySelector('.resume')");
  await page.click("#consent");
  await page.setFiles("#file", [photo]);

  // 2 Prepare: brightness +12, a crop, Colour. The expectation line is under the photo.
  await screen("prepare", prepareReady);
  const expect = "document.querySelector('.expect')?.textContent.includes('faces are stylised') && document.querySelector('.expect').offsetParent !== null";
  if (!(await page.eval(expect))) throw new Error("Prepare: no expectation line");
  if (!(await page.eval("document.querySelector('#bw-styles').hidden"))) throw new Error("Prepare: Black & white styles shown for Colour");
  if ((await page.eval("document.querySelector('#wait-note')?.textContent")) !== WAIT_PREPARE) throw new Error("Prepare: no waiting-time note");
  code = await page.eval("document.querySelector('#code-chip').textContent");
  if (!/^PN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code)) brand.push(`code ${code}`);
  await page.eval("(() => { const i = document.querySelector('#brightness'); i.value = 12; i.dispatchEvent(new Event('input')); })()");
  await page.click("#crop");
  await screen("prepare-crop", "document.querySelector('.crop-box') && document.querySelector('#busy').hidden");
  await page.click("#crop-done");
  await page.waitFor("!document.querySelector('.crop-box')");

  // 3 Working -> 4 Result.
  await page.click("#create");
  await screen("working", "location.pathname.endsWith('/working') && document.querySelector('#stages li.current')");
  // Running (or next): the usual time, and the leave-the-page line with the code.
  if ((await page.eval("document.querySelector('#queue').textContent")) !== "Usually 2 to 5 minutes.") throw new Error("Working: no usual time");
  if (!(await page.eval(`document.querySelector('.leave').textContent.includes(${JSON.stringify(`You can leave this page; your code is ${code}`)})`))) throw new Error("Working: no leave-the-page line");
  await screen("result", `location.pathname.includes('/result/') && document.querySelectorAll('.pane img').length === 2 && ${imagesLoaded}`);
  const first = await path();
  // Wide screens: Original and Tinted side by side, no tabs. Phone width: tabs, one view at a time.
  const shown = "[...document.querySelectorAll('#viewer .view')].filter((v) => v.offsetParent).map((v) => v.id).join(',')";
  const tabsShown = "!!document.querySelector('.view-tabs').offsetParent";
  if (mobile) {
    if (!(await page.eval(tabsShown)) || (await page.eval(shown)) !== "view-tinted") throw new Error("phone: the Tinted tab is not the one shown");
    await page.click(".view-tabs [data-tab=original]");
    await screen("result-original", `${JSON.stringify("view-original")} === ${shown} && ${imagesLoaded}`);
    await page.click(".view-tabs [data-tab=tinted]");
    await page.waitFor(`${shown} === "view-tinted"`);
  } else if ((await page.eval(tabsShown)) || (await page.eval(shown)) !== "view-original,view-tinted") {
    throw new Error("desktop: Original and Tinted are not side by side");
  }

  // The expectation line next to Try again.
  if (!(await page.eval(expect))) throw new Error("Result: no expectation line");

  // Try again: Prepare starts from the previous settings; Black & white this time, in the default
  // style (Bold), whose two examples are shown.
  await page.click("#again");
  await screen("try-again", prepareReady);
  const restored = await page.eval("({ brightness: document.querySelector('#brightness').value, left: document.querySelector('.designs-left b').textContent })");
  if (restored.brightness !== "12" || restored.left !== "2 of 3") throw new Error(`Try again did not restore the settings: ${JSON.stringify(restored)}`);
  await page.click("[data-mode=bw]");
  const pressedStyle = "document.querySelector('.bw-style[aria-pressed=true] b')?.textContent";
  await screen("prepare-bw", `!document.querySelector('#bw-styles').hidden && document.querySelectorAll('.bw-style img').length === 2 && ${imagesLoaded}`);
  if ((await page.eval(pressedStyle)) !== "Bold") throw new Error("Black & white: Bold is not the default style");
  await page.click("#create");
  await page.waitFor("location.pathname.endsWith('/working')");
  await screen("result-2", `location.pathname.includes('/result/') && location.pathname !== ${JSON.stringify(first)} && document.querySelectorAll('.thumb img').length === 2 && ${imagesLoaded}`);
  const second = await path();
  if (!(await page.eval("document.querySelector('.viewer-bar .sub').textContent.startsWith('Black & white, Bold')"))) throw new Error("Result 2 is not Black & white, Bold");

  // Try again keeps Black & white Bold; switch to Shaded.
  await page.click("#again");
  await page.waitFor(prepareReady);
  if ((await page.eval(pressedStyle)) !== "Bold" || (await page.eval("document.querySelector('#bw-styles').hidden"))) throw new Error("Try again did not keep Black & white, Bold");
  await page.click(".bw-style[data-style=halftone]");
  await screen("prepare-shaded", `${pressedStyle} === "Shaded"`);
  await page.click("#create");
  await page.waitFor("location.pathname.endsWith('/working')");
  await screen("result-3", `location.pathname.includes('/result/') && ![${JSON.stringify(first)}, ${JSON.stringify(second)}].includes(location.pathname) && document.querySelectorAll('.thumb img').length === 3 && ${imagesLoaded}`);
  if (!(await page.eval("document.querySelector('.viewer-bar .sub').textContent.startsWith('Black & white, Shaded')"))) throw new Error("Result 3 is not Black & white, Shaded");
  if (!(await page.eval(expect))) throw new Error("Result 3: no expectation line");

  // 5 Your code.
  await page.click("#use");
  await screen("code", "location.pathname.endsWith('/done') && document.querySelector('.code-big')");

  // 6 Download: not paid, ready (and the ZIP itself), expired, refunded, unknown.
  await page.click("#steps-list a[href^='/download']");
  await screen("download-unpaid", "document.querySelector('#state .notice.warn')");
  const submit = "document.querySelector('#form').requestSubmit()";
  await setPayment(code, "paid");
  await page.eval(submit);
  await screen("download-ready", "document.querySelector('#state .notice.ok') && document.querySelector('#dl')");
  // The first download asks for the withdrawal consent: no link until the box is ticked.
  if ((await page.eval("document.querySelector('#withdrawal-box')?.textContent.trim()")) !== WITHDRAWAL) throw new Error("Download: no withdrawal tick box");
  if (await page.eval("document.querySelector('#dl').hasAttribute('href') || document.querySelector('#dl').getAttribute('aria-disabled') !== 'true'")) throw new Error("Download: enabled before the tick");
  await page.click("#withdrawal");
  const href = await page.eval("document.querySelector('#dl').href");
  if (!href.endsWith("?agree=1") || (await page.eval("document.querySelector('#dl').hasAttribute('aria-disabled')"))) throw new Error(`Download: not enabled by the tick (${href})`);
  const zip = await fetch(href);
  const zipBytes = Buffer.from(await zip.arrayBuffer());
  if (zip.status !== 200 || zipBytes.subarray(0, 2).toString() !== "PK") throw new Error(`ZIP download failed: ${zip.status}`);
  // Asked once per code: checked again, the Download button is there without a tick box.
  await page.eval(submit);
  await screen("download-again", "document.querySelector('#dl')?.hasAttribute('href') && !document.querySelector('#withdrawal-box')");
  for (const state of ["expired", "refunded"]) {
    await setPayment(code, state);
    await page.eval(submit);
    await screen(`download-${state}`, `document.querySelector('#state .notice:not(.ok):not(.warn):not(.error)')?.textContent.includes(${JSON.stringify(state === "expired" ? "expired" : "refunded")})`);
  }
  await page.eval("document.querySelector('#code').value = 'PN-0000-0000'");
  await page.eval(submit);
  await screen("download-unknown", "document.querySelector('#state .notice.error')");

  // 7 The legal pages, each reached from the footer.
  for (const href of FOOTER_LINKS) {
    await page.click(`.footer a[href='${href}']`);
    await screen(href.slice(1), `location.pathname === ${JSON.stringify(href)} && document.querySelector('.prose h1') && document.querySelector('.prose .updated')?.textContent.startsWith('Last updated: ')`);
  }

  // /c/<code> resumes the session (here: chosen design -> code screen).
  await page.goto(`${server.url}/c/${code}`);
  await page.waitFor("location.pathname.endsWith('/done')", { what: "resume" });

  // Nothing wider than the screen.
  const overflow = await page.eval("document.documentElement.scrollWidth - window.innerWidth");

  return { code, leaks, brand, responses: seen.length, zipBytes: zipBytes.length, overflow };
}
