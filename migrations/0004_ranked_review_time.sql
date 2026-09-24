-- Per-room party review delay. Existing matches retain the original 3-second default.
-- Zero skips the review pause; the 10-second answer timer is unchanged.
ALTER TABLE ranked_matches ADD COLUMN review_ms INTEGER NOT NULL DEFAULT 3000 CHECK (typeof(review_ms) = 'integer' AND review_ms BETWEEN 0 AND 10000 AND review_ms % 500 = 0);
