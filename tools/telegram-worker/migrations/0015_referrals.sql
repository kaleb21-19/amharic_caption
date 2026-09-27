-- Referral programme ("invite a friend"), controlled by the owner from the
-- admin panel. OFF until the owner turns it on (settings.referral_enabled).
--
-- Flow: a buyer shares t.me/<bot>?start=r_<CODE>. A friend who opens it is
-- remembered (first link wins); while the programme is ON the friend pays
-- price - discount, and when the owner approves that order the referrer earns
-- a reward, payable in a monthly batch once the refund window has passed.

-- Owner-controlled switches and amounts (key/value; missing key = default).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One personal invite code per buyer (Telegram account).
CREATE TABLE IF NOT EXISTS referral_codes (
  uid        TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who invited whom. One row per invited Telegram account: the first link a
-- person opens decides the referrer, so a later link cannot "steal" them.
CREATE TABLE IF NOT EXISTS referrals (
  friend_uid   TEXT PRIMARY KEY,
  referrer_uid TEXT NOT NULL,
  code         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_uid);

-- One reward per approved referred order. Kept permanently (orders are pruned
-- after 30 days), like the sales ledger.
--   earned    — owed; payable once earned_at is older than the hold period
--   paid      — the owner marked it paid
--   cancelled — the friend's license was revoked/refunded before payment
CREATE TABLE IF NOT EXISTS referral_rewards (
  order_id     INTEGER PRIMARY KEY,
  referrer_uid TEXT NOT NULL,
  friend_uid   TEXT NOT NULL,
  friend_mid   TEXT NOT NULL,
  amount_etb   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'earned',
  earned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rewards_status ON referral_rewards(status, earned_at);
CREATE INDEX IF NOT EXISTS idx_rewards_referrer ON referral_rewards(referrer_uid, status);
CREATE INDEX IF NOT EXISTS idx_rewards_friend_mid ON referral_rewards(friend_mid);

-- Where a referrer wants rewards sent (bank, account number, name), typed
-- once by the referrer in the bot.
CREATE TABLE IF NOT EXISTS payout_accounts (
  uid        TEXT PRIMARY KEY,
  details    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The terms are locked onto the order when it is placed, so changing the
-- amounts (or switching the programme off) never changes an order in flight.
ALTER TABLE orders ADD COLUMN referrer_uid TEXT;
ALTER TABLE orders ADD COLUMN discount_etb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN reward_etb INTEGER NOT NULL DEFAULT 0;
