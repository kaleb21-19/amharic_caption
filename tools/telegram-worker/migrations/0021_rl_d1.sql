-- Move the /api request rate limiter out of KV and into D1.
--
-- Two problems with the KV version (tooMany() in src/worker.js):
--
-- 1. It wrote on every request that PASSED the check, not only the ones it
--    blocked, so ordinary desktop-panel traffic burned puts far faster than
--    abuse ever did. Combined with the per-minute jobs:rr cursor it put the
--    Worker over the 1,000 puts/day free-tier limit every single day.
--
-- 2. Once KV started returning 429 the limiter failed CLOSED on write failure
--    (it returned "blocked" when the marker could not be stored), so
--    /api/validate and /api/redeem rejected *every* caller, not just abusers.
--
-- It was also the wrong store for the job. KV is eventually consistent (~60 s),
-- so parallel requests all read the same stale count and all passed — the
-- limit was not really being enforced. Migration 0007 moved the analogous trial
-- counter into SQL for exactly this reason; this does the same for the
-- request limiter.
--
-- Fixed window. `window_end` is the unix-second deadline of the current window.
-- An expired window resets n to 1 and rolls the deadline forward in the same
-- upsert, so the increment stays atomic under concurrency.
CREATE TABLE IF NOT EXISTS rl_counters (
  k          TEXT PRIMARY KEY,          -- e.g. 'rl:lic:1.2.3.4'
  n          INTEGER NOT NULL DEFAULT 0,
  window_end INTEGER NOT NULL DEFAULT 0 -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_rl_window_end ON rl_counters(window_end);