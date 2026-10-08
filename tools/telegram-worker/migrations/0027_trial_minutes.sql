-- 1.10.7: free trial = 20 free minutes, given by the bot to a Telegram account.
--
-- The panel asks /api/trial/request for a one-time link (t_<nonce>); opening it
-- in the bot links that computer to the Telegram account and gives it the free
-- minutes (one per account, one per computer). Each free caption is charged in
-- seconds of audio (/api/trial/use with "seconds") and the engine's ticket says
-- how many seconds it may transcribe.

CREATE TABLE IF NOT EXISTS trial_requests (
  nonce      TEXT PRIMARY KEY,               -- the t_<nonce> link, 16 chars
  machine_id TEXT NOT NULL,
  hf         TEXT,                           -- computer fingerprint (8 hex) or NULL
  flagged    INTEGER NOT NULL DEFAULT 0,     -- many requests from one address today
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trial_grants (
  machine_id    TEXT PRIMARY KEY,
  uid           TEXT NOT NULL,               -- Telegram account
  name          TEXT,                        -- @username or first name, for the admin
  hf            TEXT,
  seconds_total INTEGER NOT NULL,
  seconds_used  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | pending | blocked | refused
  refunds       INTEGER NOT NULL DEFAULT 0,       -- failed jobs given back (max 2)
  nudged        INTEGER NOT NULL DEFAULT 0,       -- "minutes used up" message sent
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_grants_uid ON trial_grants(uid);
CREATE INDEX IF NOT EXISTS idx_trial_grants_hf ON trial_grants(hf);

CREATE TABLE IF NOT EXISTS trial_runs (
  run_id      TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  refunded    INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
