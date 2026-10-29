import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import express from "express";
import { isLocalRequest } from "../server/admin-access.js";
import { loadConfig, missingLegal } from "../server/config.js";
import { AGENT_INFO, CONFIRM, REFRESH_SCRIPT, confirmPage, logPage, mainPage, messagePage } from "./page.js";
import {
  AGENTS, LOG_NAME, agents, business, cached, folderSizes, health, listLogs, machine, nightlySummary, runCommand,
  storage, tailLines, timedGet, tunnel
} from "./probes.js";

// The control panel (PN-05, spec section 15.1): one local page with the state of the agents, health,
// business figures, the machine, storage and logs, and buttons to start, stop and restart the
// agents. Its own process (com.is.control) on 127.0.0.1:IS_CONTROL_PORT (3010), so it works while
// the website server is down. Never through the tunnel: a request with CF-Connecting-IP or a
// non-loopback Host gets the plain 404, as /admin does (spec 11.2). Every button is a POST carrying
// a token made at start-up. It reads the database and the server's files, never writes them.

// Keys whose presence the page shows ("set" or "missing"), never their values.
const KEYS = [
  ["Image provider key", "OPENAI_API_KEY"],
  ["TOKEN_ENCRYPTION_KEY", "TOKEN_ENCRYPTION_KEY"],
  ["ETSY_KEYSTRING", "ETSY_KEYSTRING"],
  ["ETSY_SHARED_SECRET", "ETSY_SHARED_SECRET"],
  ["TURNSTILE_SITE_KEY", "TURNSTILE_SITE_KEY"],
  ["TURNSTILE_SECRET_KEY", "TURNSTILE_SECRET_KEY"],
  ["ADMIN_TOKEN", "ADMIN_TOKEN"]
];

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function loadControlConfig(env = process.env, root = process.cwd()) {
  const server = loadConfig(env);
  const at = (p) => path.resolve(root, p);
  return {
    root,
    host: "127.0.0.1",
    port: Number(env.IS_CONTROL_PORT || 3010),
    uid: process.getuid(),
    home: homedir(),
    websiteUrl: `http://127.0.0.1:${server.port}`,
    strassUrl: server.strassServiceUrl,
    publicUrl: server.publicBaseUrl || "https://patternnifty.com",
    dbFile: at(server.dbFile),
    archiveDir: at(server.archiveDir),
    deliveryDir: at(server.deliveryDir),
    backupDir: at(server.backupDir),
    pollerFile: at(server.etsy.stateFile),
    shopFile: at(server.etsy.shopFile),
    logsDir: path.resolve(root, server.logsDir),
    dailyCap: server.dailyDesignCap,
    listingIdsCount: server.etsy.listingIds.length,
    keys: KEYS.map(([name, key]) => ({ name, set: Boolean(env[key]) })),
    // The seller's details for the legal pages (PN-07): the names of the required ones left empty.
    legalMissing: missingLegal(env)
  };
}

// launchctl arguments for a button (gui/<uid> domain, as the runbook's commands).
export function launchctlArgs(config, label, action, loaded) {
  const domain = `gui/${config.uid}`;
  if (action === "start") {
    return loaded ? ["kickstart", `${domain}/${label}`] : ["bootstrap", domain, path.join(config.home, "Library", "LaunchAgents", `${label}.plist`)];
  }
  if (action === "stop") return ["bootout", `${domain}/${label}`];
  if (action === "restart") return ["kickstart", "-k", `${domain}/${label}`];
  if (action === "run") return ["kickstart", `${domain}/${label}`];
  throw new Error(`unknown action ${action}`);
}

const DONE_TEXT = { start: "Started", stop: "Stopped", restart: "Restarted", run: "Started a run of" };

