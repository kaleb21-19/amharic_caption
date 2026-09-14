-- Add a numeric price snapshot to each order so revenue math (and any future
-- pricing change) never has to re-parse the display string AMH_PRICE.
ALTER TABLE orders ADD COLUMN amount_etb INTEGER NOT NULL DEFAULT 0;