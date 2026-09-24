-- Apply after 0001 and 0002. Balances are account-scoped; one live match per account.
CREATE TABLE ranked_accounts (
  uid TEXT PRIMARY KEY,
  points INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'N5' CHECK(tier IN ('N5','N4','N3','N2','N1')),
  mastered TEXT NOT NULL DEFAULT '{"N5":[],"N4":[],"N3":[],"N2":[],"N1":[]}',
  version INTEGER NOT NULL DEFAULT 0,
  active_match TEXT
);
ALTER TABLE ranked_matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'party' CHECK(mode IN ('party','solo'));
ALTER TABLE ranked_matches ADD COLUMN question_count INTEGER NOT NULL DEFAULT 10;
ALTER TABLE ranked_matches ADD COLUMN result_json TEXT;
ALTER TABLE ranked_matches ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
-- D1 remote parsing differs from local SQLite: avoid CASE/END inside triggers.
-- Keep each trigger on ONE physical line with uppercase BEGIN/END and LF endings.
-- If any account lock failed, abort the entire start batch, including other locks.
CREATE TRIGGER ranked_start_guard BEFORE UPDATE OF status ON ranked_matches WHEN NEW.status = 'live' AND OLD.status = 'lobby' BEGIN SELECT RAISE(ABORT, 'Ranked account changed, is busy, or has insufficient points. Refresh and try again.') WHERE (NEW.mode = 'solo' AND (SELECT COUNT(*) FROM ranked_match_players WHERE match_id = NEW.id) != 1) OR (NEW.mode = 'party' AND (SELECT COUNT(*) FROM ranked_match_players WHERE match_id = NEW.id) != 2) OR EXISTS (SELECT 1 FROM ranked_match_players p LEFT JOIN ranked_accounts a ON a.uid = p.uid WHERE p.match_id = NEW.id AND (a.uid IS NULL OR a.active_match IS NOT NEW.id OR (NEW.mode = 'party' AND a.points < NEW.wager_points))); END;
-- Defensive bound for concurrent invitees. Preserve this guard when editing SQL.
CREATE TRIGGER ranked_capacity BEFORE INSERT ON ranked_match_players WHEN NOT EXISTS (SELECT 1 FROM ranked_match_players WHERE match_id = NEW.match_id AND uid = NEW.uid) AND (SELECT COUNT(*) FROM ranked_match_players WHERE match_id = NEW.match_id) >= 2 BEGIN SELECT RAISE(ABORT, 'This match is full.'); END;
-- Explicit final statement after the trigger for the remote multi-statement parser.
SELECT 1;
