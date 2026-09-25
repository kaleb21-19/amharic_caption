-- Make approval and key delivery separately observable. A Telegram/API outage
-- must not leave an order looking approved when the buyer never received the
-- key, and a later admin retry must be able to redeliver it.
ALTER TABLE orders ADD COLUMN key_issued_at TEXT;
ALTER TABLE orders ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE orders ADD COLUMN delivery_lease_until TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status
  ON orders(delivery_status);
