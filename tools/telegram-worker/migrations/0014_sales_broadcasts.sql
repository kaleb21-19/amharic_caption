-- Permanent sales ledger. Orders (with screenshots, usernames and chat ids) are
-- pruned after 30 days for privacy, which also erased the seller's only record
-- of past sales. This keeps the minimum needed for accounting and "I paid in
-- March" support: order number, Machine ID, amount, date, and whether the sale
-- was later revoked. No screenshots, names or Telegram ids.
CREATE TABLE IF NOT EXISTS sales (
  order_id   INTEGER PRIMARY KEY,
  machine_id TEXT NOT NULL,
  amount_etb INTEGER NOT NULL,
  sold_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status     TEXT NOT NULL DEFAULT 'sold'      -- sold | revoked
);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_mid ON sales(machine_id);

-- Backfill from the orders still on file (the last 30 days).
INSERT OR IGNORE INTO sales (order_id, machine_id, amount_etb, sold_at, status)
  SELECT id, machine_id,
         CASE WHEN amount_etb > 0 THEN amount_etb ELSE 2500 END,
         COALESCE(key_issued_at, created_at),
         CASE WHEN status = 'revoked' THEN 'revoked' ELSE 'sold' END
  FROM orders WHERE status IN ('approved', 'revoked');

-- Broadcasts: a draft the admin previews and confirms, then a queue that is
-- sent in small batches (the confirm tap, then the every-minute cron), so a
-- broadcast of any size fits the per-invocation request limits.
CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_chat  TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft | sending | done | cancelled
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);

CREATE TABLE IF NOT EXISTS broadcast_queue (
  broadcast_id INTEGER NOT NULL,
  uid          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed
  claimed_at   TEXT,
  PRIMARY KEY (broadcast_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_bq_status ON broadcast_queue(broadcast_id, status);
