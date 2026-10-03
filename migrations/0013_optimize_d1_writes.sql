-- Drop redundant indexes on admin content and ranked tables to minimize D1 rows_written.
DROP INDEX IF EXISTS idx_admin_content_batches_source;
DROP INDEX IF EXISTS idx_admin_content_batch_cards_card;
DROP INDEX IF EXISTS idx_admin_content_batch_cards_source;
DROP INDEX IF EXISTS idx_ranked_matches_host;
