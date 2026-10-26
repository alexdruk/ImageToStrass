// www.patternnifty.com -> https://patternnifty.com, same path and query (spec section 15). The
// public address comes from PUBLIC_BASE_URL; without it (or for any other Host) nothing changes.

export function wwwRedirect(config) {
  let origin = null;
  let wwwHost = null;

  try {
    const base = new URL(config.publicBaseUrl);
    if (!base.hostname.startsWith("www.")) {
      origin = base.origin;
      wwwHost = `www.${base.host}`.toLowerCase();
    }
  } catch {
    // No or no valid PUBLIC_BASE_URL: no redirect.
  }

  return (req, res, next) => {
    if (wwwHost && (req.get("host") || "").toLowerCase() === wwwHost) {
      res.redirect(301, origin + req.originalUrl);
    } else {
      next();
    }
  };
}
