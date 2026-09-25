-- Idempotency ledger for Telegram webhook deliveries.
-- Telegram retries a request when the Worker returns 5xx. Keeping the update ID
-- lets the Worker acknowledge exact retries without replaying a completed
-- purchase/approval callback.
CREATE TABLE IF NOT EXISTS webhook_updates (
  update_id    INTEGER PRIMARY KEY,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_updates_received
  ON webhook_updates(received_at);
