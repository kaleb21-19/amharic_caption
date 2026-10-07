-- What happens INSIDE the program before anyone buys (anonymous daily counts).
--
-- 2026-10-07: of 56 computers in Ethiopia that opened the panel in 30 days,
-- 29 never made a single caption — and nothing told us why (model download?
-- an error? not knowing what to press?). The panel / desktop app now report a
-- few fixed steps (opened, model download started/finished/failed, Make
-- captions pressed, blocked, error TYPE, captions made / placed, Buy,
-- activated), each at most once per computer per day.
--
-- Stored as counters only: no Machine ID, no IP, no text. `cc` is the
-- country Cloudflare reports, so test machines abroad (GitHub's Macs) can be
-- told apart from customers. Kept 120 days (pruneOld).
CREATE TABLE IF NOT EXISTS events_daily (
  day  TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
  e    TEXT NOT NULL,            -- step, from a fixed list (worker EVENT_NAMES)
  host TEXT NOT NULL,            -- PPRO | AEFT | APP
  os   TEXT NOT NULL,            -- win | mac
  v    TEXT NOT NULL,            -- app version
  cc   TEXT NOT NULL,            -- 2-letter country, '??' if unknown
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, e, host, os, v, cc)
);
