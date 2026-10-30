import { AGENTS, exitMeaning } from "./probes.js";

// Server-made HTML of the control panel (PN-05). Every value is escaped; nothing from .env is shown
// except whether a key is set. The only script is /control.js (auto-refresh with a pause switch).

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (value) => (value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" }) : "–");

export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

export function size(bytes) {
  if (bytes === null || bytes === undefined) return "–";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const ok = (text) => `<span class="ok">● ${esc(text)}</span>`;
const bad = (text) => `<span class="bad">● ${esc(text)}</span>`;
const warn = (text) => `<span class="warn">● ${esc(text)}</span>`;
const muted = (text) => `<span class="muted">${esc(text)}</span>`;

export const AGENT_INFO = {
  "com.is.strass": { name: "Strass service", what: "layout and background removal, 127.0.0.1:8000", actions: ["start", "stop", "restart"] },
  "com.is.server": { name: "Website server", what: "patternnifty.com, 127.0.0.1:3003", actions: ["start", "stop", "restart"] },
  "com.is.tunnel": { name: "Tunnel", what: "cloudflared: patternnifty.com → the website server", actions: ["start", "stop", "restart"] },
  "com.is.nightly": { name: "Nightly job", what: "03:30 and at login: expiry, ZIP clean-up, logs, backup", actions: ["start", "stop", "run"] },
  "com.is.control": { name: "Control panel", what: "this page, 127.0.0.1 only (cannot stop itself)", actions: ["restart"] }
};

const ACTION_TEXT = { start: "Start", stop: "Stop", restart: "Restart", run: "Run now" };

// What a Stop or Restart does, shown before it is confirmed.
export const CONFIRM = {
  "com.is.server": {
    stop: "Stopping the website server takes patternnifty.com down: buyers get an error page until it is started again. A design being made is interrupted.",
    restart: "patternnifty.com is down for a few seconds while the server restarts (it first waits for the strass service). A design being made is interrupted."
  },
  "com.is.strass": {
    stop: "While the strass service is stopped, new designs and background removal fail, /health is not ok, and a restarted website server waits for it.",
    restart: "The strass service is unavailable for about a minute while its models load; a design being made fails and does not count."
  },
  "com.is.tunnel": {
    stop: "Stopping the tunnel makes patternnifty.com unreachable from the internet (the server keeps running on this Mac).",
    restart: "patternnifty.com is unreachable for a few seconds while the tunnel reconnects."
  },
  "com.is.nightly": {
    stop: "The nightly job will not run at 03:30 or at login until it is started again (no backups, no ZIP clean-up)."
  },
  "com.is.control": {
    restart: "This page is unavailable for a few seconds while the control panel restarts."
  }
};

const STYLE = `
  :root { color-scheme: light; }
  body { font: 15px/1.45 -apple-system, system-ui, sans-serif; color: #0e1730; background: #fff; margin: 0; }
  header { position: sticky; top: 0; z-index: 1; background: #12348f; color: #fff; padding: 12px 24px;
    display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; justify-content: space-between; }
  header h1 { margin: 0; font-size: 19px; }
  header .refresh { font-size: 13px; display: flex; gap: 12px; align-items: center; }
  header a { color: #fff; }
  main { max-width: 1180px; margin: 0 auto; padding: 8px 24px 48px; }
  section { border: 1px solid #dfe4ee; border-radius: 12px; padding: 14px 18px; margin-top: 16px; overflow-x: auto; }
  h2 { font-size: 16px; margin: 0 0 10px; color: #12348f; }
  h3 { font-size: 14px; margin: 12px 0 6px; color: #12348f; }
  p { margin: 6px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
  th { color: #5b6478; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { color: #5b6478; }
  .ok { color: #11743b; font-weight: 600; } .bad { color: #b42318; font-weight: 600; } .warn { color: #a15c00; font-weight: 600; }
  .note { background: #eaf0ff; border-radius: 8px; padding: 8px 12px; margin-top: 12px; }
  .note.bad { background: #fdecea; } .note.waiting { background: #fff4e0; }
  form.inline { display: inline; margin-left: 8px; }
  .btn { display: inline-block; background: #12348f; color: #fff; border: 0; border-radius: 8px; padding: 5px 12px;
    font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn.ghost { background: #eaf0ff; color: #12348f; }
  .btn.danger { background: #b42318; }
  .btn:disabled { background: #dfe4ee; color: #8a93a6; cursor: default; }
  .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
  .buttons form { margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 16px; }
  code { font: 13px ui-monospace, monospace; }
  .small { font-size: 13px; }
  ul.orders { margin: 4px 0 10px; padding-left: 20px; font-size: 14px; } ul.orders li { margin: 2px 0; }
  q.buyer-text { font-family: ui-monospace, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
  pre.log { font: 12px/1.5 ui-monospace, monospace; background: #f6f8fc; border-radius: 8px; padding: 10px 12px;
    white-space: pre-wrap; word-break: break-word; margin: 0; }
  pre.log .hl { background: #fdecea; color: #8c1d13; display: block; }
  @media (max-width: 640px) { header, main { padding-left: 16px; padding-right: 16px; } }`;

function layout(title, body, { refresh = false, status = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><header><h1>IS control</h1>${refresh
    ? `<div class="refresh"><span id="updated">${esc(status)}</span><label><input type="checkbox" id="pause"> Pause auto-refresh (every 10 s)</label></div>`
    : '<div class="refresh"><a href="/">Back to the control panel</a></div>'}</header>
<main>${body}</main>${refresh ? '<script src="/control.js"></script>' : ""}</body></html>`;
}

function buttons(label, agent, csrf) {
  const info = AGENT_INFO[label];
  const enabled = {
    // A loaded nightly job is not running between runs; Run now starts it.
    start: label === "com.is.nightly" ? !agent.loaded : !agent.running,
    stop: agent.loaded,
    restart: agent.loaded,
    run: agent.loaded && !agent.running
  };
  return `<div class="buttons">${info.actions.map((action) => `<form method="post" action="/agents/${label}/${action}">
    <input type="hidden" name="csrf" value="${csrf}"><button class="btn${action === "stop" ? " danger" : action === "start" || action === "run" ? "" : " ghost"}" type="submit"${enabled[action] ? "" : " disabled"}>${ACTION_TEXT[action]}</button></form>`).join("")}</div>`;
}

function agentState(agent, label) {
  if (agent.running) return ok("running");
  if (!agent.loaded) return bad("not loaded (stopped)");
  if (label === "com.is.nightly") return agent.status === 0 || agent.status === null ? muted("waiting for 03:30") : bad("waiting; last run failed");
  return bad("loaded, not running");
}

function exitCell(agent) {
  if (agent.status === null) return muted("–");
  const meaning = exitMeaning(agent.status);
  const text = `${agent.status} · ${meaning}`;
  return agent.status === 0 ? esc(text) : agent.status === -15 ? warn(text) : bad(text);
}

function agentsSection(data, csrf) {
  const rows = AGENTS.map((label) => {
    const agent = data.agents.agents.find((a) => a.label === label);
    const info = AGENT_INFO[label];
    const extra = label === "com.is.nightly"
      ? `<div class="small">${data.nightly
        ? `Last run ${esc(when(data.nightly.at))}: ${data.nightly.errors ? bad(data.nightly.text) : esc(data.nightly.text)}`
        : muted("No nightly summary yet.")}</div>`
      : "";
    return `<tr><td><b>${esc(info.name)}</b> <code class="muted">${esc(label)}</code><div class="small muted">${esc(info.what)}</div>${extra}</td>
      <td>${agentState(agent, label)}</td><td class="num">${esc(agent.pid ?? "–")}</td>
      <td>${esc(agent.proc ? duration(agent.proc.seconds) : "–")}</td><td>${exitCell(agent)}</td>
      <td class="num">${agent.proc ? `${agent.proc.cpu.toFixed(1)} %` : "–"}</td>
      <td class="num">${agent.proc ? esc(size(agent.proc.rssKb * 1024)) : "–"}</td>
      <td>${buttons(label, agent, csrf)}</td></tr>`;
  }).join("");
  return `<section><h2>Agents</h2>
  ${data.agents.error ? `<p class="bad">${esc(data.agents.error)}</p>` : ""}
  <table><thead><tr><th>Agent</th><th>State</th><th class="num">PID</th><th>Uptime</th><th>Last exit</th><th class="num">CPU</th><th class="num">Memory</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="small muted">CPU and memory include the agent's child processes. Stop and Restart ask first. A stopped agent stays stopped until Start or the next login.</p>
</section>`;
}

function httpResult(r) {
  return r.ok ? ok(`ok · ${r.ms} ms`) : bad(`${r.error || "error"} · ${r.ms} ms`);
}

function healthSection({ health, tunnel, agents }) {
  const w = health.website;
  const parts = w.body && typeof w.body === "object"
    ? ["db", "strass", "etsy"].map((k) => `${k} ${w.body[k]?.ok ? "✓" : "✗"}`).join(" · ")
    : "";
  const websiteLine = w.body?.ok === true ? ok(`ok · ${w.ms} ms`)
    : w.status ? bad(`answers ${w.status}, not ok · ${w.ms} ms`) : bad(`down: ${w.error} · ${w.ms} ms`);

  const s = health.strass;
  const strassLine = s.body?.ok && s.body?.modelsLoaded ? ok(`ok · ${s.ms} ms`)
    : s.body?.ok ? warn(`models loading · ${s.ms} ms`) : bad(`${s.error || "not ok"} · ${s.ms} ms`);

  const p = health.public;
  const publicLine = p.body?.ok === true ? ok(`ok · ${p.ms} ms`)
    : p.status ? bad(`answers ${p.status}${p.body ? ", not ok" : ""} · ${p.ms} ms`) : bad(`${p.error} · ${p.ms} ms`);

  const cloudflared = agents.agents.find((a) => a.label === "com.is.tunnel");
  const tunnelLine = !cloudflared?.running ? bad("cloudflared is not running")
    : !tunnel.metrics ? warn("cloudflared running; its metrics did not answer")
      : tunnel.connections > 0 ? ok(`${tunnel.connections} connection${tunnel.connections === 1 ? "" : "s"}`) : bad("running, no connection to Cloudflare");

  return `<section><h2>Health</h2>
  <table><tbody>
    <tr><th>Website</th><td>${websiteLine}${parts ? ` <span class="small muted">${esc(parts)}</span>` : ""}${w.body?.etsy?.tokenAgeHours !== undefined && w.body?.etsy?.tokenAgeHours !== null ? ` <span class="small muted">· Etsy token ${esc(w.body.etsy.tokenAgeHours)} h</span>` : ""}
      <div class="small muted">GET 127.0.0.1 /health on the website server</div></td></tr>
    <tr><th>Strass</th><td>${strassLine}${s.body?.busy ? ` ${warn("busy")}` : ""} · port ${esc(health.strassPort)} ${health.strassListening ? ok("listening") : bad("not listening")}
      <div class="small muted">GET /health on the strass service</div></td></tr>
    <tr><th>Public</th><td>${publicLine}
      <div class="small muted">GET https /health through Cloudflare, from this Mac: proves the tunnel works end to end (checked at most every 30 s)</div></td></tr>
    <tr><th>Tunnel</th><td>${tunnelLine}${tunnel.name ? ` <span class="small muted">· tunnel <code>${esc(tunnel.name)}</code></span>` : ""}${tunnel.locations.length ? ` <span class="small muted">· ${esc(tunnel.locations.join(", "))}</span>` : ""}
      <div class="small muted">cloudflared's local metrics (no sudo)</div></td></tr>
  </tbody></table>
</section>`;
}

function businessSection(b, websiteUrl) {
  if (!b.db) {
    return `<section><h2>Business</h2><p class="bad">The database could not be opened (read-only).</p>${etsyBlock(b)}</section>`;
  }
  const row = (name, key) => `<tr><td>${esc(name)}</td><td class="num">${esc(b.today[key])}</td><td class="num">${esc(b.week[key])}</td></tr>`;
  const running = b.running.length
    ? b.running.map((r) => `<code>${esc(r.code)}</code> #${esc(r.n)} at stage <b>${esc(r.stage || "starting")}</b>`).join("<br>")
    : muted("nothing running");
  const capShare = b.cap ? b.capUsed / b.cap : 0;
  return `<section><h2>Business</h2>
  <div class="grid"><div>
  <p>Queue: <b>${esc(b.queued)}</b> waiting · ${running}</p>
  <table><thead><tr><th></th><th class="num">Today</th><th class="num">Last 7 days</th></tr></thead><tbody>
    ${row("Designs done", "done")}${row("Designs failed", "failed")}${row("Designs declined", "declined")}${row("Automatic re-runs", "reruns")}
    ${row("Codes created", "codes")}${row("Codes paid", "paid")}${row("Downloads", "downloads")}
  </tbody></table>
  </div><div>
  ${unmatchedBlock(b, websiteUrl)}
  <p>Daily design cap: ${capShare >= 1 ? bad(`${b.capUsed} of ${b.cap}`) : capShare >= 0.8 ? warn(`${b.capUsed} of ${b.cap}`) : `<b>${esc(b.capUsed)}</b> of ${esc(b.cap)}`} used today
    <span class="small muted">(designs counted since midnight in Paris; at the cap new designs answer busy)</span></p>
  ${etsyBlock(b)}
  </div></div>
</section>`;
}

// Orders without a code (PN-08 follow-up, probes.splitUnmatched): a red line per order whose
// Personalization names no known code, with the buyer's text; a neutral list of the orders bought
// first and not redeemed yet (the ones 7 days old and more are yellow notes at the top instead).
const day = (value) => (value ? new Date(value).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "–");
const clip = (text, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text);

function unmatchedBlock(b, websiteUrl) {
  const unknown = b.unknownCode || [];
  const waiting = b.waiting || [];
  const unknownRows = unknown.map((o) => `<li>Receipt <b>${esc(o.receiptId)}</b> · paid ${esc(day(o.paidAt))}${o.status === "refunded" ? ` ${muted("(refunded)")}` : ""}
    · the buyer wrote: <q class="buyer-text">${esc(clip(o.personalization))}</q></li>`).join("");
  const waitingRows = waiting.map((o) => `<li>Receipt <b>${esc(o.receiptId)}</b> · paid ${esc(day(o.paidAt))}</li>`).join("");
  return `<p>Orders with an unknown code: ${unknown.length ? bad(String(unknown.length)) : ok("0")} · <a href="${esc(websiteUrl)}/admin">open /admin</a></p>
  ${unknown.length ? `<ul class="orders" id="unknown-code">${unknownRows}</ul>` : ""}
  <p>Waiting for the buyer to redeem: <b>${esc(waiting.length)}</b> <span class="small muted">(bought first, Personalization empty; normal for up to 7 days)</span></p>
  ${waiting.length ? `<ul class="orders" id="waiting-redeem">${waitingRows}</ul>` : ""}`;
}

function etsyBlock(b) {
  const age = b.tokenAgeDays;
  const token = !b.connected ? bad("not connected")
    : age === null ? warn("connected, age unknown")
      : age >= 90 ? bad(`${age.toFixed(1)} days old: reconnect Etsy`) : age >= 80 ? warn(`${age.toFixed(1)} days old: reconnect soon (90 days)`) : ok(`${age.toFixed(1)} days old`);
  const poll = !b.poll ? muted("never")
    : `${esc(when(b.poll.at))} ${b.poll.ok ? ok("ok") : bad("failed")}`;
  return `<h3>Etsy</h3>
  <p>Token: ${token}${b.shop ? ` <span class="small muted">· shop ${esc(b.shop)}</span>` : ""}</p>
  <p>Last poll: ${poll}</p>
  ${b.poll?.error ? `<p>Last poll error (${esc(when(b.poll.error.at))}): <span class="bad">${esc(b.poll.error.message)}</span></p>` : "<p>Last poll error: none</p>"}
  <p>Listing ids: ${b.listings ? ok(`configured (${b.listings})`) : bad("empty: no order is stored")}</p>`;
}

function machineSection({ machine, storage, keys, legalMissing = [] }) {
  const power = machine.power;
  const powerLine = !power?.source ? muted("unknown")
    : power.source === "AC Power" ? ok("on the power adapter") : bad("on battery: the Mac sleeps as usual");
  const battery = power?.battery !== null && power?.battery !== undefined ? ` · battery ${esc(power.battery)} % (${esc(power.state)})` : power?.source ? " · no battery" : "";
  const ac = machine.sleep?.["AC Power"];
  const sleepAc = ac ? (ac.sleep === "0" ? ok("sleep 0 (never) on the adapter") : bad(`sleep ${ac.sleep} on the adapter: set it to 0 (runbook, Power)`)) : muted("unknown");
  const sleepLines = machine.sleep
    ? Object.entries(machine.sleep).map(([profile, s]) => `${esc(profile)}: sleep ${esc(s.sleep ?? "–")}, disksleep ${esc(s.disksleep ?? "–")}, displaysleep ${esc(s.displaysleep ?? "–")}, tcpkeepalive ${esc(s.tcpkeepalive ?? "–")}`).join("<br>")
    : "";
  const freeShare = storage.free !== null && storage.total ? storage.free / storage.total : null;
  const free = storage.free === null ? muted("unknown")
    : freeShare < 0.05 || storage.free < 10 * 1024 ** 3 ? bad(`${size(storage.free)} free`) : freeShare < 0.15 ? warn(`${size(storage.free)} free`) : ok(`${size(storage.free)} free`);
  const backupAgeH = storage.backup ? (Date.now() - new Date(storage.backup.at).getTime()) / 3600000 : null;
  const backup = !storage.backup ? bad("none")
    : `<code>${esc(storage.backup.name)}</code> · ${esc(when(storage.backup.at))} · ${esc(size(storage.backup.bytes))} ${backupAgeH > 36 ? bad("older than 36 h") : ""}<span class="small muted"> (${esc(storage.backup.count)} kept)</span>`;
  return `<div class="grid">
<section><h2>Machine</h2>
  <p>Mac uptime: <b>${esc(duration(machine.uptimeSeconds))}</b></p>
  <p>Power: ${powerLine}${battery}</p>
  <p>Sleep: ${sleepAc}</p>
  ${sleepLines ? `<p class="small muted">${sleepLines}</p>` : ""}
  <p>macOS ${esc(machine.macos ?? "–")} · node ${esc(machine.node)}</p>
</section>
<section><h2>Storage</h2>
  <p>Disk: ${free}${storage.total ? ` <span class="small muted">of ${esc(size(storage.total))}</span>` : ""}</p>
  <table><tbody>${storage.sizes.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${esc(size(s.bytes))}</td></tr>`).join("")}</tbody></table>
  <p>Last database backup: ${backup}</p>
  <p class="small muted">Sizes are measured at most once a minute.</p>
</section>
<section><h2>Keys in .env</h2>
  <table><tbody>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td>${k.set ? ok("set") : bad("missing")}</td></tr>`).join("")}</tbody></table>
  ${legalMissing.length ? `<p>${warn("Legal details missing in .env")} <span class="small muted">${esc(legalMissing.join(", "))}: the privacy, terms, contact and legal notice pages show "Not set".</span></p>` : `<p>Legal details: ${ok("set")}</p>`}
  <p class="small muted">Only whether each is set; values are never shown.</p>
</section>
</div>`;
}

function logsSection(logs) {
  return `<section><h2>Logs</h2>
  ${logs.length ? `<table><thead><tr><th>File</th><th class="num">Size</th><th>Last change</th><th></th></tr></thead><tbody>
    ${logs.map((l) => `<tr><td><code>${esc(l.name)}</code></td><td class="num">${esc(size(l.bytes))}</td><td>${esc(when(l.at))}</td>
      <td><a class="btn ghost" href="/logs/${encodeURIComponent(l.name)}">Show last 100 lines</a></td></tr>`).join("")}
  </tbody></table>` : '<p class="muted">The log folder is empty or missing.</p>'}
</section>`;
}

// Buy first (PN-08): prepaid codes paid 30 days ago with no design yet; each goes once the buyer
// makes one (the nightly job delivers it) or the order is refunded.
export function prepaidNotes(list = []) {
  return list.map((p) => `<div class="note waiting alert">${warn("Paid, no design yet")}
    Receipt <b>${esc(p.receiptId ?? "unknown")}</b> · code <code>${esc(p.code)}</code> <span class="small muted">paid ${esc(when(p.paidAt))} · runbook: Paid, no design yet</span></div>`).join("");
}

// Bought first (PN-08 follow-up): paid 7 days ago or more and the order number not entered on /order
// yet; each goes once the buyer redeems it or the order is refunded.
export function notRedeemedNotes(list = []) {
  return list.map((o) => `<div class="note waiting alert">${warn("Paid 7+ days ago, not redeemed yet: message the buyer on Etsy")}
    Receipt <b>${esc(o.receiptId)}</b> <span class="small muted">paid ${esc(when(o.paidAt))} · runbook: Not redeemed yet</span></div>`).join("");
}

export function mainPage(data, { csrf, lastAction, websiteUrl }) {
  const message = lastAction
    ? `<p class="note${lastAction.ok ? "" : " bad"}">${esc(when(lastAction.at))}: ${esc(lastAction.text)}</p>`
    : "";
  const legal = data.legalMissing?.length ? `<p class="note bad">${warn("Legal details missing in .env")}</p>` : "";
  // Paid after the design was deleted: red until Alex clicks Done (after refunding on Etsy).
  const alerts = (data.alerts || []).map((a) => `<div class="note bad alert">${bad("Paid, but the design was deleted: refund on Etsy")}
    Receipt <b>${esc(a.receiptId ?? "unknown")}</b> · code <code>${esc(a.code)}</code> <span class="small muted">${esc(when(a.at))}</span>
    <form method="post" action="/alerts/${esc(a.id)}/done" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="btn" type="submit">Done</button></form></div>`).join("");
  return layout("IS control", `${alerts}${prepaidNotes(data.business?.prepaidNoDesign)}${notRedeemedNotes(data.business?.notRedeemed)}${message}${legal}
${agentsSection(data, csrf)}
${healthSection(data)}
${businessSection(data.business, websiteUrl)}
${machineSection(data)}
${logsSection(data.logs)}`, { refresh: true, status: `Updated ${new Date().toLocaleTimeString("en-GB")}` });
}

export function confirmPage({ label, action, csrf }) {
  const info = AGENT_INFO[label];
  return layout("IS control: confirm", `<section><h2>${esc(ACTION_TEXT[action])} ${esc(info.name)}?</h2>
  <p class="note bad">${esc(CONFIRM[label][action])}</p>
  <div class="buttons" style="margin-top:12px">
    <form method="post" action="/agents/${label}/${action}"><input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="confirm" value="1"><button class="btn danger" type="submit">Yes, ${esc(ACTION_TEXT[action].toLowerCase())} ${esc(label)}</button></form>
    <a class="btn ghost" href="/">Cancel</a>
  </div></section>`);
}

// cloudflared writes ERR and WRN.
const HIGHLIGHT = /error|warn|traceback|\bERR\b|\bWRN\b/i;

export function logPage(name, lines) {
  const body = lines.length
    ? lines.map((line) => (HIGHLIGHT.test(line) ? `<span class="hl">${esc(line)}</span>` : `${esc(line)}\n`)).join("")
    : "(empty)";
  return layout(`IS control: ${name}`, `<section><h2>${esc(name)}: last ${lines.length} lines</h2>
  <p class="small muted">Lines with error, warn or traceback are highlighted. <a href="/logs/${encodeURIComponent(name)}">Reload</a></p>
  <pre class="log">${body}</pre></section>`);
}

export function messagePage(title, text) {
  return layout(`IS control: ${title}`, `<section><h2>${esc(title)}</h2><p>${esc(text)}</p><p><a class="btn ghost" href="/">Back</a></p></section>`);
}

// Auto-refresh every 10 s unless paused (the switch is remembered in this browser only).
export const REFRESH_SCRIPT = `const box = document.getElementById("pause");
const KEY = "is-control-pause";
try { box.checked = localStorage.getItem(KEY) === "1"; } catch {}
box.addEventListener("change", () => { try { localStorage.setItem(KEY, box.checked ? "1" : "0"); } catch {} });
setInterval(() => { if (!box.checked && !document.hidden) location.replace("/"); }, 10000);
`;
