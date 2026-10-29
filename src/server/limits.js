// The design and code limits of spec section 13, checked before anything reaches the provider:
// - designs per hashed IP: config.designsPerIpPerDay in any 24 h (rolling);
// - designs in total: config.dailyDesignCap per calendar day in Europe/Paris;
// - new codes per hashed IP: CODES_PER_IP_PER_DAY in any 24 h (rolling).
// A design counts once it is queued and stays counted unless it ends before the provider is called
// (queries.js COUNTED_DESIGN_SQL); automatic re-runs never count. Refusals answer the IS error
// code "busy": 503 for the daily cap (as a full queue), 429 for the per-IP limits.
// The hashed IPs are needed for 24 h only: forgetOldIps clears older ones (every hour in the
// server, and in the nightly job), so the privacy policy's 24 h holds.

export const CODES_PER_IP_PER_DAY = 5;
export const DAY_MS = 24 * 60 * 60 * 1000;
const CAP_ZONE = "Europe/Paris";

// Minutes east of UTC of timeZone at the instant t.
function zoneOffsetMinutes(t, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(t).find((p) => p.type === "timeZoneName").value;
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name);
  return m?.[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// The instant the calendar day of `now` began in Europe/Paris.
export function parisDayStart(now = new Date()) {
  const [y, mo, d] = new Intl.DateTimeFormat("en-CA", { timeZone: CAP_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("-").map(Number);
  const midnightUtc = Date.UTC(y, mo - 1, d);
  // The offset at midnight itself (a DST change happens at 02:00 or 03:00, never at midnight).
  let start = midnightUtc - zoneOffsetMinutes(new Date(midnightUtc), CAP_ZONE) * 60000;
  start = midnightUtc - zoneOffsetMinutes(new Date(start), CAP_ZONE) * 60000;
  return new Date(start);
}

export function createLimits({ q, config, now = () => new Date() }) {
  return {
    // null when ipHash may make one more design now, else { status, error }.
    designRefusal(ipHash) {
      const t = now();
      if (q.countDesignsSince(parisDayStart(t).toISOString()) >= config.dailyDesignCap) return { status: 503, error: "busy" };
      if (q.countIpDesignsSince(new Date(t.getTime() - DAY_MS).toISOString(), ipHash) >= config.designsPerIpPerDay) return { status: 429, error: "busy" };
      return null;
    },
    // null when ipHash may get one more new code now, else { status, error }.
    codeRefusal(ipHash) {
      const since = new Date(now().getTime() - DAY_MS).toISOString();
      return q.countIpCodesSince(since, ipHash) >= CODES_PER_IP_PER_DAY ? { status: 429, error: "busy" } : null;
    },
    // Clears the hashed IPs of codes and designs made more than 24 h ago; returns how many.
    forgetOldIps() {
      return q.forgetIpHashes(new Date(now().getTime() - DAY_MS).toISOString());
    }
  };
}
