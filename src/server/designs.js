import express from "express";
import { normalizeCode } from "../db/codes.js";
import { DesignRefused } from "../pipeline/design.js";
import { clientIp } from "./client.js";

// POST /api/attempts/<code> (Create design) and GET /api/attempts/<code>/<n> (the Working screen
// polls it every 3 s). Answers carry IS fields only; refusals are { error: <IS code> } (spec 12).
// Create design checks Turnstile, then the per-IP limit and the daily cap (limits.js, spec 13),
// before the design is queued, so nothing refused reaches the provider. The checks and the new
// attempt run one request at a time, so two requests cannot both take the last design.

export function designRoutes({ q, pipeline, verifyTurnstile, limits, hashIp, log = console }) {
  const router = express.Router();
  let line = Promise.resolve();
  const oneAtATime = (fn) => {
    const run = line.then(fn, fn);
    line = run.catch(() => {});
    return run;
  };

  router.post("/api/attempts/:code", async (req, res) => {
    const code = normalizeCode(req.params.code);
    const body = req.body && typeof req.body === "object" ? req.body : {};

    if (!code) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    const ip = clientIp(req);

    if (!(await verifyTurnstile(body["cf-turnstile-response"], ip))) {
      res.status(403).json({ error: "verification" });
      return;
    }

    try {
      const ipHash = hashIp(ip);
      const attempt = await oneAtATime(async () => {
        const refusal = limits.designRefusal(ipHash);
        if (refusal) throw new DesignRefused(refusal.status, refusal.error);
        const created = await pipeline.createDesign(code, body);
        q.updateAttempt(code, created.n, { ip_hash: ipHash });
        return created;
      });
      res.status(202).set("Cache-Control", "no-store").json(pipeline.view(code, attempt.n));
    } catch (error) {
      if (error instanceof DesignRefused) {
        res.status(error.status).json({ error: error.code });
      } else {
        log.error(`Create design failed: ${error.stack || error.message}`);
        res.status(500).json({ error: "failed" });
      }
    }
  });

  router.get("/api/attempts/:code/:n", (req, res) => {
    const code = normalizeCode(req.params.code);
    const n = /^[1-9]\d{0,5}$/.test(req.params.n) ? Number(req.params.n) : null;
    const view = code && n ? pipeline.view(code, n) : null;

    if (!view) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    res.set("Cache-Control", "no-store").json(view);
  });

  return router;
}
