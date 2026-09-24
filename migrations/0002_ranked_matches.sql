-- Ranked Party battles. Apply after 0001_init.sql.
CREATE TABLE IF NOT EXISTS ranked_matches (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL UNIQUE,
  host_uid TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('N5','N4','N3','N2','N1')),
  wager_type TEXT NOT NULL CHECK (wager_type IN ('points','cards_points')),
  wager_points INTEGER NOT NULL DEFAULT 0 CHECK (wager_points >= 0),
  wager_cards INTEGER NOT NULL DEFAULT 0 CHECK (wager_cards >= 0),
  status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','live','complete','cancelled')),
  winner_uid TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ranked_matches_host ON ranked_matches(host_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranked_matches_status ON ranked_matches(status, created_at DESC);

CREATE TABLE IF NOT EXISTS ranked_match_players (
  match_id TEXT NOT NULL REFERENCES ranked_matches(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  mistakes INTEGER NOT NULL DEFAULT 0,
  points_before INTEGER NOT NULL DEFAULT 0,
  points_after INTEGER NOT NULL DEFAULT 0,
  cards_before INTEGER NOT NULL DEFAULT 0,
  cards_after INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  PRIMARY KEY (match_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_ranked_match_players_uid ON ranked_match_players(uid, match_id);

CREATE TABLE IF NOT EXISTS ranked_match_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES ranked_matches(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  question_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('correct','incorrect','timeout')),
  point_delta INTEGER NOT NULL,
  card_delta INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranked_match_events_match ON ranked_match_events(match_id, id);
