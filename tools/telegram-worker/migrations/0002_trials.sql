-- Migration 0002 : server-side trial tracking + key validation API.
--
-- Trials are tied to machine_id so clearing localStorage no longer
-- resets the free 2-caption allowance.

CREATE TABLE IF NOT EXISTS trials (
  machine_id TEXT PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0,
  max_free   INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
