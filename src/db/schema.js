// SQLite schema (spec section 4.1). Times are ISO 8601 UTC strings.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  code                TEXT PRIMARY KEY,               -- IS-XXXX-XXXX
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
  n             INTEGER NOT NULL CHECK (n >= 1),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'failed', 'declined')),
  stage         TEXT,
  settings_json TEXT,                                 -- size, unit, mode, bg removal, adjustments, crop, rotate
  result_json   TEXT,                                 -- stone count, sizes, colours, tier, final w/h, coverage
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
