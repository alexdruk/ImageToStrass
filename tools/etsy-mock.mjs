// The Etsy API in tests (spec section 11): no automated test reaches Etsy. etsyMock answers the three
// calls IS makes, from recorded JSON (tools/fixtures/etsy/); noEtsy fails any call.
import path from "node:path";

export const noEtsy = async (apiPath) => {
  throw new Error(`Etsy API request failed (no Etsy in tests): ${apiPath}`);
};

// The Etsy files of a test server in its own folder, never data/.
export function etsyTestConfig(etsy, root, extra = {}) {
  return { ...etsy, shopFile: path.join(root, "etsy-shop.json"), stateFile: path.join(root, "etsy-poller.json"), ...extra };
}

// request(path) like etsyApiRequest. receipts() -> the shop's receipts now (a function, so a test can
// change them between polls). getShopReceipts is answered as Etsy does: was_paid, min_last_modified
// (on updated_timestamp), limit and offset; count is the number of matches.
export function etsyMock({ user = { user_id: 900001, shop_id: 41000001 }, shop, receipts = () => [] }) {
  const calls = [];
  const request = async (apiPath) => {
    const url = new URL(apiPath, "https://api.etsy.invalid/v3");
    calls.push(apiPath);
    if (url.pathname === "/application/users/me") return user;
    if (url.pathname === `/application/users/${user.user_id}/shops`) return shop;
    const match = url.pathname.match(/^\/application\/shops\/(\d+)\/receipts$/);
    if (match && Number(match[1]) === shop.shop_id) {
      const p = url.searchParams;
      const since = Number(p.get("min_last_modified") ?? 0);
      const all = receipts()
        .filter((r) => p.get("was_paid") !== "true" || r.is_paid)
        .filter((r) => r.updated_timestamp >= since)
        .sort((a, b) => a.updated_timestamp - b.updated_timestamp);
      const limit = Number(p.get("limit") ?? 25);
      const offset = Number(p.get("offset") ?? 0);
      return { count: all.length, results: all.slice(offset, offset + limit) };
    }
    throw new Error(`Etsy API request failed (404): ${apiPath}`);
  };
  return { request, calls };
}
