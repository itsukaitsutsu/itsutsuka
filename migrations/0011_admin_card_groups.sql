-- Admin-only named groups keep bulk-imported cards separate from personal save slots.
ALTER TABLE user_data ADD COLUMN card_groups TEXT NOT NULL DEFAULT '[]';
