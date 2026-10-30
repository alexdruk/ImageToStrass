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
  // 5 (PN-08): buy first, design after. A code may be "prepaid" (made from an Etsy order on /order,
  // redeemed_at set); SQLite cannot change a CHECK, so codes is rebuilt (foreign keys are off while
  // migrations run, see index.js). etsy_orders.quantity: the units of the transaction.
  `CREATE TABLE codes_new (
     code                TEXT PRIMARY KEY,
     created_at          TEXT NOT NULL,
     ip_hash             TEXT,
     consent_at          TEXT,
     attempts_used       INTEGER NOT NULL DEFAULT 0,
     selected_attempt    INTEGER,
     status              TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'prepaid', 'paid', 'refunded', 'expired')),
     paid_at             TEXT,
     receipt_id          INTEGER,
     transaction_id      INTEGER,
     downloads           INTEGER NOT NULL DEFAULT 0,
     delivery_expires_at TEXT,
     last_seen_at        TEXT,
     files_deleted_at    TEXT,
     undeliverable_at    TEXT,
     redeemed_at         TEXT
   );
   INSERT INTO codes_new (code, created_at, ip_hash, consent_at, attempts_used, selected_attempt, status,
     paid_at, receipt_id, transaction_id, downloads, delivery_expires_at, last_seen_at, files_deleted_at,
     undeliverable_at)
   SELECT code, created_at, ip_hash, consent_at, attempts_used, selected_attempt, status,
     paid_at, receipt_id, transaction_id, downloads, delivery_expires_at, last_seen_at, files_deleted_at,
     undeliverable_at FROM codes;
   DROP TABLE codes;
   ALTER TABLE codes_new RENAME TO codes;
   CREATE INDEX codes_ip_created ON codes(ip_hash, created_at);
   CREATE INDEX codes_receipt ON codes(receipt_id);
   ALTER TABLE etsy_orders ADD COLUMN quantity INTEGER;`
];
