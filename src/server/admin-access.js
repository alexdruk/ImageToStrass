import crypto from "node:crypto";

// Who may reach /admin, /auth/etsy, /oauth/callback and the /etsy/* routes (spec sections 11.2 and
// 11.4): a request made on this Mac directly, or one carrying ADMIN_TOKEN in the x-admin-token
// header. Everything through the tunnel comes from cloudflared on loopback too, but always with a
// CF-Connecting-IP header, so "on this Mac" means a loopback peer, no such header and a loopback
// Host (a web page cannot reach the routes through a rebound DNS name).

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

export function isLocalRequest(req) {
  return LOOPBACK.has(req.socket.remoteAddress) &&
    !req.get("cf-connecting-ip") &&
    LOCAL_HOST.test(req.get("host") || "");
}

export function hasAdminToken(req, token) {
  const given = req.get("x-admin-token");
  if (!token || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

export const isAdmin = (req, config) => isLocalRequest(req) || hasAdminToken(req, config.adminToken);

// Middleware: anyone else gets the plain 404 of an unknown path.
export function adminOnly(config) {
  return (req, res, next) => {
    if (isAdmin(req, config)) next();
    else res.status(404).json({ error: "not-found" });
  };
}
