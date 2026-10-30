// PatternNifty web app (spec section 10): one page, one screen per URL (history API), no framework.
// The browser only ever sees the uploaded/prepared image, the watermarked tinted preview, stats and
// codes (CLAUDE.md). Errors are shown from the app's own error codes only (spec section 12).

import { DEFAULT_SETTINGS, applyAdjustments } from "/adjust.js";
import { PAGES, renderHtml } from "/legal.js";

const main = document.getElementById("main");
const stepsEl = document.getElementById("steps");
const chip = document.getElementById("code-chip");
const toastEl = document.getElementById("toast");

const CODE_KEY = "is.code";
const STAGES = [
  ["preparing", "Preparing image"],
  ["designing", "Designing layout"],
  ["placing", "Placing stones"],
  ["files", "Preparing files"]
];
const POLL_MS = 3000;
const DOWNLOAD_POLL_MS = 30000;
const ACCEPT = ".png,.jpg,.jpeg,.bmp,.tif,.tiff,.webp,.avif,.svg,image/png,image/jpeg,image/bmp,image/tiff,image/webp,image/avif,image/svg+xml";

const TEXTS = {
  "bad-file": "This file can't be read. Please upload a PNG, JPG, BMP, TIFF, WebP, AVIF or SVG image.",
  "too-large": "This file is larger than 50 MB. Please upload a smaller image.",
  declined: "This image can't be turned into a design. Please try another image.",
  failed: "Something went wrong while making your design. It didn't count — please try again.",
  busy: "PatternNifty is very busy, please try again in a few minutes.",
  limit: "This code has used all 3 designs. Pick one of your designs, or start again with a new image.",
  consent: "Please tick the box to agree to the privacy policy first.",
  verification: "The security check didn't pass. Please try again.",
  "not-found": "We couldn't find this code. Please check it and try again.",
  "not-ready": "The background is still being removed. Please wait a moment and try again.",
  paid: "This code is already paid, so its design can no longer be changed.",
  "bad-order": "Please enter your Etsy order number: digits only.",
  refunded: "This order was refunded.",
  deleted: "The images and designs of this code were deleted 30 days after it was last used, as our privacy policy says. Please upload your image again.",
  network: "We couldn't reach PatternNifty. Please check your connection and try again."
};
const errorText = (code) => TEXTS[code] || TEXTS.failed;

const ICON_ROTATE_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 10"/></svg>`;
const ICON_ROTATE_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L21 10"/></svg>`;
const COLOURS_SHOWN = 8;
// The two Black & white styles (spec 6.4); the first is the default.
const BW_STYLES = [
  { id: "stencil", name: "Bold", note: "Solid black and clear areas: strong and graphic.", example: "/examples/bw-bold.png" },
  { id: "halftone", name: "Shaded", note: "Black and clear stones mixed to show light and shade.", example: "/examples/bw-shaded.png" }
];
const bwStyleName = (id) => (BW_STYLES.find((st) => st.id === id) || BW_STYLES[0]).name;
// What the buyer can expect (spec 10), under the photo on Prepare and next to Try again on Result
// (the terms quote it word for word). A code made from an Etsy order is already paid (PN-08
// follow-up): nothing about buying.
const expectation = () => `Your design is an artistic rhinestone version of your photo; faces are stylised, not photographic. You can try up to ${config.designsPerCode} designs and only buy if you like one.`;
const expectationFromOrder = () => `Your design is an artistic rhinestone version of your photo; faces are stylised, not photographic. You can try up to ${config.designsPerCode} designs and pick the one you like.`;

let config = { turnstileSiteKey: null, listingUrl: null, legal: {}, designsPerCode: 3, colours: {}, sizes: {} };
let cleanup = [];

// ---------- Small helpers ----------

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function html(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? (values[i]?.__html ?? esc(values[i] ?? "")) : ""), "");
}
const raw = (text) => ({ __html: text });

function onLeave(fn) { cleanup.push(fn); }

function every(ms, fn) {
  const id = setInterval(fn, ms);
  onLeave(() => clearInterval(id));
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options });
  } catch {
    return { ok: false, status: 0, body: { error: "network" } };
  }
  let body = null;
  try { body = await response.json(); } catch { body = {}; }
  return { ok: response.ok, status: response.status, body };
}

const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function savedCode() {
  try { return localStorage.getItem(CODE_KEY); } catch { return null; }
}

function saveCode(code) {
  try { localStorage.setItem(CODE_KEY, code); } catch { /* private mode: the URL still holds it */ }
  showChip(code);
}

function showChip(code) {
  chip.hidden = !code;
  chip.textContent = code || "";
  chip.dataset.code = code || "";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  toast(`Copied ${text}`);
}

chip.addEventListener("click", () => copyText(chip.dataset.code));

// The step indicator (spec 10). A code made from an Etsy order is paid already (PN-08 follow-up), so
// its flow has no Etsy step: 1 Upload, 2 Prepare, 3 Design (the result too), 4 Download.
const FLOWS = {
  open: [["upload", "Upload"], ["prepare", "Prepare"], ["design", "Design"], ["result", "Result"], ["code", "Your code"]],
  prepaid: [["upload", "Upload"], ["prepare", "Prepare"], ["design", "Design"], ["download", "Download"]]
};
const PREPAID_STEP = { result: "design", code: "download" };
// Whether each code loaded was made from an Etsy order (its session's fromOrder).
const fromOrderCodes = new Map();
const codeKey = (code) => String(code ?? "").trim().toUpperCase();
const flowOf = (code) => (fromOrderCodes.has(codeKey(code)) ? (fromOrderCodes.get(codeKey(code)) ? "prepaid" : "open") : null);
let shownFlow = "open";

// flow: "open", "prepaid", or null while the code's session is not loaded yet (no indicator, so the
// wrong steps never show).
function setSteps(step, flow = "open") {
  stepsEl.hidden = !step || !flow;
  if (!step || !flow) return;
  if (flow !== shownFlow) {
    stepsEl.innerHTML = FLOWS[flow].map(([id, label], i) => `<li data-step="${id}"><span class="dot">${i + 1}</span><span class="label">${label}</span></li>`).join("");
    shownFlow = flow;
  }
  const order = FLOWS[flow].map(([id]) => id);
  const at = order.indexOf(flow === "prepaid" ? PREPAID_STEP[step] ?? step : step);
  for (const li of stepsEl.children) {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle("done", i < at);
    li.classList.toggle("current", i === at);
    if (i === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  }
}

function render(markup) {
  main.innerHTML = `<section class="panel">${markup}</section>`;
  return main.firstElementChild;
}

function noSave(img) {
  img.draggable = false;
  img.addEventListener("contextmenu", (event) => event.preventDefault());
}

// ---------- Turnstile (spec 13), only when a site key is set ----------

let turnstileReady = null;

function loadTurnstile() {
  turnstileReady ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = reject;
    document.head.append(script);
  });
  return turnstileReady;
}

const TOKEN_WAIT_MS = 10000;