export function createControlApp({ config, run = runCommand, fetchFn = fetch, loadTokens = async () => null, log = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  const csrf = crypto.randomBytes(24).toString("base64url");
  let lastAction = null;

  const publicHealth = cached(30000, () => timedGet(fetchFn, `${config.publicUrl}/health`, 8000));
  const sizes = cached(60000, () => folderSizes({ run, config }));

  // This Mac only (loopback peer, no CF-Connecting-IP, loopback Host); anyone else: plain 404.
  app.use((req, res, next) => {
    if (isLocalRequest(req)) return next();
    res.status(404).type("text").send("Not found");
  });
  app.use((req, res, next) => {
    res.set("Content-Security-Policy", CSP).set("Cache-Control", "no-store").set("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "2kb" }));

  const html = (res, status, body) => res.status(status).type("html").send(body);
  const tokenOk = (req) => {
    const given = Buffer.from(String(req.body?.csrf ?? ""));
    const want = Buffer.from(csrf);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  app.get("/", async (req, res) => {
    const agentsData = await agents({ run });
    const [healthData, tunnelData, businessData, machineData, storageData, nightly] = await Promise.all([
      health({ fetchFn, config, publicHealth }),
      tunnel({ fetchFn, config }),
      business({ config, loadTokens }),
      machine({ run }),
      storage({ config, sizes }),
      nightlySummary(config.logsDir)
    ]);
    const data = {
      agents: agentsData, health: healthData, tunnel: tunnelData, business: businessData, machine: machineData,
      storage: storageData, nightly, logs: listLogs(config.logsDir), keys: config.keys,
      legalMissing: config.legalMissing
    };
    const recent = lastAction && Date.now() - lastAction.at < 10 * 60 * 1000 ? lastAction : null;
    html(res, 200, mainPage(data, { csrf, lastAction: recent, websiteUrl: config.websiteUrl }));
  });

  app.get("/control.js", (req, res) => res.type("js").send(REFRESH_SCRIPT));

  app.get("/logs/:name", async (req, res) => {
    const { name } = req.params;
    // Only a file the folder listing shows: no paths, no other files.
    if (!LOG_NAME.test(name) || !listLogs(config.logsDir).some((l) => l.name === name)) {
      return html(res, 404, messagePage("No such log", "That file is not in the log folder."));
    }
    try {
      html(res, 200, logPage(name, await tailLines(path.join(config.logsDir, name), 100)));
    } catch {
      html(res, 500, messagePage("Log not readable", "The file could not be read."));
    }
  });

  app.post("/agents/:label/:action", async (req, res) => {
    const { label, action } = req.params;
    if (!tokenOk(req)) return html(res, 403, messagePage("Refused", "The page had expired (the control panel was restarted). Open the control panel again and retry."));
    if (!AGENTS.includes(label) || !AGENT_INFO[label].actions.includes(action)) {
      return html(res, 404, messagePage("Not possible", "That agent has no such button."));
    }
    if (CONFIRM[label]?.[action] && req.body.confirm !== "1") {
      return html(res, 200, confirmPage({ label, action, csrf }));
    }

    const loaded = (await run("launchctl", ["print", `gui/${config.uid}/${label}`])).code === 0;
    const args = launchctlArgs(config, label, action, loaded);

    // Restarting itself: answer first, then let launchd kill and start this process.
    if (label === "com.is.control") {
      lastAction = { at: Date.now(), ok: true, text: `Restarted ${label}.` };
      res.redirect(303, "/");
      setTimeout(() => run("launchctl", args), 500);
      return;
    }

    const out = await run("launchctl", args);
    const detail = (out.stderr || out.stdout).trim().split("\n")[0].slice(0, 200);
    lastAction = out.code === 0
      ? { at: Date.now(), ok: true, text: `${DONE_TEXT[action]} ${label}.` }
      : { at: Date.now(), ok: false, text: `launchctl ${args[0]} ${label} failed (exit ${out.code})${detail ? `: ${detail}` : ""}` };
    log.log(`control: launchctl ${args.join(" ")} -> ${out.code}`);
    res.redirect(303, "/");
  });

  app.use((req, res) => html(res, 404, messagePage("Not found", "No such page.")));
  return app;
}
