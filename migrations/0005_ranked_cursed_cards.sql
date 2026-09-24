-- Persistent personal repair queue. Existing points, mastery and matches are unchanged.
-- Apply once using Wrangler's migration runner, after 0004.
ALTER TABLE ranked_accounts ADD COLUMN cursed TEXT NOT NULL DEFAULT '{"N5":[],"N4":[],"N3":[],"N2":[],"N1":[]}';
