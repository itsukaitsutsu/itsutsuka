-- Keep a published copy independent from its owner's personal saved-list slot.
ALTER TABLE published_decks ADD COLUMN snapshot_json TEXT;
