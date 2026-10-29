import { generateCode } from "./codes.js";

// Queries on the IS database (spec section 4.1). Rows come back with the column names.
// JSON columns (settings_json, result_json) are stored as text; callers pass objects.

const CODE_FIELDS = [
  "consent_at", "attempts_used", "selected_attempt", "status", "paid_at",
  "receipt_id", "transaction_id", "downloads", "delivery_expires_at", "last_seen_at", "files_deleted_at"
];

const ATTEMPT_FIELDS = [
  "status", "stage", "settings_json", "result_json", "error_code", "finished_at", "counts", "ip_hash"
];

// A design that uses up the per-IP limit and the daily cap (spec 13): made by a buyer (not an
// automatic re-run, 7.4) and waiting, running or past the "preparing" stage, i.e. it reached the
// provider or is about to. The control panel counts with the same condition.
export const COUNTED_DESIGN_SQL = `json_extract(settings_json, '$.rerunOf') IS NULL
  AND (status IN ('queued', 'running') OR (stage IS NOT NULL AND stage <> 'preparing'))`;

function now() {
  return new Date().toISOString();
}

function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseAttempt(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    settings: row.settings_json ? JSON.parse(row.settings_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null
  };
}

// Builds "a = @a, b = @b" from a fixed list of allowed columns only.
function assignments(fields, allowed) {
  const names = Object.keys(fields);

  for (const name of names) {
    if (!allowed.includes(name)) {
      throw new Error(`Unknown column: ${name}`);
    }
  }

  if (names.length === 0) {
    throw new Error("Nothing to update.");
  }

  return names.map((name) => `${name} = @${name}`).join(", ");
}

