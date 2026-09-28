-- Partner profile for the owner's partner card: who the partner is on
-- Telegram, when they connected, and a private note only the owner sees.
ALTER TABLE partners ADD COLUMN tg_username TEXT;
ALTER TABLE partners ADD COLUMN connected_at TEXT;
ALTER TABLE partners ADD COLUMN note TEXT;