// Renders the check into box. token() resolves to the current token, waiting up to TOKEN_WAIT_MS
// for one while the check is still running ("" when none or not configured).
function securityCheck(box) {
  if (!config.turnstileSiteKey) return { token: async () => "", reset() {} };
  let token = "";
  let widget = null;
  let waiting = [];
  const settle = () => { for (const resolve of waiting) resolve(token); waiting = []; };
  loadTurnstile().then((ts) => {
    if (!box.isConnected) return;
    widget = ts.render(box, {
      sitekey: config.turnstileSiteKey,
      callback: (t) => { token = t; settle(); },
      "expired-callback": () => { token = ""; },
      "error-callback": () => { token = ""; settle(); }
    });
    onLeave(() => ts.remove(widget));
  }).catch(settle);
  return {
    token: () => (token ? Promise.resolve(token) : new Promise((resolve) => {
      waiting.push(resolve);
      setTimeout(() => resolve(token), TOKEN_WAIT_MS);
    })),
    reset() { token = ""; if (widget !== null) window.turnstile.reset(widget); }
  };
}

// ---------- Router ----------

const ROUTES = [
  [/^\/$/, uploadScreen],
  [/^\/c\/([^/]+)\/?$/, resumeScreen],
  [/^\/c\/([^/]+)\/prepare\/?$/, prepareScreen],
  [/^\/c\/([^/]+)\/working\/?$/, workingScreen],
  [/^\/c\/([^/]+)\/result\/(\d+)\/?$/, resultScreen],
  [/^\/c\/([^/]+)\/done\/?$/, doneScreen],
  [/^\/download\/?$/, downloadScreen],
  [/^\/order\/?$/, orderScreen],
  [/^\/privacy\/?$/, () => staticPage("privacy")],
  [/^\/terms\/?$/, () => staticPage("terms")],
  [/^\/contact\/?$/, () => staticPage("contact")],
  [/^\/legal\/?$/, () => staticPage("legal")]
];

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  route();
}

async function route() {
  for (const fn of cleanup.splice(0)) fn();
  const url = new URL(location.href);
  for (const [pattern, screen] of ROUTES) {
    const match = url.pathname.match(pattern);
    if (match) {
      window.scrollTo(0, 0);
      await screen(...match.slice(1).map(decodeURIComponent), url.searchParams);
      main.focus({ preventScroll: true });
      return;
    }
  }
  navigate("/", { replace: true });
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank") return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", route);

// A code's session; on failure shows the error and returns null.
async function loadSession(code) {
  const { ok, body } = await api(`/api/codes/${encodeURIComponent(code)}`);
  if (!ok) {
    setSteps(null);
    render(html`
      <div class="card narrow center">
        <h1>${body.error === "deleted" ? "Design deleted" : "Code not found"}</h1>
        <p class="lede">${errorText(body.error)}</p>
        <div class="actions centered"><a class="btn primary" href="/" data-link>Upload an image</a></div>
      </div>`);
    return null;
  }
  saveCode(body.code);
  fromOrderCodes.set(codeKey(body.code), Boolean(body.fromOrder));
  fromOrderCodes.set(codeKey(code), Boolean(body.fromOrder));
  // A code made from an Etsy order (PN-08) whose order was refunded.
  if (body.fromOrder && body.status === "refunded") {
    setSteps(null);
    render(html`
      <div class="card narrow center" id="refunded">
        <h1>Order refunded</h1>
        <p class="lede">${TEXTS.refunded}</p>
      </div>`);
    return null;
  }
  return body;
}

// A code that can still make designs: open, or prepaid (made from an Etsy order, PN-08).
const canDesign = (s) => s.status === "open" || s.status === "prepaid";
const isPrepaid = (s) => s.status === "prepaid";

// ---------- 1 Upload ----------

async function uploadScreen() {
  const previous = savedCode();
  setSteps("upload", previous ? null : "open");
  let session = null;
  if (previous) {
    const { ok, body } = await api(`/api/codes/${encodeURIComponent(previous)}`);
    session = ok ? body : null;
  }
  showChip(session?.code);
  // Working on a prepaid code (PN-08 follow-up): no Etsy step, nothing about ordering or codes.
  const prepaid = Boolean(session && isPrepaid(session));
  setSteps("upload", prepaid ? "prepaid" : "open");
  const useCode = session && canDesign(session) && session.designsLeft > 0 ? session.code : null;
  const resume = session && (session.designs.length || session.upload);
  // A prepaid code with nothing yet (PN-08): the buyer came from the order page to upload.
  const fresh = session && isPrepaid(session) && !resume;

  const panel = render(html`
    <h1>Turn any image into a rhinestone template</h1>
    <p class="lede">Upload a photo, logo or drawing. PatternNifty lays out every stone and gives you production-ready files.</p>
    ${raw(resume ? html`
      <div class="card flat resume">
        <div><b>Welcome back.</b> Your code is <code>${session.code}</code>.</div>
        <a class="btn small" href="/c/${session.code}" data-link>Continue</a>
      </div>` : fresh ? html`
      <div class="card flat resume" id="prepaid-note">
        <div><b>Your order is paid.</b> Upload your photo to make your design with code <code>${session.code}</code>.</div>
      </div>` : "")}
    <div class="upload-grid">
      <div>
        <label class="dropzone" id="drop">
          <input type="file" id="file" accept="${ACCEPT}">
          <div>
            <svg class="drop-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="6" y="9" width="36" height="30" rx="5"/><circle cx="17" cy="19" r="3.5"/><path d="M6 33l10-9 8 7 6-5 12 10"/>
            </svg>
            <strong id="drop-title">Drop your image here</strong>
            <span class="hint">or tap to choose a file</span>
          </div>
        </label>
        <p class="sub">PNG, JPG, BMP, TIFF, WebP, AVIF or SVG · up to 50 MB</p>
        <label class="consent">
          <input type="checkbox" id="consent">
          <span>I agree to the <a href="/privacy" data-link>privacy policy</a> and confirm I have the right to use this image.</span>
        </label>
        <div class="turnstile-box" id="check"></div>
        <div class="notice error" id="error" role="alert"></div>
        ${raw(prepaid ? "" : html`<p class="sub order-link">Already bought on Etsy? <a href="/order" data-link>Enter your order number</a></p>`)}
      </div>
      ${raw(prepaid ? html`<ol class="how" id="how-prepaid">
        <li><span class="n">1</span><p><b>Upload and prepare</b>Remove the background, crop, rotate and adjust the colours.</p></li>
        <li><span class="n">2</span><p><b>See your design</b>PatternNifty shows your image and the finished stone design side by side. Not happy? Try again — up to ${config.designsPerCode} designs.</p></li>
        <li><span class="n">3</span><p><b>Pick and download</b>Choose the design you like with “Use this design and download”: SVG, production sheet (PDF), AI, EPS, DXF and PNG, at the design's natural size.</p></li>
      </ol>` : html`<ol class="how">
        <li><span class="n">1</span><p><b>Upload and prepare</b>Remove the background, crop, rotate and adjust the colours.</p></li>
        <li><span class="n">2</span><p><b>See your design</b>PatternNifty shows your image and the finished stone design side by side. Not happy? Try again — up to 3 designs.</p></li>
        <li><span class="n">3</span><p><b>Get your code</b>Enter your code on Etsy and check out. Nothing is charged before that.</p></li>
        <li><span class="n">4</span><p><b>Download</b>SVG, production sheet (PDF), AI, EPS, DXF and PNG, at the design's natural size.</p></li>
      </ol>`)}
    </div>`);

  const drop = panel.querySelector("#drop");
  const input = panel.querySelector("#file");
  const consent = panel.querySelector("#consent");
  const error = panel.querySelector("#error");
  const title = panel.querySelector("#drop-title");
  const check = securityCheck(panel.querySelector("#check"));

  async function send(file) {
    error.textContent = "";
    if (!file) return;
    if (!consent.checked) {
      error.textContent = TEXTS.consent;
      consent.focus();
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      error.textContent = TEXTS["too-large"];
      return;
    }
    drop.classList.add("busy");
    title.innerHTML = `<span class="spinner" aria-hidden="true"></span> Uploading…`;
    title.style.display = "inline-flex";
    title.style.gap = "10px";

    // A token passes the check once, so a second upload asks for a new one.
    const upload = async (code) => {
      const form = new FormData();
      form.append("consent", "1");
      form.append("cf-turnstile-response", await check.token());
      if (code) form.append("code", code);
      form.append("image", file, "upload");
      return api("/api/upload", { method: "POST", body: form });
    };
    let answer = await upload(useCode);
    // A prepaid code is never swapped for a new, unpaid one.
    if (!answer.ok && answer.body.error === "limit" && useCode && !isPrepaid(session)) {
      check.reset();
      answer = await upload(null);
    }

    if (!answer.ok) {
      drop.classList.remove("busy");
      title.textContent = "Drop your image here";
      error.textContent = errorText(answer.body.error);
      input.value = "";
      check.reset();
      return;
    }
    saveCode(answer.body.code);
    navigate(`/c/${answer.body.code}/prepare`);
  }

  input.addEventListener("change", () => send(input.files[0]));
  for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const type of ["dragleave", "drop"]) drop.addEventListener(type, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); send(e.dataTransfer.files[0]); });
}

