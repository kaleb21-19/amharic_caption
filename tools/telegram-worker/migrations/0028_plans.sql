-- 1.10.12: plans — 1 month · 2 months · Forever.
-- orders.plan / sales.plan: which plan was bought (m1, m2, forever).
-- customers.renew_nudged: which renewal reminder was sent (pre:/post:<expiry>).
ALTER TABLE orders ADD COLUMN plan TEXT NOT NULL DEFAULT 'forever';
ALTER TABLE sales ADD COLUMN plan TEXT NOT NULL DEFAULT 'forever';
ALTER TABLE customers ADD COLUMN renew_nudged TEXT;
