-- Per-browser/device sessions for account security.
-- Session ids are random client-generated UUIDs and are always bound to the verified Firebase uid.
CREATE TABLE IF NOT EXISTS device_sessions (
  session_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_uid ON device_sessions(uid, last_seen_at DESC);
