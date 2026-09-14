-- Make trial consumption robust under Cloudflare KV's eventual consistency.
-- A KV marker can't be trusted for read-modify-write logic (two requests can
-- both read null before either write propagates), so the 2 s double-fire
-- collapse moves into SQL: UPDATE ... WHERE used < max_free AND last_at < now-2s.
ALTER TABLE trials ADD COLUMN last_at TEXT NOT NULL DEFAULT '';

-- Per-IP daily fresh-machine counters, also atomic in SQL (no KV races).
CREATE TABLE IF NOT EXISTS ip_counters (
  ip TEXT NOT NULL,
  bucket TEXT NOT NULL,          -- 'fresh:<YYYY-MM-DD>'
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ip, bucket)
);