-- Anti-piracy / anti-trial-abuse telemetry (enforcement is in the Worker).
--
-- key_activations: one row per (license key, source IP). A key can only ever
-- validate against the machine_id embedded in it (the panel + server both
-- enforce that), so the machine_id is NOT a share signal. The honest signal is
-- how many DIFFERENT source IPs present the same key: many distinct IPs = a
-- leaked/shared key (unless owner is on still-CGNAT/rotating IPs).
CREATE TABLE IF NOT EXISTS key_activations (
  key        TEXT NOT NULL,
  ip         TEXT NOT NULL,
  mid        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, ip)
);
CREATE INDEX IF NOT EXISTS idx_key_activations_key ON key_activations(key);