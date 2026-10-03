import type { SharedDeck, SharedDeckSubgroup } from './api';
import type { Word } from './vocabulary';

export function parseSharedSubgroupIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  return [...new Set(raw.split(',').map(id => id.trim()).filter(Boolean))];
}

export function findSharedSubgroups(deck: SharedDeck | null | undefined, subgroupIds: readonly string[] | null): SharedDeckSubgroup[] {
  if (!deck || !subgroupIds?.length) return [];
  const wanted = new Set(subgroupIds);
  const matches = (deck.subgroups ?? []).filter(subgroup => wanted.has(subgroup.id));
  return matches.length === wanted.size ? matches : [];
}

/** CSV batches are stored with their original filenames; hide the extension in player-facing labels. */
export function sharedSubgroupLabel(name: string): string {
  return name.replace(/\.csv$/i, '').trim() || name;
}

/** `null` selects the whole publication; an array selects the union of those batches. */
export function sharedDeckCards(deck: SharedDeck | null | undefined, subgroupIds: readonly string[] | null): Word[] {
  if (!deck) return [];
  if (subgroupIds === null) return deck.cards;
  if (!subgroupIds.length) return [];
  const subgroups = findSharedSubgroups(deck, subgroupIds);
  if (!subgroups.length) return [];
  const cardIds = new Set(subgroups.flatMap(subgroup => subgroup.cardIds));
  return deck.cards.filter(card => cardIds.has(card.id));
}
