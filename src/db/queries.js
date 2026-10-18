import { generateCode } from "./codes.js";

// Queries on the IS database (spec section 4.1). Rows come back with the column names.
// JSON columns (settings_json, result_json) are stored as text; callers pass objects.

const CODE_FIELDS = [
  "consent_at", "attempts_used", "selected_attempt", "status", "paid_at",
  "receipt_id", "transaction_id", "downloads", "delivery_expires_at"
];

const ATTEMPT_FIELDS = [
  "status", "stage", "settings_json", "result_json", "error_code", "finished_at", "counts"
];

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
    insertEtsyOrder: db.prepare(`
      INSERT INTO etsy_orders
        (receipt_id, transaction_id, listing_id, personalization, matched_code, paid_at, status, seen_at)
      VALUES
        (@receipt_id, @transaction_id, @listing_id, @personalization, @matched_code, @paid_at, @status, @seen_at)`),
    listUnmatchedOrders: db.prepare(
      "SELECT rowid AS id, * FROM etsy_orders WHERE matched_code IS NULL ORDER BY seen_at DESC"
    ),
    insertEvent: db.prepare("INSERT INTO events (at, code, kind, detail) VALUES (?, ?, ?, ?)"),
    listEvents: db.prepare("SELECT * FROM events WHERE code = ? ORDER BY at, rowid")
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

    insertEtsyOrder(order) {
      return statements.insertEtsyOrder.run({
        listing_id: null,
        personalization: null,
        matched_code: null,
        paid_at: null,
        status: null,
        seen_at: now(),
        ...order
      }).lastInsertRowid;
    },

    listUnmatchedOrders: () => statements.listUnmatchedOrders.all(),

    logEvent(kind, { code = null, detail = null } = {}) {
      const text = detail === null || typeof detail === "string" ? detail : JSON.stringify(detail);
      statements.insertEvent.run(now(), code, kind, text);
    },

    listEvents: (code) => statements.listEvents.all(code)
  };
}
