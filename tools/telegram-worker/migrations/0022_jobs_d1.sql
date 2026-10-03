-- Move the jobs-feed state out of KV and into D1.
--
-- Why: these two keys are correctness-critical, not cache. The feed's dedupe
-- depends on both of them, and while KV is unavailable (over its daily put
-- quota it answers 429) both writes failed silently while the Telegram send
-- on the same path had already succeeded. Result: every cron tick re-read the
-- same posts as new and re-sent them to the support group, once a minute,
-- indefinitely. A cache that can be missing right after the side effect it
-- protects is the wrong store for that job.
--
-- D1 is strongly consistent and transactional, so the marker can no longer be
-- lost after a successful send, and a KV outage can no longer turn the feed
-- into a spam loop.
--
-- jobs_state: per-channel high-water mark — the newest t.me post id already
--   examined (was the KV key jobs:last:<channel>, no TTL, rewritten per tick).
-- jobs_seen:  cross-channel dedupe — the SHA-256 prefix of title|company from
--   jobKey(), so the same job posted to two channels is delivered once. The KV
--   form had a 30-day TTL; here that is done by pruneOld() instead.
CREATE TABLE IF NOT EXISTS jobs_state (
  channel    TEXT PRIMARY KEY,         -- lowercased t.me channel name
  last_id    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs_seen (
  k       TEXT PRIMARY KEY,            -- 24-char hex prefix from jobKey()
  source  TEXT NOT NULL DEFAULT '',    -- 'channel/postId', for triage
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_seen_at ON jobs_seen(seen_at);