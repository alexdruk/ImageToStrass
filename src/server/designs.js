import express from "express";
import { normalizeCode } from "../db/codes.js";
import { DesignRefused } from "../pipeline/design.js";
import { clientIp } from "./client.js";

// POST /api/attempts/<code> (Create design) and GET /api/attempts/<code>/<n> (the Working screen
// polls it every 3 s). Answers carry IS fields only; refusals are { error: <IS code> } (spec 12).

export function designRoutes({ pipeline, verifyTurnstile, log = console }) {
  const router = express.Router();

  router.post("/api/attempts/:code", async (req, res) => {
    const code = normalizeCode(req.params.code);
    const body = req.body && typeof req.body === "object" ? req.body : {};

    if (!code) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    if (!(await verifyTurnstile(body["cf-turnstile-response"], clientIp(req)))) {
      res.status(403).json({ error: "verification" });
      return;
    }

    try {
      const attempt = await pipeline.createDesign(code, body);
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
