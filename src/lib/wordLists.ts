// src/lib/wordLists.ts
// Multiple, renamable "save slots" for words — replaces the old single
// `kotoba-favorites` array with a set of named word lists, one of which is
// "active" at any time (the one the Cabinet's heart button saves into).

export type WordList = {
  id: string;
  name: string;
  wordIds: string[];
  createdAt: string;
};

const LISTS_KEY = 'kotoba-word-lists';
const ACTIVE_KEY = 'kotoba-active-list';
const LEGACY_FAVORITES_KEY = 'kotoba-favorites';
const DEFAULT_LIST_NAME = 'My Saved Words';
const MAX_NAME = 120;
const MAX_WORD_IDS = 5000;
const FALLBACK_NAME = 'My Saved Words';

/**
 * Turn ANY value that claims to be a word list into a guaranteed-safe one.
 * Never throws. Bad items are repaired, not dropped, so users don't lose data.
 */
export function sanitizeLists(raw: unknown): WordList[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null)
    .filter((item) => typeof item.id === 'string' && item.id !== '')
    .map((item) => ({
      id: String(item.id),
      name: typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.slice(0, MAX_NAME)
        : FALLBACK_NAME,
      wordIds: Array.isArray(item.wordIds)
        ? item.wordIds.filter((w): w is string => typeof w === 'string').slice(0, MAX_WORD_IDS)
        : [],
      createdAt: typeof item.createdAt === 'string'
        ? item.createdAt
        : new Date().toISOString(),
    }));
}

function uid() {
  return `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeList(name: string, wordIds: string[] = []): WordList {
  return { id: uid(), name, wordIds, createdAt: new Date().toISOString() };
}

function readStoredLists(): WordList[] {
  try {
    return sanitizeLists(JSON.parse(localStorage.getItem(LISTS_KEY) || 'null'));
  } catch {
    return [];
  }
}

// One-time upgrade path: if someone has the old single favorites array and
// hasn't been migrated yet, turn it into their first save slot.
function migrateLegacyFavorites(): WordList | null {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_FAVORITES_KEY) || 'null');
    localStorage.removeItem(LEGACY_FAVORITES_KEY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      return makeList(DEFAULT_LIST_NAME, legacy);
    }
  } catch {
    /* ignore malformed storage */
  }
  return null;
}

export function persistWordLists(lists: WordList[]) {
  localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
}

export function loadWordLists(): WordList[] {
  const existing = readStoredLists();
  if (existing.length > 0) return existing;

  const migrated = migrateLegacyFavorites();
  const seeded = migrated ? [migrated] : [makeList(DEFAULT_LIST_NAME)];
  persistWordLists(seeded);
  return seeded;
}

export function persistActiveListId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function loadActiveListId(lists: WordList[]): string {
  const stored = localStorage.getItem(ACTIVE_KEY);
  if (stored && lists.some((list) => list.id === stored)) return stored;
  return lists[0]?.id ?? '';
}

export function createWordList(lists: WordList[], name: string): { lists: WordList[]; id: string } {
  const list = makeList(name.trim() || 'Untitled list');
  return { lists: [...lists, list], id: list.id };
}

export function renameWordList(lists: WordList[], id: string, name: string): WordList[] {
  const trimmed = name.trim();
  if (!trimmed) return lists;
  return lists.map((list) => (list.id === id ? { ...list, name: trimmed } : list));
}

// Always leaves at least one slot behind — deleting the last slot instead
// clears it out, so there's always somewhere for the heart button to save to.
export function deleteWordList(lists: WordList[], id: string): WordList[] {
  const next = lists.filter((list) => list.id !== id);
  return next.length > 0 ? next : [makeList(DEFAULT_LIST_NAME)];
}

export function toggleWordInList(lists: WordList[], listId: string, wordId: string): WordList[] {
  return lists.map((list) => {
    if (list.id !== listId) return list;
    const inList = list.wordIds.includes(wordId);
    return { ...list, wordIds: inList ? list.wordIds.filter((item) => item !== wordId) : [...list.wordIds, wordId] };
  });
}