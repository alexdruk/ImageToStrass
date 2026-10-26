import crypto from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { normalizeCode } from "../db/codes.js";
import { loadShop } from "../etsy/shop-store.js";
import { loadTokens } from "../etsy/token-store.js";
import { adminOnly } from "./admin-access.js";

// /admin (spec section 11.4), on this Mac or with ADMIN_TOKEN: Etsy connection (Connect Etsy) and
// poller, today's designs, the queue, failures, orders without a code ("match to code"), manual
// unlock, and the disk use of data/. Plain server-made HTML and forms, no script. Every form carries
// a token made at start-up, so another web page open on this Mac cannot post to it. Designs show IS
// fields only (status, IS error code, stones), never event details (spec section 12).

const MESSAGES = {
  matched: "Order matched; the code is paid and its ZIP is being built.",
  "matched-refunded": "Order matched; it was refunded, so the code is locked.",
  "unknown-order": "That order no longer exists.",
  "already-matched": "That order is matched already.",
  "unknown-code": "No such code.",
  unlocked: "Code unlocked for 30 days; its ZIP is being built.",
  polled: "Poll finished.",
  "poll-failed": "Poll failed; see the poller status.",
  csrf: "The form had expired. Please try again."
};

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–");
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Bytes and files under dir (symbolic links are not followed).
async function diskUse(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        bytes += (await lstat(file)).size;
        files += 1;
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

async function etsyConnection(readTokens, readShop) {
  let tokens = null;
  let shop = null;
  try { tokens = await readTokens(); } catch { /* unreadable: not connected */ }
  try { shop = await readShop(); } catch { /* none */ }
  const issuedAt = tokens ? Number(tokens.expires_at) - Number(tokens.expires_in) : NaN;
  return {
    connected: Boolean(tokens?.refresh_token),
    tokenAgeDays: Number.isFinite(issuedAt) ? (Date.now() / 1000 - issuedAt) / 86400 : null,
    shop
  };
}

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const STYLE = `
  body { font: 15px/1.45 -apple-system, system-ui, sans-serif; color: #0e1730; background: #fff; margin: 0; }
  header { background: #12348f; color: #fff; padding: 14px 24px; }
  header h1 { margin: 0; font-size: 19px; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px 24px 48px; }
  section { border: 1px solid #dfe4ee; border-radius: 12px; padding: 14px 18px; margin-top: 16px; }
  h2 { font-size: 16px; margin: 0 0 10px; color: #12348f; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  th { color: #5b6478; font-weight: 600; }
  .muted { color: #5b6478; }
  .ok { color: #11743b; font-weight: 600; } .bad { color: #b42318; font-weight: 600; }
  .note { background: #eaf0ff; border-radius: 8px; padding: 8px 12px; margin-top: 12px; }
  .btn { display: inline-block; background: #12348f; color: #fff; border: 0; border-radius: 8px; padding: 7px 14px;
    font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  form.inline { display: flex; gap: 6px; align-items: center; margin: 0; }
  input[type=text] { font: 14px ui-monospace, monospace; padding: 5px 8px; border: 1px solid #c6cddb; border-radius: 6px; width: 13ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 16px; }
  code { font: 13px ui-monospace, monospace; }
  .pers { max-width: 280px; white-space: pre-wrap; word-break: break-word; }`;

export function adminRoutes({ q, config, pipeline, poller, delivery, deps = {} }) {
  const router = express.Router();
  const csrf = crypto.randomBytes(24).toString("base64url");
  const readTokens = deps.loadTokens || loadTokens;
  const readShop = deps.loadShop || (() => loadShop(config.etsy.shopFile));
  const dataDir = config.dataDir;

  router.use("/admin", adminOnly(config));
  router.use("/admin", express.urlencoded({ extended: false, limit: "4kb" }));

  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const back = (res, msg) => res.redirect(303, `/admin?msg=${encodeURIComponent(msg)}`);
  const csrfOk = (req) => {
    const given = Buffer.from(String(req.body?.csrf ?? ""));
    const want = Buffer.from(csrf);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  router.get("/admin", async (req, res) => {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const [etsy, disk] = await Promise.all([
      etsyConnection(readTokens, readShop),
      Promise.all(["archive", "delivery", ""].map(async (sub) => [sub || "all", await diskUse(path.join(dataDir, sub))]))
    ]);
    const poll = poller.status();
    const today = q.listAttemptsSince(since.toISOString());
    const active = q.listActiveAttempts();
    const failures = q.listRecentFailures(20);
    const unmatched = q.listUnmatchedOrders();
    const orders = q.listRecentOrders(20).filter((o) => o.matched_code);
    const message = MESSAGES[req.query.msg] ? `<p class="note">${esc(MESSAGES[req.query.msg])}</p>` : "";

    const design = (a) => [
      `<code>${esc(a.code)}</code>`, esc(a.n), esc(a.status), esc(a.settings?.mode ?? ""),
      esc(a.result?.stones ?? ""), esc(a.error_code ?? ""), esc(when(a.created_at))
    ];
    const lastRun = poll.lastRun
      ? `${when(poll.lastRun.at)} — ${poll.lastRun.ok
        ? `<span class="ok">ok</span>: ${esc(poll.lastRun.receipts)} receipts, ${esc(poll.lastRun.transactions)} IS transactions, ${esc(poll.lastRun.paid)} paid, ${esc(poll.lastRun.refunded)} refunded, ${esc(poll.lastRun.unmatched)} without a code`
        : '<span class="bad">failed</span>'}`
      : "never";

    res.set("Content-Security-Policy", CSP).set("Cache-Control", "no-store").type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IS admin</title><style>${STYLE}</style></head>
<body><header><h1>IS admin</h1></header><main>${message}
<div class="grid">
<section><h2>Etsy</h2>
  <p>${etsy.connected ? '<span class="ok">Connected</span>' : '<span class="bad">Not connected</span>'}
    ${etsy.shop ? ` · shop <b>${esc(etsy.shop.shop_name)}</b> (${esc(etsy.shop.shop_id)})` : ""}
    ${etsy.tokenAgeDays !== null ? ` · token ${etsy.tokenAgeDays.toFixed(1)} days old (reconnect before 90)` : ""}</p>
  <p class="muted">Callback: <code>${esc(config.etsy.redirectUri || "ETSY_REDIRECT_URI not set")}</code></p>
  <p><a class="btn" href="/auth/etsy">${etsy.connected ? "Reconnect Etsy" : "Connect Etsy"}</a></p>
</section>
<section><h2>Poller</h2>
  <p>Every ${Math.round(poll.everyMs / 1000)} s · listings: ${poll.listingIds.length ? poll.listingIds.map((id) => `<code>${esc(id)}</code>`).join(", ") : '<span class="bad">none (IS_ETSY_LISTING_IDS is empty, nothing is stored)</span>'}</p>
  <p>Last run: ${lastRun}${poll.running ? " · running now" : ""}</p>
  <p>Last good run: ${esc(when(poll.lastOkAt))}</p>
  ${poll.lastError ? `<p class="bad">Last error (${esc(when(poll.lastError.at))}): ${esc(poll.lastError.message)}</p>` : ""}
  <form method="post" action="/admin/poll">${hidden}<button class="btn" type="submit">Poll now</button></form>
</section>
</div>
<section><h2>Orders without a code (${unmatched.length})</h2>
  ${table(["Receipt", "Transaction", "Listing", "Personalization", "Paid", "Status", "Match to code"], unmatched.map((o) => [
    esc(o.receipt_id), esc(o.transaction_id), esc(o.listing_id), `<span class="pers">${esc(o.personalization)}</span>`,
    esc(when(o.paid_at)), esc(o.status),
    `<form class="inline" method="post" action="/admin/match">${hidden}<input type="hidden" name="id" value="${esc(o.id)}">
      <input type="text" name="code" placeholder="PN-XXXX-XXXX" required><button class="btn" type="submit">Match</button></form>`
  ]), "None.")}
</section>
<div class="grid">
<section><h2>Manual unlock</h2>
  <p class="muted">Marks the code paid and downloadable for 30 days from now (also after a refund), and builds its ZIP.</p>
  <form class="inline" method="post" action="/admin/unlock">${hidden}
    <input type="text" name="code" placeholder="PN-XXXX-XXXX" required><button class="btn" type="submit">Unlock</button></form>
</section>
<section><h2>Queue</h2>
  <p>${esc(pipeline.queueLength())} design(s) queued or running.</p>
  ${table(["Code", "#", "Status", "Mode", "Stones", "Error", "Created"], active.map(design), "Empty.")}
</section>
</div>
<section><h2>Today's designs (${today.length})</h2>
  ${table(["Code", "#", "Status", "Mode", "Stones", "Error", "Created"], today.map(design), "None yet today.")}
</section>
<section><h2>Latest failures</h2>
  ${table(["Code", "#", "Status", "Mode", "Stones", "Error", "Created"], failures.map(design), "None.")}
</section>
<section><h2>Latest matched orders</h2>
  ${table(["Code", "Receipt", "Transaction", "Paid", "Status", "Code state"], orders.map((o) => [
    `<code>${esc(o.matched_code)}</code>`, esc(o.receipt_id), esc(o.transaction_id), esc(when(o.paid_at)), esc(o.status),
    esc(q.getCode(o.matched_code)?.status ?? "")
  ]), "None.")}
</section>
<section><h2>Disk use of data/</h2>
  ${table(["Folder", "Size", "Files"], disk.map(([name, use]) => [esc(name === "all" ? "data/ (all)" : `data/${name}/`), esc(mb(use.bytes)), esc(use.files)]), "")}
</section>
</main></body></html>`);
  });

  router.post("/admin/match", (req, res) => {
    if (!csrfOk(req)) return back(res, "csrf");
    const id = Number(req.body.id);
    const out = Number.isSafeInteger(id) ? poller.matchOrder(id, String(req.body.code ?? "")) : { ok: false, error: "unknown-order" };
    if (!out.ok) return back(res, out.error === "matched" ? "already-matched" : out.error);
    back(res, q.getCode(out.code)?.status === "refunded" ? "matched-refunded" : "matched");
  });

  router.post("/admin/unlock", (req, res) => {
    if (!csrfOk(req)) return back(res, "csrf");
    const code = normalizeCode(String(req.body.code ?? ""));
    if (!code || !delivery.unlock(code)) return back(res, "unknown-code");
    back(res, "unlocked");
  });

  router.post("/admin/poll", async (req, res) => {
    if (!csrfOk(req)) return back(res, "csrf");
    const out = await poller.runOnce();
    back(res, out.ok ? "polled" : "poll-failed");
  });

  return router;
}
