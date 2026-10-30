import { extractCodes } from "../db/codes.js";

// Etsy receipts -> IS orders (spec section 11.3). Pure: no database, no network. A receipt is the
// ShopReceipt of Etsy Open API v3 (getShopReceipts), each with its transactions and refunds.

// Etsy's property id of the buyer's personalization text on a transaction's variations.
export const PERSONALIZATION_PROPERTY_ID = 54;

// Receipt states that lock the download (spec 11.3: refund or cancellation).
const REFUNDED_STATES = new Set(["canceled", "cancelled", "fully refunded", "partially refunded"]);

// The personalization text of a transaction: its variation named Personalization (Etsy's property
// 54). When that holds no code (or there is none), every variation's text, if any of them holds a
// code (PN-07: Etsy may file the field under another property id or name). "" when the buyer gave
// none.
export function personalizationOf(transaction) {
  const variations = transaction.variations || [];
  const text = (list) => list.map((v) => String(v.formatted_value ?? "")).join("\n");
  const exact = text(variations.filter((v) => v.property_id === PERSONALIZATION_PROPERTY_ID ||
    /^personali[sz]ation$/i.test(String(v.formatted_name || "").trim())));
  if (extractCodes(exact).length) return exact;
  const all = text(variations);
  return extractCodes(all).length ? all : exact;
}

export function isRefunded(receipt) {
  return REFUNDED_STATES.has(String(receipt.status || "").toLowerCase()) ||
    (Array.isArray(receipt.refunds) && receipt.refunds.length > 0);
}

const isoOf = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

// One order per transaction of a listing in listingIds:
// { receipt_id, transaction_id, listing_id, personalization, codes, paid_at, status: paid | refunded,
//   quantity } (quantity: the units bought, PN-08; 1 when Etsy gives none).
// Other listings of the shop are left out entirely. Codes are normalised (spec section 5).
export function ordersFromReceipts(receipts, listingIds) {
  const wanted = new Set(listingIds.map(Number));
  const orders = [];

  for (const receipt of receipts) {
    if (receipt.is_paid === false) continue;
    const status = isRefunded(receipt) ? "refunded" : "paid";

    for (const transaction of receipt.transactions || []) {
      if (!wanted.has(Number(transaction.listing_id))) continue;
      const personalization = personalizationOf(transaction);
      orders.push({
        receipt_id: receipt.receipt_id,
        transaction_id: transaction.transaction_id,
        listing_id: transaction.listing_id,
        personalization,
        codes: extractCodes(personalization),
        paid_at: isoOf(transaction.paid_timestamp) ?? isoOf(receipt.created_timestamp ?? receipt.create_timestamp),
        status,
        quantity: Number.isInteger(transaction.quantity) && transaction.quantity > 0 ? transaction.quantity : 1
      });
    }
  }

  return orders;
}
