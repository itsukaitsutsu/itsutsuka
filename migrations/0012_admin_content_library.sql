-- Admin-owned content is separate from every personal user_data row.
CREATE TABLE IF NOT EXISTS admin_content_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_content_groups_name ON admin_content_groups(lower(name));

CREATE TABLE IF NOT EXISTS admin_content_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('csv', 'personal')),
  group_id TEXT REFERENCES admin_content_groups(id) ON DELETE SET NULL,
  source_uid TEXT,
  source_kind TEXT,
  source_id TEXT,
  source_all INTEGER NOT NULL DEFAULT 0 CHECK (source_all IN (0, 1)),
  selected_source_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selected_source_ids)),
  source_version INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_content_batches_group ON admin_content_batches(group_id);
CREATE INDEX IF NOT EXISTS idx_admin_content_batches_source ON admin_content_batches(source_uid);

CREATE TABLE IF NOT EXISTS admin_content_cards (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  expression TEXT NOT NULL,
  reading TEXT NOT NULL,
  meaning TEXT DEFAULT '',
  level TEXT CHECK (level IS NULL OR level IN ('N1', 'N2', 'N3', 'N4', 'N5', 'Custom')),
  part_of_speech_en TEXT,
  part_of_speech_jp TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_content_batch_cards (
  batch_id TEXT NOT NULL REFERENCES admin_content_batches(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES admin_content_cards(id) ON DELETE CASCADE,
  source_card_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, card_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_content_batch_cards_card ON admin_content_batch_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_admin_content_batch_cards_source ON admin_content_batch_cards(batch_id, source_card_id);

CREATE TABLE IF NOT EXISTS admin_content_events (
  id TEXT PRIMARY KEY,
  actor_uid TEXT NOT NULL,
  action TEXT NOT NULL,
  batch_id TEXT,
  batch_name TEXT,
  group_id TEXT,
  group_name TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_content_events_created ON admin_content_events(created_at DESC);

-- Store card identities in the audit log itself so the history remains readable
-- after a batch or its cards have been removed from the live admin catalog.
CREATE TABLE IF NOT EXISTS admin_content_event_cards (
  event_id TEXT NOT NULL REFERENCES admin_content_events(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('added', 'updated', 'removed', 'deleted')),
  card_id TEXT,
  expression TEXT NOT NULL,
  reading TEXT NOT NULL,
  PRIMARY KEY (event_id, position)
);
