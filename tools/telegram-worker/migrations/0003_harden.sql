-- Migration 0003 : harden for scale + payments (deep-audit fixes).
--
-- 1) Stamp buyer `uid` onto customers so the "My Key" retrieval works even
--    after the 30-day orders prune deletes the linking order row.
-- 2) Block duplicate pending orders for the same machine (double-tap /
--    concurrent confirm) without blocking later legit re-installs.
-- 3) Speedy lookups: orders by machine_id, customers by uid.

ALTER TABLE customers ADD COLUMN uid TEXT NOT NULL DEFAULT '';

-- Best-effort backfill for existing customers from their last approved order.
UPDATE customers SET uid = IFNULL((
  SELECT o.uid FROM orders o
  WHERE o.machine_id = customers.machine_id AND o.status = 'approved'
  ORDER BY o.id DESC LIMIT 1), '')
WHERE uid = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_mid
  ON orders(machine_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_orders_mid ON orders(machine_id);
CREATE INDEX IF NOT EXISTS idx_customers_uid ON customers(uid);