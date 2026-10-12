-- Free minutes are valid for a limited time (default 7 days, setting
-- trial_days). expires_at is UTC 'YYYY-MM-DD HH:MM:SS'; NULL until a
-- waiting request is approved. expiry_nudged: 1 = 'ends soon' sent,
-- 2 = 'ended' sent. Grants that exist today get the full week from now.
ALTER TABLE trial_grants ADD COLUMN expires_at TEXT;
ALTER TABLE trial_grants ADD COLUMN expiry_nudged INTEGER NOT NULL DEFAULT 0;
UPDATE trial_grants SET expires_at = datetime('now', '+7 days') WHERE expires_at IS NULL AND status = 'active';
