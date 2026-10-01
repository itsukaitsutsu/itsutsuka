import { WORD_LEVELS, type WordLevel } from '../shared/vocabulary';

type CustomWord = { id: string; expression: string; reading: string; meaning: string; level: WordLevel; createdAt: string };
type WordList = { id: string; name: string; wordIds: string[]; createdAt: string };

export const ADMIN_MAX_ROWS = 5000;
export const ADMIN_MAX_BYTES = 800000;
export type AdminEntry = { id?: string; expression: string; reading: string; meaning?: string; level?: WordLevel };
export type AdminWordChange = { version: number; entries?: AdminEntry[]; deleteIds?: string[]; listId?: string };

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const trimmed = value.normalize('NFKC').trim();
  if ((required && !trimmed) || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`Invalid ${label} (max ${max} characters, no line breaks).`);
  return trimmed;
}
function key(word: { expression: string; reading: string }) { return `${word.expression.normalize('NFKC').trim()}\u0000${word.reading.normalize('NFKC').trim()}`; }

/** Pure, all-or-nothing preparation; only personal words and their list references change. */
export function prepareAdminWordChange(rawWords: unknown, rawLists: unknown, request: AdminWordChange) {
  if (!request || !Number.isSafeInteger(request.version) || request.version < 0) throw new Error('A current account version is required. Reload and try again.');
  const entries = request.entries ?? [], deleteIds = request.deleteIds ?? [];
  if (!Array.isArray(entries) || !Array.isArray(deleteIds) || entries.length + deleteIds.length === 0 || entries.length > ADMIN_MAX_ROWS || deleteIds.length > ADMIN_MAX_ROWS) throw new Error('Choose 1–5,000 cards to change.');
  // Never silently drop malformed existing records during an admin edit.
  if (!Array.isArray(rawWords) || !rawWords.every(word => word && typeof word.id === 'string' && typeof word.expression === 'string' && typeof word.reading === 'string' && typeof word.meaning === 'string' && typeof word.level === 'string') ||
      !Array.isArray(rawLists) || !rawLists.every(list => list && typeof list.id === 'string' && Array.isArray(list.wordIds) && list.wordIds.every((id: unknown) => typeof id === 'string'))) throw new Error('Account data contains invalid cards or save slots. Nothing was changed.');
  const words = rawWords as CustomWord[];
  const lists = rawLists as WordList[];
  const byId = new Map(words.map(word => [word.id, word]));
  const removed = new Set<string>();
  for (const rawId of deleteIds) {
    const id = text(rawId, 'card ID', 200, true);
    if (removed.has(id) || !byId.has(id)) throw new Error(`Unknown or duplicate card ID: ${id}`);
    removed.add(id);
  }
  let targetList: WordList | undefined;
  if (request.listId !== undefined) {
    const listId = text(request.listId, 'save slot ID', 200, true);
    targetList = lists.find(list => list.id === listId);
    if (!targetList) throw new Error('The selected save slot no longer exists. Reload and try again.');
  }
  const next = words.filter(word => !removed.has(word.id));
  const index = new Map(next.map((word, i) => [word.id, i]));
  const matches = new Map<string, CustomWord[]>();
  for (const word of next) matches.set(key(word), [...(matches.get(key(word)) ?? []), word]);
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  const addedIds: string[] = [];
  let created = 0, updated = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid card row.');
    const expression = text(raw.expression, 'expression', 200, true);
    const reading = text(raw.reading, 'reading', 200, true);
    const meaning = raw.meaning === undefined ? undefined : text(raw.meaning, 'meaning', 500);
    if (raw.level !== undefined && !WORD_LEVELS.includes(raw.level)) throw new Error('Invalid drawer level.');
    const rowKey = key({ expression, reading });
    if (seen.has(rowKey)) throw new Error(`Duplicate card in request: ${expression} / ${reading}`);
    seen.add(rowKey);
    const id = raw.id === undefined ? undefined : text(raw.id, 'card ID', 200, true);
    if (id && (seenIds.has(id) || removed.has(id))) throw new Error('Duplicate or deleted card ID in request.');
    if (id) seenIds.add(id);
    const found = id ? byId.get(id) : matches.get(rowKey)?.[0];
    if (id && !found) throw new Error(`Card ${id} no longer exists. Reload and try again.`);
    if (!id && (matches.get(rowKey)?.length ?? 0) > 1) throw new Error(`Multiple existing cards match ${expression} / ${reading}. Edit them by ID instead.`);
    if (found) {
      const position = index.get(found.id);
      if (position === undefined) throw new Error('Cannot update a deleted card.');
      next[position] = { ...next[position], expression, reading, ...(meaning !== undefined ? { meaning } : {}), ...(raw.level ? { level: raw.level } : {}) };
      updated++;
      addedIds.push(found.id);
    } else {
      const word: CustomWord = { id: `custom-admin-${crypto.randomUUID()}`, expression, reading, meaning: meaning ?? '', level: raw.level ?? 'Custom', createdAt: new Date().toISOString() };
      next.push(word); addedIds.push(word.id); created++;
    }
  }
  // Refuse ambiguous duplicates (including an ID-based rename to an existing key).
  const touched = new Set(addedIds);
  const allKeys = new Map<string, CustomWord>();
  for (const word of next) {
    const wordKey = key(word), previous = allKeys.get(wordKey);
    // Pre-existing duplicates are tolerated; don't let this request introduce one.
    if (previous && (touched.has(previous.id) || touched.has(word.id))) throw new Error('The change would create duplicate cards.');
    allKeys.set(wordKey, word);
  }
  const nextLists = lists.map(list => ({ ...list, wordIds: list.wordIds.filter(id => !removed.has(id)) }));
  if (targetList) {
    const list = nextLists.find(item => item.id === targetList.id)!;
    list.wordIds = [...new Set([...list.wordIds, ...addedIds])];
    if (list.wordIds.length > 5000) throw new Error('This save slot would exceed 5,000 cards.');
  }
  return { customWords: next, lists: nextLists, created, updated, deleted: removed.size };
}
