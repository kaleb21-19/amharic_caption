-- Idempotent trial reservations. A retry of the same transcription run must
-- not spend a second credit, while a deliberate new run gets a new ID.
CREATE TABLE IF NOT EXISTS trial_uses (
  run_id      TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL,
  used_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trial_uses_machine ON trial_uses(machine_id, used_at);
