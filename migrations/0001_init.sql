-- MyKotoba on Cloudflare D1 — initial schema.
-- Direct translation of firestore.rules (see the data-model comment block there).
--
-- Apply locally:   npx wrangler d1 execute mykotoba-db --local  --file=migrations/0001_init.sql
-- Apply remotely:  npx wrangler d1 execute mykotoba-db --remote --file=migrations/0001_init.sql
--
-- SQLite notes for a Firestore brain:
--   * no BOOLEAN  -> INTEGER 0/1
--   * no ARRAY    -> JSON stored as TEXT
--   * no subcollections -> separate table keyed by uid
--   * no automatic timestamps -> pass ISO-8601 strings yourself

-- 1. Local mirror of the Firebase Auth user. uid IS the Firebase uid.
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. userData/{uid}  ->  one row, JSON columns
CREATE TABLE IF NOT EXISTS user_data (
  uid          TEXT PRIMARY KEY,
  lists        TEXT NOT NULL DEFAULT '[]',   -- JSON WordList[]
  active_id    TEXT,
  custom_words TEXT NOT NULL DEFAULT '[]',   -- JSON CustomWord[]
  history      TEXT NOT NULL DEFAULT '[]',   -- JSON HistoryEntry[] (max 300)
  share_scores INTEGER NOT NULL DEFAULT 0,
  nickname     TEXT NOT NULL DEFAULT '',
  friend_code  TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 0,   -- optimistic locking, replaces runTransaction
  updated_at   TEXT NOT NULL
);

-- 3. userData/{uid}/cardDiscovery/{sha256(key)}
CREATE TABLE IF NOT EXISTS card_discovery (
  uid        TEXT NOT NULL,
  card_id    TEXT NOT NULL,      -- sha256 hex, same id Firestore used
  key        TEXT NOT NULL,      -- "word:[...]" or "jlpt:id"
  seen       INTEGER NOT NULL,   -- 0/1
  version    INTEGER NOT NULL,   -- epoch ms
  operation  TEXT NOT NULL,      -- uuid tie-breaker
  updated_at TEXT NOT NULL,
  PRIMARY KEY (uid, card_id)
);
-- Only index what you query: every extra index adds rows WRITTEN on every insert.
CREATE INDEX IF NOT EXISTS idx_discovery_sync ON card_discovery(uid, version);

-- 4. leaderboard/{uid}
CREATE TABLE IF NOT EXISTS leaderboard (
  uid           TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  total_quizzes INTEGER NOT NULL,
  avg_pct       REAL NOT NULL,
  best_pct      REAL NOT NULL,
  bonus_points  INTEGER NOT NULL,
  best_day      INTEGER NOT NULL,
  jlpt_quizzes  INTEGER NOT NULL,
  jlpt_avg_pct  REAL NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lb_bonus   ON leaderboard(bonus_points DESC);
CREATE INDEX IF NOT EXISTS idx_lb_avg     ON leaderboard(avg_pct DESC);
CREATE INDEX IF NOT EXISTS idx_lb_quizzes ON leaderboard(total_quizzes DESC);

-- 5. nicknames/{lowercase} — PRIMARY KEY enforces uniqueness
CREATE TABLE IF NOT EXISTS nicknames (
  name TEXT PRIMARY KEY,
  uid  TEXT NOT NULL
);

-- 6. invites/{code}
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  from_uid   TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 7. friendRequests/{uidA_uidB} — Firestore "array-contains" becomes two columns
CREATE TABLE IF NOT EXISTS friend_requests (
  id         TEXT PRIMARY KEY,   -- "uidA_uidB" (sorted)
  from_uid   TEXT NOT NULL,
  to_uid     TEXT NOT NULL,
  from_name  TEXT NOT NULL,
  to_name    TEXT NOT NULL,
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_uid);
CREATE INDEX IF NOT EXISTS idx_fr_to   ON friend_requests(to_uid);

-- 8. pairs/{uidA_uidB}
CREATE TABLE IF NOT EXISTS pairs (
  id         TEXT PRIMARY KEY,
  uid_a      TEXT NOT NULL,
  uid_b      TEXT NOT NULL,
  names      TEXT NOT NULL,      -- JSON { uid: nickname }
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_a ON pairs(uid_a);
CREATE INDEX IF NOT EXISTS idx_pairs_b ON pairs(uid_b);
