-- Track who is in the support group, so membership can be checked instead of
-- only asked for.
--
-- Until now the bot's only offer to join was a static invite-link button. There
-- was no way to know whether a customer joined, so nothing could be measured
-- and nothing could be followed up on.
--
-- The table records the relationship, not just membership, because the useful
-- number is the conversion between the two states:
--
--   prompted_at — when we last asked them to join (set at order delivery)
--   joined_at   — first time we observed them as a member
--   left_at     — if we ever see them leave
--
-- joined_at is written once and never rewritten on re-join, so it answers "did
-- they ever join". "Are they in right now" is answered by the live API instead,
-- not by this table — a stored copy of a membership state is stale the moment
-- they walk out, and using it would mean nagging people who are still inside.
CREATE TABLE IF NOT EXISTS group_members (
  uid         TEXT PRIMARY KEY,
  prompted_at TEXT,
  joined_at   TEXT,
  left_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_group_members_joined ON group_members(joined_at);
CREATE INDEX IF NOT EXISTS idx_group_members_prompted ON group_members(prompted_at);