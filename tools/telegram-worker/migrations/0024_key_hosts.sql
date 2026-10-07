-- Which COMPUTERS use a license key (anti-sharing that works in Ethiopia).
--
-- Until now sharing was judged by distinct source IPs per key
-- (key_activations). Ethio Telecom hands the same computer a new address all
-- the time (mobile data, router restarts), so an honest buyer reached the
-- 3-IP threshold within days: with AMH_BLOCK_SHARED=1 the owner's own key and
-- two customers were refused as "shared" on 2026-10-07.
--
-- The panel, the desktop app and the SRT maker now send a short fingerprint
-- of the computer + user account (sha256 of username|home folder|platform,
-- 8 hex — the same value the panel already keeps in the machine record). A
-- license copied to another PC carries the same Machine ID but a different
-- fingerprint, whatever the network. key_activations keeps the IPs for
-- support only.
--
-- Rows are kept 30 days after last use (pruneOld), like key_activations.
CREATE TABLE IF NOT EXISTS key_hosts (
  key        TEXT NOT NULL,
  hf         TEXT NOT NULL,
  mid        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, hf)
);
