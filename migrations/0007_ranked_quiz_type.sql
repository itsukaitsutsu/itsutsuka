-- Which field the players guess: 'meaning' (choose meaning, original ranked quiz),
-- 'word' (choose Japanese expression+reading), or 'reading' (choose 読み方 reading).
-- Existing matches retain the original 'meaning' quiz.
ALTER TABLE ranked_matches ADD COLUMN quiz_type TEXT NOT NULL DEFAULT 'meaning' CHECK (quiz_type IN ('meaning', 'word', 'reading'));