// /c/<code> resumes the session where it stands.
async function resumeScreen(code) {
  const session = await loadSession(code);
  if (!session) return;
  const latest = session.designs[session.designs.length - 1];
  // Made from an Etsy order and picked (PN-08): its files are on the download page.
  if (session.fromOrder && !isPrepaid(session)) navigate(`/download?code=${session.code}`, { replace: true });
  else if (session.active) navigate(`/c/${session.code}/working`, { replace: true });
  else if (session.selected || !canDesign(session)) navigate(`/c/${session.code}/done`, { replace: true });
  else if (latest) navigate(`/c/${session.code}/result/${latest.attempt}`, { replace: true });
  else if (session.upload) navigate(`/c/${session.code}/prepare`, { replace: true });
  else navigate("/", { replace: true });
}

// ---------- 2 Prepare ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function rgbaOf(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width, height };
}

async function prepareScreen(code) {
  setSteps("prepare", flowOf(code));
  const session = await loadSession(code);
  if (!session) return;
  setSteps("prepare", flowOf(session.code));
  if (!session.upload) return navigate("/", { replace: true });
  if (session.active) return navigate(`/c/${session.code}/working`, { replace: true });

  const k = session.upload.upload;
  const start = session.settings || {};
  const state = {
    adjustments: { ...DEFAULT_SETTINGS, ...(start.adjustments || {}) },
    mode: start.mode || "colour",
    bwStyle: BW_STYLES.some((st) => st.id === start.bwStyle) ? start.bwStyle : BW_STYLES[0].id,
    removeBackground: start.removeBackground ?? true,
    background: session.upload.background,
    cropping: false
  };
  const left = session.designsLeft;
  const total = config.designsPerCode;
  const canCreate = canDesign(session) && left > 0;

  const panel = render(html`
    <div class="viewer-bar">
      <div><h1>Prepare your image</h1><p class="sub">The design is made from exactly what you see here.</p></div>
    </div>
    <div class="prepare">
      <div>
        <div class="stage" id="stage">
          <div class="stage-frame" id="frame"><canvas id="canvas" aria-label="Preview of your prepared image"></canvas></div>
          <div class="stage-busy" id="busy"><span class="spinner" aria-hidden="true"></span></div>
        </div>
        <div class="toolbar" id="tools">
          <button class="btn small" type="button" id="rotl" aria-label="Rotate left">${raw(ICON_ROTATE_LEFT)} Left</button>
          <button class="btn small" type="button" id="rotr" aria-label="Rotate right">${raw(ICON_ROTATE_RIGHT)} Right</button>
          <span class="sep" aria-hidden="true"></span>
          <button class="btn small" type="button" id="crop">Crop</button>
          <button class="btn small primary" type="button" id="crop-done" hidden>Done</button>
          <button class="btn small ghost" type="button" id="crop-clear" hidden>Remove crop</button>
          <span class="sep" aria-hidden="true"></span>
          <button class="btn small ghost" type="button" id="reset">Reset all</button>
          <a class="btn small ghost" href="/" data-link>Use another image</a>
        </div>
        <p class="sub expect">${session.fromOrder ? expectationFromOrder() : expectation()}</p>
      </div>
      <div class="controls">
        <div class="card">
          <div class="switch-row">
            <div><b>Remove background</b><p class="sub" id="bg-note"></p></div>
            <label class="switch"><input type="checkbox" id="bg" aria-label="Remove background"><span></span></label>
          </div>
        </div>
        <div class="card">
          <div class="control-title">Adjust</div>
          ${raw(["brightness", "contrast", "saturation"].map((name) => html`
            <div class="slider">
              <label for="${name}">${name[0].toUpperCase() + name.slice(1)}</label>
              <output id="${name}-out" for="${name}">0</output>
              <input type="range" id="${name}" min="-100" max="100" step="1" value="0">
            </div>`).join(""))}
          <div class="switch-row mt">
            <div><b>Auto enhance</b><p class="sub">Stretches the levels for more punch.</p></div>
            <label class="switch"><input type="checkbox" id="auto" aria-label="Auto enhance"><span></span></label>
          </div>
        </div>
        <div class="card">
          <div class="control-title">Stones</div>
          <div class="segmented" role="group" aria-label="Colours">
            <button type="button" data-mode="colour">Colour</button>
            <button type="button" data-mode="bw">Black &amp; white</button>
          </div>
          <p class="sub" id="mode-note"></p>
          <div class="bw-styles" id="bw-styles" role="group" aria-label="Black &amp; white style" hidden>
            ${raw(BW_STYLES.map((st) => html`
              <button type="button" class="bw-style" data-style="${st.id}">
                <img src="${st.example}" alt="" width="320" height="269">
                <b>${st.name}</b>
                <span>${st.note}</span>
              </button>`).join(""))}
          </div>
        </div>
        <div class="card">
          <div class="designs-left">
            <span>Designs left: <b>${left} of ${total}</b></span>
            <span class="pips" aria-hidden="true">${raw(Array.from({ length: total }, (_, i) => `<i class="${i < total - left ? "used" : ""}"></i>`).join(""))}</span>
          </div>
          <div class="turnstile-box" id="check"></div>
          <div class="notice error" id="error" role="alert"></div>
          <button class="btn primary block mt" type="button" id="create">Create design</button>
          <p class="sub center mt-s" id="wait-note">Your design takes a few minutes, usually 2 to 5, longer when it is busy. You can leave this page: your code brings you back.</p>
        </div>
      </div>
    </div>`);

  const $ = (sel) => panel.querySelector(sel);
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d");
  const frame = $("#frame");
  const busy = $("#busy");
  const error = $("#error");
  const bg = $("#bg");
  const bgNote = $("#bg-note");
  const create = $("#create");
  const check = securityCheck($("#check"));

  const sources = {};
  async function source(kind) {
    sources[kind] ??= loadImage(`/api/uploads/${session.code}/${k}/preview?background=${kind}`).then(rgbaOf);
    return sources[kind];
  }

  let frameRequest = 0;
  let drawn = null;
  function draw() {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(async () => {
      const kind = state.removeBackground && state.background === "ready" ? "removed" : "kept";
      let image;
      try {
        image = await source(kind);
      } catch {
        busy.hidden = true;
        error.textContent = TEXTS.failed;
        return;
      }
      const settings = state.cropping ? { ...state.adjustments, crop: null } : state.adjustments;
      const out = applyAdjustments(image, settings);
      canvas.width = out.width;
      canvas.height = out.height;
      ctx.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
      drawn = out;
      busy.hidden = true;
      placeCropBox();
    });
  }

  // Background toggle (6.2).
  function showBackground() {
    const ready = state.background === "ready";
    const failed = state.background === "failed";
    bg.disabled = !ready;
    bg.checked = ready ? state.removeBackground : !failed && state.removeBackground;
    bgNote.className = `sub${failed ? " warn" : ""}`;
    bgNote.textContent = failed
      ? "Background could not be removed automatically"
      : ready ? (state.removeBackground ? "Only your subject is turned into stones." : "The whole image is turned into stones.")
        : "Removing the background…";
    if (failed) state.removeBackground = false;
    updateCreate();
  }
  if (state.background !== "ready" && state.background !== "failed") {
    every(2000, async () => {
      if (state.background === "ready" || state.background === "failed") return;
      const { ok, body } = await api(`/api/uploads/${session.code}/${k}`);
      if (ok && body.background !== state.background) {
        state.background = body.background;
        showBackground();
        draw();
      }
    });
  }
  bg.addEventListener("change", () => {
    state.removeBackground = bg.checked;
    showBackground();
    draw();
  });

  // Sliders and auto enhance.
  for (const name of ["brightness", "contrast", "saturation"]) {
    const input = $(`#${name}`);
    const out = $(`#${name}-out`);
    const sync = () => { out.textContent = input.value > 0 ? `+${input.value}` : input.value; };
    input.value = state.adjustments[name];
    sync();
    input.addEventListener("input", () => { state.adjustments[name] = Number(input.value); sync(); draw(); });
    input.addEventListener("dblclick", () => { input.value = 0; state.adjustments[name] = 0; sync(); draw(); });
  }
  const auto = $("#auto");
  auto.checked = state.adjustments.autoEnhance;
  auto.addEventListener("change", () => { state.adjustments.autoEnhance = auto.checked; draw(); });

  // Rotate (90° steps); a crop belongs to one rotation, so it is cleared.
  const turn = (by) => {
    state.adjustments.rotate = (state.adjustments.rotate + by + 360) % 360;
    state.adjustments.crop = null;
    draw();
  };
  $("#rotl").addEventListener("click", () => turn(-90));
  $("#rotr").addEventListener("click", () => turn(90));

  // Crop: a free rectangle over the rotated image, as fractions.
  let box = null;
  let rect = null;
  function placeCropBox() {
    if (!state.cropping || !drawn) return;
    if (!box) {
      box = document.createElement("div");
      box.className = "crop-box";
      box.innerHTML = ["nw", "ne", "sw", "se"].map((h) => `<span class="crop-handle" data-h="${h}"></span>`).join("");
      frame.append(box);
      box.addEventListener("pointerdown", startDrag);
    }
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
  }
  function startDrag(event) {
    event.preventDefault();
    const handle = event.target.dataset.h || "move";
    const bounds = canvas.getBoundingClientRect();
    const from = { x: event.clientX, y: event.clientY, rect: { ...rect } };
    const min = 0.05;
    box.setPointerCapture(event.pointerId);
    const move = (e) => {
      const dx = (e.clientX - from.x) / bounds.width;
      const dy = (e.clientY - from.y) / bounds.height;
      const r = { ...from.rect };
      if (handle === "move") {
        r.x = Math.min(Math.max(0, r.x + dx), 1 - r.w);
        r.y = Math.min(Math.max(0, r.y + dy), 1 - r.h);
      } else {
        let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
        if (handle.includes("w")) x0 = Math.min(Math.max(0, x0 + dx), x1 - min);
        if (handle.includes("e")) x1 = Math.max(Math.min(1, x1 + dx), x0 + min);
        if (handle.includes("n")) y0 = Math.min(Math.max(0, y0 + dy), y1 - min);
        if (handle.includes("s")) y1 = Math.max(Math.min(1, y1 + dy), y0 + min);
        Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      rect = r;
      placeCropBox();
    };
    const up = () => {
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
  }
  function setCropping(on) {
    state.cropping = on;
    $("#crop").hidden = on;
    $("#crop-done").hidden = !on;
    $("#crop-clear").hidden = !on;
    for (const id of ["#rotl", "#rotr", "#reset"]) $(id).disabled = on;
    if (on) {
      rect = state.adjustments.crop ? { ...state.adjustments.crop } : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
    } else {
      box?.remove();
      box = null;
    }
    updateCreate();
    draw();
  }
  $("#crop").addEventListener("click", () => setCropping(true));
  $("#crop-done").addEventListener("click", () => {
    const round = (v) => Math.round(v * 10000) / 10000;
    const r = { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) };
    r.w = Math.min(r.w, round(1 - r.x));
    r.h = Math.min(r.h, round(1 - r.y));
    const whole = r.x === 0 && r.y === 0 && r.w === 1 && r.h === 1;
    state.adjustments.crop = whole ? null : r;
    setCropping(false);
  });
  $("#crop-clear").addEventListener("click", () => { state.adjustments.crop = null; setCropping(false); });

  $("#reset").addEventListener("click", () => {
    state.adjustments = { ...DEFAULT_SETTINGS };
    for (const name of ["brightness", "contrast", "saturation"]) {
      $(`#${name}`).value = 0;
      $(`#${name}-out`).textContent = "0";
    }
    auto.checked = false;
    draw();
  });

  // Colour / Black & white, and the Black & white style (Bold or Shaded).
  const modeNote = $("#mode-note");
  const bwStyles = $("#bw-styles");
  function showMode() {
    for (const b of panel.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    for (const b of panel.querySelectorAll("[data-style]")) b.setAttribute("aria-pressed", String(b.dataset.style === state.bwStyle));
    bwStyles.hidden = state.mode !== "bw";
    modeNote.textContent = state.mode === "bw"
      ? "Jet and Crystal stones only. Choose a style:"
      : "Stones in the colours of your image.";
  }
  for (const b of panel.querySelectorAll("[data-mode]")) b.addEventListener("click", () => { state.mode = b.dataset.mode; showMode(); });
  for (const b of panel.querySelectorAll("[data-style]")) b.addEventListener("click", () => { state.bwStyle = b.dataset.style; showMode(); });
  showMode();

  function updateCreate() {
    const waitingForBackground = state.removeBackground && state.background !== "ready" && state.background !== "failed";
    create.disabled = !canCreate || state.cropping || waitingForBackground;
    if (!canCreate) error.textContent = canDesign(session) ? TEXTS.limit : TEXTS.paid;
  }

  create.addEventListener("click", async () => {
    error.textContent = "";
    create.disabled = true;
    create.innerHTML = `<span class="spinner" aria-hidden="true"></span> Starting…`;
    const { ok, body } = await postJson(`/api/attempts/${session.code}`, {
      upload: k,
      mode: state.mode,
      ...(state.mode === "bw" ? { bwStyle: state.bwStyle } : {}),
      removeBackground: state.removeBackground && state.background === "ready",
      adjustments: state.adjustments,
      "cf-turnstile-response": await check.token()
    });
    if (!ok) {
      create.textContent = "Create design";
      error.textContent = errorText(body.error);
      check.reset();
      updateCreate();
      return;
    }
    try { sessionStorage.setItem(`is.working.${session.code}`, String(body.attempt)); } catch { /* the session answer has it too */ }
    navigate(`/c/${session.code}/working`);
  });

  showBackground();
  draw();
}

// ---------- 3 Working ----------

async function workingScreen(code) {
  setSteps("design", flowOf(code));
  const session = await loadSession(code);
  if (!session) return;
  setSteps("design", flowOf(session.code));
  let n = session.active;
  try { n ??= Number(sessionStorage.getItem(`is.working.${session.code}`)) || null; } catch { /* none */ }
  if (!n) return navigate(`/c/${session.code}`, { replace: true });

  const panel = render(html`
    <div class="working">
      <div class="card">
        <h1>Making your design</h1>
        <p class="sub">This usually takes a few minutes.</p>
        <ol class="stagelist" id="stages">
          ${raw(STAGES.map(([id, name]) => html`<li data-stage="${id}"><span class="mark"></span><span>${name}</span></li>`).join(""))}
        </ol>
        <div class="progress" aria-hidden="true"><i id="bar"></i></div>
        <p class="queue-line" id="queue"></p>
        <div class="notice error" id="error" role="alert"></div>
        <div class="actions" id="failed-actions" hidden>
          <a class="btn primary" href="/c/${session.code}/prepare" data-link>Try again</a>
        </div>
      </div>
      <div class="notice info leave">You can leave this page; your code is <code>${session.code}</code>.
        Open <b>${location.host}/c/${session.code}</b> later to come back.</div>
    </div>`);

  const bar = panel.querySelector("#bar");
  const queue = panel.querySelector("#queue");
  const error = panel.querySelector("#error");
  bar.style.width = "4%";

  let stopped = false;
  async function poll() {
    if (stopped) return;
    const { ok, body } = await api(`/api/attempts/${session.code}/${n}`);
    if (!ok) return;
    if (body.status === "done") {
      stopped = true;
      return navigate(`/c/${session.code}/result/${body.attempt}`, { replace: true });
    }
    if (body.status === "failed" || body.status === "declined") {
      stopped = true;
      queue.textContent = "";
      error.textContent = errorText(body.error);
      panel.querySelector("#failed-actions").hidden = false;
      panel.querySelector("h1").textContent = body.status === "declined" ? "We couldn't make this design" : "Something went wrong";
      for (const li of panel.querySelectorAll("#stages li")) li.classList.remove("current");
      return;
    }
    const at = Math.max(0, STAGES.findIndex(([id]) => id === body.stage));
    const waiting = body.status === "queued" && body.queue?.position > 0;
    panel.querySelectorAll("#stages li").forEach((li, i) => {
      const done = !waiting && i < at;
      const current = !waiting && i === at;
      li.classList.toggle("done", done);
      li.classList.toggle("current", current);
      li.querySelector(".mark").innerHTML = done ? "✓" : current ? `<span class="spinner" aria-hidden="true"></span>` : "";
    });
    bar.style.width = waiting ? "4%" : `${Math.round(((at + 0.5) / STAGES.length) * 100)}%`;
    // More than one design ahead: the line; next or running: the usual time.
    const position = body.queue?.position;
    queue.textContent = position > 1 ? `Designs are made one at a time. ${position} ahead of you.` : "Usually 2 to 5 minutes.";
  }
  await poll();
  every(POLL_MS, poll);
  onLeave(() => { stopped = true; });
}

// ---------- 4 Result ----------

function nameOfSize(id) { return config.sizes[id] || id.toUpperCase(); }
function colourOf(id) { return config.colours[id] || { name: id, fill: "#cccccc" }; }

async function resultScreen(code, nText) {
  setSteps("result", flowOf(code));
  const session = await loadSession(code);
  if (!session) return;
  setSteps("result", flowOf(session.code));
  const { ok, body: view } = await api(`/api/attempts/${session.code}/${nText}`);
  if (!ok || view.status !== "done") return navigate(`/c/${session.code}`, { replace: true });
  if (String(view.attempt) !== nText) return navigate(`/c/${session.code}/result/${view.attempt}`, { replace: true });

  const n = view.attempt;
  const r = view.result;
  const index = session.designs.findIndex((d) => d.attempt === n) + 1;
  const canTry = canDesign(session) && session.designsLeft > 0;
  const tinted = `/api/attempts/${session.code}/${n}/tinted.png`;
  const original = (source) => `/api/attempts/${session.code}/${n}/original.png?source=${source}`;
  const fmt = (v, p) => Number(v).toFixed(p);

  const panel = render(html`
    <div class="viewer-bar">
      <div><h1>Design ${index} of ${config.designsPerCode}</h1>
        <p class="sub">${r.mode === "bw" ? `Black & white, ${bwStyleName(r.bwStyle)}` : "Colour"} · shown as a watermarked preview</p></div>
    </div>
    <div class="result">
      <div>
        <div id="viewer"></div>
        <div class="toolbar">
          <span class="view-label">Original</span>
          <div class="mini-seg" role="group" aria-label="Original image">
            <button type="button" data-source="prepared" aria-pressed="true">Prepared</button>
            <button type="button" data-source="upload" aria-pressed="false">Uploaded</button>
          </div>
          <span class="sep" aria-hidden="true"></span>
          <div class="zoom">
            <button class="btn small icon" type="button" id="zoom-out" aria-label="Zoom out">−</button>
            <output id="zoom-level">100%</output>
            <button class="btn small icon" type="button" id="zoom-in" aria-label="Zoom in">+</button>
          </div>
        </div>
      </div>
      <div class="stats">
        <div class="card">
          <div class="control-title">Natural size</div>
          <div class="size-big">${fmt(r.widthMm, 1)} × ${fmt(r.heightMm, 1)} mm</div>
          <div class="size-in">${fmt(r.widthIn, 2)} × ${fmt(r.heightIn, 2)} in</div>
          <dl class="kv mt"><dt>Stones</dt><dd>${r.stones.toLocaleString("en-US")}</dd></dl>
          <div class="notice error mt" id="error" role="alert"></div>
          <div class="actions column mt-l">
            <button class="btn primary block" type="button" id="use">${isPrepaid(session) ? "Use this design and download" : "Use this design"}</button>
            <a class="btn block" id="again" href="/c/${session.code}/prepare" data-link ${raw(canTry ? "" : 'aria-disabled="true" tabindex="-1"')}>Try again</a>
          </div>
          <p class="sub center mt-s">${canTry
            ? `${session.designsLeft} of ${config.designsPerCode} designs left.`
            : `You've used all ${config.designsPerCode} designs.`}</p>
          <p class="sub center mt-s expect">${session.fromOrder ? expectationFromOrder() : expectation()}</p>
        </div>
        <div class="card">
          <div class="control-title">Stone sizes</div>
          <ul class="chips">${raw(Object.entries(r.bySize).map(([id, count]) => html`<li class="plain">${nameOfSize(id)} <span class="count">${count}</span></li>`).join(""))}</ul>
          <div class="control-title gap-title">Colours (${Object.keys(r.byColour).length})</div>
          <ul class="chips" id="colours">${raw(Object.entries(r.byColour).map(([id, count], i) => html`<li${raw(i >= COLOURS_SHOWN ? " hidden" : "")}><span class="swatch" data-fill="${colourOf(id).fill}"></span>${colourOf(id).name} <span class="count">${count}</span></li>`).join(""))}${raw(Object.keys(r.byColour).length > COLOURS_SHOWN
            ? `<li class="more plain"><button type="button" id="more">+${Object.keys(r.byColour).length - COLOURS_SHOWN} more</button></li>` : "")}</ul>
        </div>
        ${raw(session.designs.length > 1 ? html`
          <div class="card">
            <div class="control-title">Your designs</div>
            <div class="thumbs">${raw(session.designs.map((d, i) => html`
              <a class="thumb${d.attempt === n ? " current" : ""}" href="/c/${session.code}/result/${d.attempt}" data-link>
                <img src="/api/attempts/${session.code}/${d.attempt}/tinted.png" alt="Design ${i + 1}" loading="lazy">
                <span>Design ${i + 1} ${raw(session.selected === d.attempt ? '<span class="badge">chosen</span>' : "")}</span>
              </a>`).join(""))}</div>
          </div>` : "")}
      </div>
    </div>`);

  for (const s of panel.querySelectorAll(".swatch")) s.style.background = s.dataset.fill;
  panel.querySelector("#more")?.addEventListener("click", (event) => {
    for (const li of panel.querySelectorAll("#colours li[hidden]")) li.hidden = false;
    event.target.closest("li").remove();
  });
  for (const img of panel.querySelectorAll(".thumb img")) noSave(img);

  // The viewer: Original | Tinted side by side; at phone width two tabs, one view at a time (the CSS
  // shows the tabs and hides the other view). Zoom on both.
  const viewer = panel.querySelector("#viewer");
  const ZOOMS = [1, 1.5, 2, 3, 4];
  const show = { tab: "tinted", source: "prepared", zoom: 0 };
  const tintedImg = await loadImage(tinted).catch(() => null);
  const ratio = tintedImg ? tintedImg.naturalWidth / tintedImg.naturalHeight : 1;

  function image(src, alt) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    noSave(img);
    return img;
  }
  // Width / height of the Original view of each source, read once.
  const ratios = {};
  const ratioOf = async (source) => {
    ratios[source] ??= await loadImage(original(source)).then((img) => img.naturalWidth / img.naturalHeight).catch(() => ratio);
    return ratios[source];
  };
  function pane(paneRatio, ...imgs) {
    const p = document.createElement("div");
    p.className = "pane";
    p.style.setProperty("--ratio", paneRatio);
    p.style.setProperty("--zoom", ZOOMS[show.zoom]);
    const inner = document.createElement("div");
    inner.className = "inner";
    inner.append(...imgs);
    p.append(inner);
    return p;
  }
  async function drawViewer() {
    const originalRatio = await ratioOf(show.source);
    viewer.replaceChildren();
    viewer.className = "side";
    viewer.dataset.tab = show.tab;
    const tabs = document.createElement("div");
    tabs.className = "view-tabs segmented";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "View");
    viewer.append(tabs);
    const a = pane(originalRatio, image(original(show.source), "Your image"));
    const b = pane(ratio, image(tinted, "Your design (tinted preview)"));
    for (const [id, label, p] of [["original", "Original", a], ["tinted", "Tinted", b]]) {
      const wrap = document.createElement("div");
      wrap.className = `view ${id}`;
      wrap.id = `view-${id}`;
      wrap.setAttribute("role", "tabpanel");
      wrap.innerHTML = `<div class="view-head"><span class="view-label">${label}</span></div>`;
      wrap.append(p);
      viewer.append(wrap);
      const tab = Object.assign(document.createElement("button"), { type: "button", textContent: label });
      tab.dataset.tab = id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", wrap.id);
      tab.setAttribute("aria-selected", String(id === show.tab));
      tab.setAttribute("aria-pressed", String(id === show.tab));
      tab.addEventListener("click", () => {
        show.tab = id;
        viewer.dataset.tab = id;
        for (const t of tabs.children) {
          t.setAttribute("aria-selected", String(t === tab));
          t.setAttribute("aria-pressed", String(t === tab));
        }
      });
      tabs.append(tab);
    }
    // The two panes scroll together when zoomed (by share of their scroll range).
    let syncing = false;
    const sync = (from, to) => from.addEventListener("scroll", () => {
      if (syncing) { syncing = false; return; }
      syncing = true;
      const share = (el, side) => (side === "x" ? el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth) : el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight));
      to.scrollLeft = share(from, "x") * (to.scrollWidth - to.clientWidth);
      to.scrollTop = share(from, "y") * (to.scrollHeight - to.clientHeight);
    });
    sync(a, b);
    sync(b, a);
    panel.querySelector("#zoom-level").textContent = `${Math.round(ZOOMS[show.zoom] * 100)}%`;
    panel.querySelector("#zoom-out").disabled = show.zoom === 0;
    panel.querySelector("#zoom-in").disabled = show.zoom === ZOOMS.length - 1;
  }
  for (const b of panel.querySelectorAll("[data-source]")) {
    b.addEventListener("click", () => {
      show.source = b.dataset.source;
      for (const o of panel.querySelectorAll("[data-source]")) o.setAttribute("aria-pressed", String(o === b));
      drawViewer();
    });
  }
  panel.querySelector("#zoom-in").addEventListener("click", () => { show.zoom = Math.min(ZOOMS.length - 1, show.zoom + 1); drawViewer(); });
  panel.querySelector("#zoom-out").addEventListener("click", () => { show.zoom = Math.max(0, show.zoom - 1); drawViewer(); });
  drawViewer();

  const use = panel.querySelector("#use");
  if (!canDesign(session)) use.disabled = true;
  use.addEventListener("click", async () => {
    use.disabled = true;
    const { ok: chosen, body } = await postJson(`/api/codes/${session.code}/select`, { attempt: n });
    if (!chosen) {
      panel.querySelector("#error").textContent = errorText(body.error);
      use.disabled = false;
      return;
    }
    // A prepaid code is paid now (PN-08): straight to its download.
    navigate(body.paid ? `/download?code=${session.code}` : `/c/${session.code}/done`);
  });
}

// ---------- 5 Your code ----------

async function doneScreen(code) {
  setSteps("code", flowOf(code));
  const session = await loadSession(code);
  if (!session) return;
  setSteps("code", flowOf(session.code));
  // Made from an Etsy order (PN-08): nothing to enter on Etsy.
  if (session.fromOrder) return navigate(isPrepaid(session) ? `/c/${session.code}` : `/download?code=${session.code}`, { replace: true });
  const chosen = session.selected ?? session.designs[session.designs.length - 1]?.attempt;
  const downloadUrl = `${location.host}/download`;

  const panel = render(html`
    <div class="narrow">
      <div class="card code-hero">
        <p class="sub">Your code</p>
        <div class="code-big" id="code">${session.code}</div>
        <button class="btn primary" type="button" id="copy">Copy code</button>
      </div>
      <div class="card">
        <h2>Three steps to your files</h2>
        <ol class="numbered" id="steps-list">
          <li><div><b>Enter the code on Etsy</b><p>On the PatternNifty listing, paste <code>${session.code}</code> into the <b>Personalization</b> field.</p></div></li>
          <li><div><b>Check out on Etsy</b><p>You pay on Etsy only. Nothing is charged here.</p></div></li>
          <li><div><b>Come back to download</b><p>Go to <a href="/download?code=${session.code}" data-link>${downloadUrl}</a> and enter your code. Payments usually appear within 10 minutes.</p></div></li>
        </ol>
        <p class="sub mt" id="order-within">Order within 30 days. After 30 days without a visit, your design is deleted.</p>
        <div class="actions mt-l" id="links">
          ${raw(config.listingUrl ? html`<a class="btn primary" href="${config.listingUrl}" target="_blank" rel="noopener">Open the Etsy listing</a>` : "")}
          ${raw(chosen ? html`<a class="btn" href="/c/${session.code}/result/${chosen}" data-link>Back to your design</a>` : "")}
        </div>
      </div>
    </div>`);
  panel.querySelector("#copy").addEventListener("click", () => copyText(session.code));
}

// ---------- 6 Download ----------

// Asked once per code, before its first download (PN-07, the terms' "Downloads and refunds").
const WITHDRAWAL_TEXT = "I agree that my download starts now and that I lose any right to withdraw from the purchase.";

// A code made from an Etsy order was never entered on Etsy (PN-08 follow-up).
const DOWNLOAD_LEDE = "Enter the code you put in the Etsy Personalization field.";
const DOWNLOAD_LEDE_FROM_ORDER = "Enter your PatternNifty code to download your files.";

async function downloadScreen(params) {
  const initial = params?.get("code") || savedCode() || "";
  // Until a code given in the link is checked, it is not known whether it came from an order: the
  // Etsy lines wait, so a buyer who bought first never sees them.
  const pending = Boolean(params?.get("code")) && flowOf(initial) === null;
  const fromOrder = flowOf(initial) === "prepaid";
  setSteps(fromOrder ? "download" : null, "prepaid");
  const panel = render(html`
    <div class="narrow">
      <div class="card">
        <h1>Download your files</h1>
        <p class="lede" id="download-lede" ${raw(pending ? "hidden" : "")}>${fromOrder ? DOWNLOAD_LEDE_FROM_ORDER : DOWNLOAD_LEDE}</p>
        <form class="code-form" id="form" novalidate>
          <label class="visually-hidden" for="code">Your code</label>
          <input id="code" name="code" placeholder="PN-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${initial}">
          <button class="btn primary" type="submit">Check</button>
        </form>
        <div class="state" id="state" aria-live="polite"></div>
        <p class="sub mt" id="order-link" ${raw(pending || fromOrder ? "hidden" : "")}>Bought on Etsy without a code? <a href="/order" data-link>Enter your order number</a></p>
      </div>
    </div>`);

  const input = panel.querySelector("#code");
  const lede = panel.querySelector("#download-lede");
  const orderLink = panel.querySelector("#order-link");
  const showFlow = (madeFromOrder) => {
    lede.textContent = madeFromOrder ? DOWNLOAD_LEDE_FROM_ORDER : DOWNLOAD_LEDE;
    lede.hidden = false;
    orderLink.hidden = madeFromOrder;
    setSteps(madeFromOrder ? "download" : null, "prepaid");
  };
  const out = panel.querySelector("#state");
  let timer = null;
  onLeave(() => clearTimeout(timer));

  const zipUrl = (code) => `/api/download/${encodeURIComponent(code)}/zip`;
  const date = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  async function check(code, quiet = false) {
    clearTimeout(timer);
    const clean = code.trim();
    if (!clean) return;
    if (!quiet) out.innerHTML = `<div class="loading"><span class="spinner"></span>Checking…</div>`;
    const { ok, body } = await api(`/api/download/${encodeURIComponent(clean)}`);
    if (!ok) {
      showFlow(flowOf(clean) === "prepaid");
      out.innerHTML = html`<div class="notice error">${errorText(body.error)}</div>`;
      return;
    }
    if (body.state !== "unknown") fromOrderCodes.set(codeKey(clean), Boolean(body.fromOrder));
    showFlow(Boolean(body.fromOrder));
    const states = {
      unknown: html`<div class="notice error"><b>We couldn't find this code.</b> Please check it — it looks like PN-7K3Q-9XPA.</div>`,
      unpaid: html`<div class="notice warn"><b>Not paid yet.</b> Payments usually appear within 10 minutes of checkout. This page checks again automatically.</div>`,
      // The first download of a code asks for the withdrawal consent (terms); later ones do not.
      ready: html`
        <div class="notice ok"><b>Your files are ready.</b> SVG, production sheets (PDF), AI, EPS, DXF and PNG in one ZIP.</div>
        ${raw(body.consented ? "" : html`<label class="consent" id="withdrawal-box">
          <input type="checkbox" id="withdrawal">
          <span>${WITHDRAWAL_TEXT}</span>
        </label>`)}
        <div class="actions dl-actions"><a class="btn primary" id="dl" download ${raw(body.consented ? html`href="${zipUrl(clean)}"` : 'aria-disabled="true"')}>Download ZIP</a></div>
        <p class="sub">Available until ${body.expiresAt ? date(body.expiresAt) : ""}. See the <a href="/terms" data-link>terms</a>.</p>`,
      expired: html`<div class="notice"><b>This download has expired.</b> Files are kept for 30 days after payment. Please <a href="/contact" data-link>contact us</a> if you need them again.</div>`,
      refunded: html`<div class="notice"><b>This order was refunded</b>, so its files are no longer available.</div>`,
      // Made from an Etsy order, no design picked yet (PN-08).
      pick: html`<div class="notice warn" id="pick"><b>Pick your design first.</b> <a href="/c/${encodeURIComponent(clean)}" data-link>Go to your designs</a> and choose one with “Use this design and download”.</div>`,
      // Paid after the nightly job deleted the design (D7); Alex refunds it on Etsy.
      deleted: html`<div class="notice" id="deleted">This design was deleted because it was more than 30 days old. Send us a message on Etsy and we will refund you.</div>`
    };
    out.innerHTML = states[body.state] || states.unknown;
    const agree = out.querySelector("#withdrawal");
    agree?.addEventListener("change", () => {
      const dl = out.querySelector("#dl");
      if (agree.checked) {
        dl.href = `${zipUrl(clean)}?agree=1`;
        dl.removeAttribute("aria-disabled");
      } else {
        dl.removeAttribute("href");
        dl.setAttribute("aria-disabled", "true");
      }
    });
    if (body.state === "unpaid") timer = setTimeout(() => check(clean, true), DOWNLOAD_POLL_MS);
  }

  panel.querySelector("#form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = input.value;
    history.replaceState(null, "", `/download?code=${encodeURIComponent(code.trim())}`);
    check(code);
  });
  if (params?.get("code")) check(initial);
}

