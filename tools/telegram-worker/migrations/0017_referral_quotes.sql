-- Honour the price a buyer SAW. When the pay screen shows a referral/partner
-- price, it is stored here; for 48 hours the review screen and the order use
-- that price even if the owner pauses the link or changes the terms meanwhile
-- (the buyer may already have transferred the money).
ALTER TABLE referrals ADD COLUMN quoted_discount INTEGER;
ALTER TABLE referrals ADD COLUMN quoted_reward INTEGER;
ALTER TABLE referrals ADD COLUMN quoted_at TEXT;
