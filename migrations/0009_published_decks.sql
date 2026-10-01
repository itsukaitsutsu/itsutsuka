-- Publish a user's existing saved list as a live, read-only deck.
-- The source words and list remain in user_data; no copies are stored here.
CREATE TABLE IF NOT EXISTS published_decks (
  id TEXT PRIMARY KEY,
  source_uid TEXT NOT NULL,
  source_list_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'selected')),
  recipient_uids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recipient_uids)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_uid, source_list_id)
);
CREATE INDEX IF NOT EXISTS idx_published_decks_source ON published_decks(source_uid);
