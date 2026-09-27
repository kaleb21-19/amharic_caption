-- Partner links: referral links the OWNER creates for a group, channel or
-- influencer (e.g. a 100k-member editors' group), each with its own terms and
-- its own on/off switch, independent of the buyer-referral switch.
--
-- The owner creates a partner (/partner CODE Name) and gets:
--   * a private claim link  t.me/<bot>?start=p_<claim_token>  sent once to the
--     partner; opening it connects the partner's Telegram account (uid), which
--     is where their stats are shown and their rewards are paid;
--   * the public link       t.me/<bot>?start=r_<CODE>  for the group post.
-- The public link only works once the partner is connected and active.
CREATE TABLE IF NOT EXISTS partners (
  code         TEXT PRIMARY KEY,                -- public link code, e.g. EDITGROUP
  label        TEXT NOT NULL,                   -- the owner's name for them
  uid          TEXT UNIQUE,                     -- partner's Telegram id (after claim)
  claim_token  TEXT UNIQUE,
  reward_etb   INTEGER NOT NULL DEFAULT 300,    -- per sale
  discount_etb INTEGER NOT NULL DEFAULT 200,    -- for the buyer
  tier_after   INTEGER NOT NULL DEFAULT 0,      -- after N sales ...
  tier_reward  INTEGER NOT NULL DEFAULT 0,      -- ... the reward becomes this (0 = no tier)
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);
