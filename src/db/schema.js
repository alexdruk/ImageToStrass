// SQLite schema (spec section 4.1). Times are ISO 8601 UTC strings.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  code                TEXT PRIMARY KEY,               -- PN-XXXX-XXXX (IS-XXXX-XXXX before PN-01)
  created_at          TEXT NOT NULL,
  ip_hash             TEXT,
  consent_at          TEXT,
  attempts_used       INTEGER NOT NULL DEFAULT 0,
  selected_attempt    INTEGER,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'paid', 'refunded', 'expired')),
  paid_at             TEXT,
  receipt_id          INTEGER,
  transaction_id      INTEGER,
  downloads           INTEGER NOT NULL DEFAULT 0,
  delivery_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  code          TEXT NOT NULL REFERENCES codes(code),
  n             INTEGER NOT NULL CHECK (n >= 1),     -- 1, 2, 3, ... never reused
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed', 'declined')),
  stage         TEXT,
  settings_json TEXT,                                 -- mode, bg removal, adjustments, crop, rotate
  result_json   TEXT,                                 -- stone count, sizes, colours, natural w/h, coverage
  error_code    TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  counts        INTEGER NOT NULL DEFAULT 0 CHECK (counts IN (0, 1)),  -- 1 if it uses one of the 3 designs (D5)
  PRIMARY KEY (code, n)
);

CREATE TABLE IF NOT EXISTS etsy_orders (
  receipt_id      INTEGER NOT NULL,
  transaction_id  INTEGER NOT NULL,
  listing_id      INTEGER,
  personalization TEXT,
  matched_code    TEXT REFERENCES codes(code),
  paid_at         TEXT,
  status          TEXT,
  seen_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS etsy_orders_receipt ON etsy_orders(receipt_id, transaction_id);
CREATE INDEX IF NOT EXISTS etsy_orders_code ON etsy_orders(matched_code);

CREATE TABLE IF NOT EXISTS events (                   -- audit log, local only
  at     TEXT NOT NULL,
  code   TEXT,
  kind   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_code ON events(code, at);
`;

// Migrations, applied in order on top of SCHEMA; PRAGMA user_version holds how many have run.
export const MIGRATIONS = [
  // 1: one etsy_orders row per (transaction_id, matched_code); NULL counts as one value.
  `DELETE FROM etsy_orders WHERE rowid NOT IN (
     SELECT MAX(rowid) FROM etsy_orders GROUP BY transaction_id, IFNULL(matched_code, ''));
   CREATE UNIQUE INDEX etsy_orders_transaction_code
     ON etsy_orders(transaction_id, IFNULL(matched_code, ''));`,
  // 2 (PN-06): the hashed IP of the request that made a design, for the per-IP limit (spec 13);
  // NULL for automatic re-runs and for designs made before PN-06.
  `ALTER TABLE attempts ADD COLUMN ip_hash TEXT;
   CREATE INDEX attempts_created ON attempts(created_at);
   CREATE INDEX codes_ip_created ON codes(ip_hash, created_at);`,
  // 3 (PN-07): keeping data (D7). last_seen_at: the last time the code's session was opened (its
  // last activity counts from the latest of this, its events and its designs); files_deleted_at:
  // when the nightly job deleted its archive folder (the row itself is kept, without images).
  `ALTER TABLE codes ADD COLUMN last_seen_at TEXT;
   ALTER TABLE codes ADD COLUMN files_deleted_at TEXT;`,
  // 4 (PN-07 follow-up): paid after its files were deleted, so it cannot be delivered (refund on Etsy).
  `ALTER TABLE codes ADD COLUMN undeliverable_at TEXT;`,
  // 5: used by PN-08 (buy first), which was rolled back. A database that ran PN-08's migration 5
  // keeps what it added, unused and harmless: 'prepaid' allowed in codes.status (never written
  // now), codes.redeemed_at, etsy_orders.quantity and the index codes_receipt; no row is changed.
  // Every other database gets nothing here, so both are at 5 and the next migration (6) runs on both.
  `SELECT 1;`
];
