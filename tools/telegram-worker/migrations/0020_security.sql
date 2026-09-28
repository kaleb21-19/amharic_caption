-- Security & accountability (bot).
--
-- proofs: every payment screenshot ever received, by Telegram's permanent
--   file_unique_id (the same image has the same id for every user and every
--   re-send). A screenshot reused for a second order is flagged to the owner.
--   Kept after orders are pruned (30 days), so reuse is caught months later.
CREATE TABLE IF NOT EXISTS proofs (
  file_unique_id TEXT PRIMARY KEY,
  order_id       INTEGER NOT NULL,
  uid            TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Why an order looks suspicious (shown on the admin card; Approve then needs
-- a second, deliberate tap).
ALTER TABLE orders ADD COLUMN proof_flag TEXT;

-- admin_audit: who did what, when — approvals, declines, revokes, payouts,
-- broadcasts, partner/bank/terms changes, exports, PIN unlocks and failures.
CREATE TABLE IF NOT EXISTS admin_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  admin_uid TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
