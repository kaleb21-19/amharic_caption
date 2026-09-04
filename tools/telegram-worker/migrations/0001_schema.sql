-- Amharic Captions bot state (replaces pending.json / customers.csv / fsm.json)
--
-- Migration 0001 : initial schema.

-- Sold / approved licenses (was customers.csv).
CREATE TABLE IF NOT EXISTS customers (
  machine_id TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '-',   -- @username
  expiry     TEXT NOT NULL DEFAULT '00000000',
  key        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'sold',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders awaiting admin approval (was pending.json).
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,               -- buyer telegram id
  username   TEXT NOT NULL DEFAULT '',
  machine_id TEXT NOT NULL,
  expiry     TEXT NOT NULL DEFAULT '00000000',
  ref        TEXT NOT NULL DEFAULT '',    -- telebirr reference (may be '')
  photo_key  TEXT,                        -- Telegram file_id of the screenshot
  chat_id    TEXT,
  status_msg_id INTEGER,                  -- buyer status message to edit on approve
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid);

-- In-progress buy flows (was fsm.json). One row per user currently mid-flow.
CREATE TABLE IF NOT EXISTS fsm (
  uid     TEXT PRIMARY KEY,
  step    TEXT NOT NULL,                 -- mid | photo | ref | confirm
  mid     TEXT,
  photo_key TEXT,
  ref     TEXT DEFAULT '',
  hint    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Funnel analytics (was funnel.csv).
CREATE TABLE IF NOT EXISTS funnel (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  uid     TEXT NOT NULL,
  event   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_funnel_event ON funnel(event);
