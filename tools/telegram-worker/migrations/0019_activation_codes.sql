-- Simple buying (1.7.7): customers never handle a Machine ID.
--
-- • A customer who pays from the phone (no panel yet) gets a short ACTIVATION
--   CODE (e.g. K7QD-3MXP). The panel redeems it once, which binds the license to
--   that computer (activation_codes.redeemed_mid) — one code, one computer.
-- • A customer who presses "Buy" in the panel arrives with the Machine ID and a
--   random secret (nonce) the panel keeps. After approval the panel asks for its
--   key with that secret and activates itself — nothing to copy or paste.
CREATE TABLE IF NOT EXISTS activation_codes (
  code         TEXT PRIMARY KEY,
  order_id     INTEGER NOT NULL UNIQUE,
  uid          TEXT NOT NULL DEFAULT '',
  expiry       TEXT NOT NULL DEFAULT '00000000',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_mid TEXT,
  redeemed_at  TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activation_codes_uid ON activation_codes(uid);

ALTER TABLE fsm ADD COLUMN nonce TEXT;
ALTER TABLE orders ADD COLUMN nonce TEXT;
