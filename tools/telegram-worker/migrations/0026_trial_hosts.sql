-- Free captions per COMPUTER, not only per Machine ID (1.10.4).
--
-- The Machine ID lives in a small file; deleting it gives the computer a new
-- ID and, until now, 2 new free captions — up to AMH_FRESH_MID_DAY (30) times
-- a day per internet address (that limit has to be high: many Ethiopians share
-- one address). Panels / the SRT maker from 1.10.4 also send the computer
-- fingerprint `hf` (sha256 of username|home folder|platform, 8 hex — the
-- value already used for license sharing, 0024). A computer that has used its
-- free captions gets none under a new Machine ID.
CREATE TABLE IF NOT EXISTS trial_hosts (
  hf         TEXT PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
