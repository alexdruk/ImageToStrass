// The IS-05 flow in a browser (spec section 10): upload, prepare, working, result, try again (Black
// & white Bold, then Shaded: IS-07b), use this design, code screen, download (every state), and the three static pages. Used by
// tools/test-webapp-browser.mjs (checks only) and tools/shoot-is05.mjs (with screenshots).
// Every response the page receives, and the page source and text of every screen, are checked for
// the words of spec section 12.
import { findLeaks } from "./leak-words.mjs";

const TEXT_TYPES = /^(text\/|application\/(json|javascript)|image\/svg)/;

export async function runFlow({ page, server, width, height, mobile, photo, shot = async () => {} }) {
  const leaks = [];
  const seen = [];
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
  const code = await page.eval("document.querySelector('#code-chip').textContent");
  await page.eval("(() => { const i = document.querySelector('#brightness'); i.value = 12; i.dispatchEvent(new Event('input')); })()");
  await page.click("#crop");
  await screen("prepare-crop", "document.querySelector('.crop-box') && document.querySelector('#busy').hidden");
  await page.click("#crop-done");
  await page.waitFor("!document.querySelector('.crop-box')");

  // 3 Working -> 4 Result.
  await page.click("#create");
  await screen("working", "location.pathname.endsWith('/working') && document.querySelector('#stages li.current')");
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
  const href = await page.eval("document.querySelector('#dl').href");
  const zip = await fetch(href);
  const zipBytes = Buffer.from(await zip.arrayBuffer());
  if (zip.status !== 200 || zipBytes.subarray(0, 2).toString() !== "PK") throw new Error(`ZIP download failed: ${zip.status}`);
  for (const state of ["expired", "refunded"]) {
    await setPayment(code, state);
    await page.eval(submit);
    await screen(`download-${state}`, `document.querySelector('#state .notice:not(.ok):not(.warn):not(.error)')?.textContent.includes(${JSON.stringify(state === "expired" ? "expired" : "refunded")})`);
  }
  await page.eval("document.querySelector('#code').value = 'IS-0000-0000'");
  await page.eval(submit);
  await screen("download-unknown", "document.querySelector('#state .notice.error')");

  // 7 Static pages.
  for (const name of ["privacy", "terms", "contact"]) {
    await page.goto(`${server.url}/${name}`);
    await screen(name, "document.querySelector('.draft-banner')");
  }

  // /c/<code> resumes the session (here: chosen design -> code screen).
  await page.goto(`${server.url}/c/${code}`);
  await page.waitFor("location.pathname.endsWith('/done')", { what: "resume" });

  // Nothing wider than the screen.
  const overflow = await page.eval("document.documentElement.scrollWidth - window.innerWidth");

  return { code, leaks, responses: seen.length, zipBytes: zipBytes.length, overflow };
}