export function createQueries(db) {
  const statements = {
    codeExists: db.prepare("SELECT 1 FROM codes WHERE code = ?").pluck(),
    insertCode: db.prepare(`
      INSERT INTO codes (code, created_at, ip_hash, consent_at)
      VALUES (@code, @created_at, @ip_hash, @consent_at)`),
    getCode: db.prepare("SELECT * FROM codes WHERE code = ?"),
    nextAttempt: db.prepare("SELECT COALESCE(MAX(n), 0) + 1 FROM attempts WHERE code = ?").pluck(),
    insertAttempt: db.prepare(`
      INSERT INTO attempts (code, n, status, settings_json, created_at)
      VALUES (@code, @n, 'queued', @settings_json, @created_at)`),
    getAttempt: db.prepare("SELECT * FROM attempts WHERE code = ? AND n = ?"),
    listAttempts: db.prepare("SELECT * FROM attempts WHERE code = ? ORDER BY n"),
    countedAttempts: db.prepare("SELECT COUNT(*) FROM attempts WHERE code = ? AND counts = 1").pluck(),
    listActiveAttempts: db.prepare(
      "SELECT * FROM attempts WHERE status IN ('queued', 'running') ORDER BY created_at, code, n"
    ),
    // Re-polls update the row of the same (transaction_id, matched_code); see MIGRATIONS[0].
    upsertEtsyOrder: db.prepare(`
      INSERT INTO etsy_orders
        (receipt_id, transaction_id, listing_id, personalization, matched_code, paid_at, status, seen_at)
      VALUES
        (@receipt_id, @transaction_id, @listing_id, @personalization, @matched_code, @paid_at, @status, @seen_at)
      ON CONFLICT (transaction_id, IFNULL(matched_code, '')) DO UPDATE SET
        receipt_id = excluded.receipt_id,
        listing_id = excluded.listing_id,
        personalization = excluded.personalization,
        paid_at = excluded.paid_at,
        status = excluded.status,
        seen_at = excluded.seen_at`),
    getEtsyOrder: db.prepare(`
      SELECT rowid AS id, * FROM etsy_orders
      WHERE transaction_id = ? AND IFNULL(matched_code, '') = IFNULL(?, '')`),
    listUnmatchedOrders: db.prepare(
      "SELECT rowid AS id, * FROM etsy_orders WHERE matched_code IS NULL ORDER BY seen_at DESC"
    ),
    getEtsyOrderById: db.prepare("SELECT rowid AS id, * FROM etsy_orders WHERE rowid = ?"),
    listTransactionOrders: db.prepare(
      "SELECT rowid AS id, * FROM etsy_orders WHERE transaction_id = ? ORDER BY rowid"
    ),
    deleteUnmatchedOrder: db.prepare("DELETE FROM etsy_orders WHERE transaction_id = ? AND matched_code IS NULL"),
    setOrderCode: db.prepare("UPDATE etsy_orders SET matched_code = ? WHERE rowid = ? AND matched_code IS NULL"),
    listRecentOrders: db.prepare("SELECT rowid AS id, * FROM etsy_orders ORDER BY seen_at DESC, rowid DESC LIMIT ?"),
    listAttemptsSince: db.prepare("SELECT * FROM attempts WHERE created_at >= ? ORDER BY created_at DESC, code, n"),
    listRecentFailures: db.prepare(
      "SELECT * FROM attempts WHERE status IN ('failed', 'declined') ORDER BY finished_at DESC LIMIT ?"
    ),
    // ISO times compare as text. Nightly job: paid codes whose 30 days are over.
    listExpiredPaidCodes: db.prepare(
      "SELECT code FROM codes WHERE status = 'paid' AND delivery_expires_at IS NOT NULL AND delivery_expires_at <= ?"
    ).pluck(),
    insertEvent: db.prepare("INSERT INTO events (at, code, kind, detail) VALUES (?, ?, ?, ?)"),
    // Limits (spec 13): designs since a time, all or from one hashed IP; codes made from one IP.
    countDesignsSince: db.prepare(`SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND ${COUNTED_DESIGN_SQL}`).pluck(),
    countIpDesignsSince: db.prepare(`SELECT COUNT(*) FROM attempts WHERE created_at >= ? AND ip_hash = ? AND ${COUNTED_DESIGN_SQL}`).pluck(),
    countIpCodesSince: db.prepare("SELECT COUNT(*) FROM codes WHERE created_at >= ? AND ip_hash = ?").pluck(),
    listEvents: db.prepare("SELECT * FROM events WHERE code = ? ORDER BY at, rowid"),
    firstEvent: db.prepare("SELECT * FROM events WHERE code = ? AND kind = ? ORDER BY at, rowid LIMIT 1"),
    // Keeping data (D7): every code whose files are not deleted yet, with its last activity (the
    // latest of its creation, its last visit, its events and its designs) and whether a design of
    // it is still queued or running. ISO times compare as text.
    listKeptCodes: db.prepare(`
      SELECT c.code, c.status, c.paid_at, c.delivery_expires_at,
        MAX(c.created_at, IFNULL(c.last_seen_at, ''),
          IFNULL((SELECT MAX(at) FROM events e WHERE e.code = c.code), ''),
          IFNULL((SELECT MAX(MAX(created_at, IFNULL(finished_at, ''))) FROM attempts a WHERE a.code = c.code), '')
        ) AS last_active_at,
        EXISTS (SELECT 1 FROM attempts a WHERE a.code = c.code AND a.status IN ('queued', 'running')) AS active
      FROM codes c WHERE c.files_deleted_at IS NULL`),
    // The hashed IP is kept only as long as the limits need it (24 h, spec 13).
    forgetCodeIps: db.prepare("UPDATE codes SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?"),
    forgetAttemptIps: db.prepare("UPDATE attempts SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?")
  };

  const codeExists = (code) => statements.codeExists.get(code) === 1;

  const createCode = db.transaction(({ ipHash = null, consentAt = null } = {}) => {
    const code = generateCode(codeExists);

    statements.insertCode.run({
      code,
      created_at: now(),
      ip_hash: ipHash,
      consent_at: consentAt
    });

    return statements.getCode.get(code);
  });

  const createAttempt = db.transaction((code, settings) => {
    const n = statements.nextAttempt.get(code);

    statements.insertAttempt.run({
      code,
      n,
      settings_json: toJson(settings),
      created_at: now()
    });

    return parseAttempt(statements.getAttempt.get(code, n));
  });

  return {
    codeExists,
    createCode,
    getCode: (code) => statements.getCode.get(code) ?? null,

    updateCode(code, fields) {
      const sql = `UPDATE codes SET ${assignments(fields, CODE_FIELDS)} WHERE code = @code`;
      return db.prepare(sql).run({ ...fields, code }).changes === 1;
    },

    createAttempt,
    getAttempt: (code, n) => parseAttempt(statements.getAttempt.get(code, n)),
    listAttempts: (code) => statements.listAttempts.all(code).map(parseAttempt),
    // The 3-design limit (D5) counts only attempts with counts = 1.
    countedAttempts: (code) => statements.countedAttempts.get(code),
    // Queued and running attempts of every code, oldest first (the queue after a restart).
    listActiveAttempts: () => statements.listActiveAttempts.all().map(parseAttempt),

    updateAttempt(code, n, fields) {
      const values = { ...fields };

      if ("settings" in values) {
        values.settings_json = toJson(values.settings);
        delete values.settings;
      }

      if ("result" in values) {
        values.result_json = toJson(values.result);
        delete values.result;
      }

      const sql = `UPDATE attempts SET ${assignments(values, ATTEMPT_FIELDS)} WHERE code = @code AND n = @n`;
      return db.prepare(sql).run({ ...values, code, n }).changes === 1;
    },

    // One row per (transaction_id, matched_code); a re-poll updates it. Returns the row.
    upsertEtsyOrder(order) {
      const values = {
        listing_id: null,
        personalization: null,
        matched_code: null,
        paid_at: null,
        status: null,
        seen_at: now(),
        ...order
      };

      statements.upsertEtsyOrder.run(values);
      return statements.getEtsyOrder.get(values.transaction_id, values.matched_code);
    },

    getEtsyOrder: (transactionId, code) => statements.getEtsyOrder.get(transactionId, code ?? null) ?? null,
    getEtsyOrderById: (id) => statements.getEtsyOrderById.get(id) ?? null,
    listUnmatchedOrders: () => statements.listUnmatchedOrders.all(),
    listTransactionOrders: (transactionId) => statements.listTransactionOrders.all(transactionId),
    // Once a transaction is matched to a code, its "no code" row goes.
    deleteUnmatchedOrder: (transactionId) => statements.deleteUnmatchedOrder.run(transactionId).changes,
    // Admin "match to code": the unmatched row id gets the code. False when it was matched already.
    setOrderCode: (id, code) => statements.setOrderCode.run(code, id).changes === 1,
    listRecentOrders: (limit = 50) => statements.listRecentOrders.all(limit),
    // Admin page: designs created since an ISO time, newest first; the latest failures.
    listAttemptsSince: (iso) => statements.listAttemptsSince.all(iso).map(parseAttempt),
    listRecentFailures: (limit = 20) => statements.listRecentFailures.all(limit).map(parseAttempt),

    logEvent(kind, { code = null, detail = null } = {}) {
      const text = detail === null || typeof detail === "string" ? detail : JSON.stringify(detail);
      statements.insertEvent.run(now(), code, kind, text);
    },

    listExpiredPaidCodes: (iso) => statements.listExpiredPaidCodes.all(iso),
    listEvents: (code) => statements.listEvents.all(code),
    // The first event of a kind for a code (the withdrawal consent at download), or null.
    firstEvent: (code, kind) => statements.firstEvent.get(code, kind) ?? null,
    listKeptCodes: () => statements.listKeptCodes.all(),
    // Hashed IPs of codes and designs made before iso are cleared. Returns how many rows changed.
    forgetIpHashes: (iso) => statements.forgetCodeIps.run(iso).changes + statements.forgetAttemptIps.run(iso).changes,

    countDesignsSince: (iso) => statements.countDesignsSince.get(iso),
    countIpDesignsSince: (iso, ipHash) => statements.countIpDesignsSince.get(iso, ipHash),
    countIpCodesSince: (iso, ipHash) => statements.countIpCodesSince.get(iso, ipHash)
  };
}
