-- A trial reservation is a short-lived lease. Completed reservations are
-- idempotent; abandoned NULL/completed rows can be reclaimed after a crash.
ALTER TABLE trial_uses ADD COLUMN claimed_at TEXT;
ALTER TABLE trial_uses ADD COLUMN completed_at TEXT;
ALTER TABLE trial_uses ADD COLUMN result_json TEXT;
CREATE INDEX IF NOT EXISTS idx_trial_uses_claimed
  ON trial_uses(claimed_at, completed_at);