// ---------- Order: buy first, design after (PN-08) ----------

const ORDER_POLL_MS = 30000;

async function orderScreen() {
  setSteps(null);
  const panel = render(html`
    <div class="narrow">
      <div class="card">
        <h1>Bought on Etsy? Make your design</h1>
        <p class="lede">Enter your Etsy order number to get your PatternNifty code. Then upload your photo, try up to ${config.designsPerCode} designs, pick one and download your files.</p>
        <form class="code-form" id="form" novalidate>
          <label class="visually-hidden" for="order">Etsy order number</label>
          <input id="order" name="order" placeholder="Etsy order number" inputmode="numeric" autocomplete="off" spellcheck="false">
          <button class="btn primary" type="submit" id="go">Continue</button>
        </form>
        <p class="sub">You find your order number in your Etsy purchases and in Etsy's order email.</p>
        <div class="turnstile-box" id="check"></div>
        <div class="state" id="state" aria-live="polite"></div>
      </div>
    </div>`);

  const form = panel.querySelector("#form");
  const input = panel.querySelector("#order");
  const go = panel.querySelector("#go");
  const out = panel.querySelector("#state");
  const check = securityCheck(panel.querySelector("#check"));
  let timer = null;
  onLeave(() => clearTimeout(timer));

  const STATES = {
    prepaid: (c) => [c.designs ? `Paid · ${c.designs} of ${config.designsPerCode} designs made, none picked yet` : "Paid · no design yet", "Make your design", `/c/${c.code}`],
    ready: (c) => ["Paid · ready to download", "Download", `/download?code=${c.code}`],
    pick: (c) => ["Paid · no design picked yet", "Make your design", `/c/${c.code}`],
    expired: (c) => ["Download expired", "Open", `/download?code=${c.code}`],
    refunded: (c) => ["Refunded", "Open", `/download?code=${c.code}`],
    deleted: (c) => ["Design deleted", "Open", `/download?code=${c.code}`],
    unpaid: (c) => ["Waiting for the payment", "Open", `/download?code=${c.code}`]
  };

  function show(body, order) {
    clearTimeout(timer);
    if (body.state === "found") {
      const one = body.codes.length === 1;
      out.innerHTML = html`
        <div class="notice ok"><b>Order found.</b> ${one ? "Your code is below. Keep it: it brings you back to your design." : "Each design you bought has its own code. Keep them: they bring you back to your designs."}</div>
        <ul class="order-codes">${raw(body.codes.map((c) => {
          const [label, action, href] = (STATES[c.state] || STATES.unpaid)(c);
          return html`<li><div><code>${c.code}</code><span class="sub">${label}</span></div><a class="btn${c.state === "prepaid" || c.state === "ready" ? " primary" : ""} small" href="${href}" data-link>${action}</a></li>`;
        }).join(""))}</ul>`;
      if (one && body.codes[0].state === "prepaid") saveCode(body.codes[0].code);
      return;
    }
    if (body.state === "refunded") {
      out.innerHTML = html`<div class="notice" id="refunded">${TEXTS.refunded}</div>`;
      return;
    }
    if (body.state === "waiting") {
      out.innerHTML = html`<div class="notice warn" id="waiting">We can't find this order yet. Payments usually appear within 10 minutes of checkout. This page checks again automatically.</div>`;
      timer = setTimeout(async () => {
        const { ok, body: again } = await api(`/api/order/${encodeURIComponent(order)}?ticket=${encodeURIComponent(body.ticket)}`);
        if (!ok) return show(body, order);
        if (again.state === "expired") {
          out.innerHTML = html`<div class="notice warn">We still can't find this order. Please check the number and try again.</div>`;
          return;
        }
        show(again, order);
      }, ORDER_POLL_MS);
      return;
    }
    out.innerHTML = html`<div class="notice error">${errorText(body.error)}</div>`;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(timer);
    const order = input.value.replace(/\s+/g, "");
    if (!/^\d+$/.test(order)) {
      out.innerHTML = html`<div class="notice error">${TEXTS["bad-order"]}</div>`;
      input.focus();
      return;
    }
    go.disabled = true;
    out.innerHTML = `<div class="loading"><span class="spinner"></span>Looking up your order…</div>`;
    const { body } = await postJson("/api/order", { order, "cf-turnstile-response": await check.token() });
    go.disabled = false;
    // A token passes the check once.
    check.reset();
    show(body, order);
  });
}

// ---------- 7 Static pages (public/legal.js, PN-07) ----------

// The privacy policy, terms, contact and legal notice, with the seller's details from .env.
function staticPage(name) {
  setSteps(null);
  const values = { ...config.legal, email: config.legal?.contactEmail, listing: config.listingUrl };
  render(`<article class="prose">${renderHtml(PAGES[name], values, esc)}</article>`);
}

// ---------- Start ----------

(async () => {
  const { ok, body } = await api("/api/config");
  if (ok) config = { ...config, ...body };
  showChip(savedCode());
  route();
})();
