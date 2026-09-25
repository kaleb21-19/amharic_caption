-- Processing lease for webhook idempotency. A worker crash leaves a NULL
-- completed_at row; Telegram retries can reclaim it after the lease expires.
ALTER TABLE webhook_updates ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_updates_claimed
  ON webhook_updates(claimed_at, completed_at);
