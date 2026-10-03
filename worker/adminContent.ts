import bank from './rankedBank.json';
import type { Word, WordLevel } from '../shared/vocabulary';
import { ADMIN_CONTENT_GROUP_SOURCE_PREFIX, sourceGroups, sourceLists } from './publishedDecks';

export const ADMIN_CONTENT_MAX_GROUPS = 100;
export const ADMIN_CONTENT_MAX_FILES = 100;
export const ADMIN_CONTENT_MAX_ROWS = 30000;
export const ADMIN_CONTENT_MAX_BYTES = 10_000_000;

export type AdminContentEntry = {
  expression: string;
  reading: string;
  meaning?: string;
  level?: WordLevel;
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
};
export type AdminContentSourceKind = 'my_words' | 'list' | 'group';
export type AdminContentCardSource = {
  id: string;
  expression: string;
  reading: string;
  meaning: string;
  level: WordLevel;
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
};

export function adminContentIdentity(expression: string, reading: string): string {
  return JSON.stringify([expression.normalize('NFKC').trim(), reading.normalize('NFKC').trim()]);
}

export function adminContentText(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const result = value.normalize('NFKC').trim();
  if ((required && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`Invalid ${label} (max ${max} characters, no control characters).`);
  }
  return result;
}

export function validateAdminContentEntry(raw: unknown): AdminContentEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid card row.');
  const row = raw as Record<string, unknown>;
  const expression = adminContentText(row.expression, 'expression', 200, true);
  const reading = adminContentText(row.reading, 'reading', 200, true);
  const meaning = row.meaning === undefined ? undefined : adminContentText(row.meaning, 'meaning', 500);
  const partOfSpeechEn = row.partOfSpeechEn === undefined ? undefined : adminContentText(row.partOfSpeechEn, 'English part of speech', 80);
  const partOfSpeechJp = row.partOfSpeechJp === undefined ? undefined : adminContentText(row.partOfSpeechJp, 'Japanese part of speech', 80);
  if (row.level !== undefined && !['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(String(row.level))) throw new Error('Invalid card level.');
  return {
    expression, reading,
    ...(meaning !== undefined ? { meaning } : {}),
    ...(row.level !== undefined ? { level: row.level as WordLevel } : {}),
    ...(partOfSpeechEn !== undefined ? { partOfSpeechEn } : {}),
    ...(partOfSpeechJp !== undefined ? { partOfSpeechJp } : {}),
  };
}

const originals = new Map((bank as Word[]).map(word => [word.id, word]));
const originalsByIdentity = new Map((bank as Word[]).map(word => [adminContentIdentity(word.expression, word.reading), word]));
function cleanPersonalWords(raw: unknown): AdminContentCardSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.expression !== 'string' || typeof row.reading !== 'string' || typeof row.meaning !== 'string') return [];
    const canonical = originalsByIdentity.get(adminContentIdentity(row.expression, row.reading));
    const level = canonical?.level ?? (['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(String(row.level)) ? row.level as WordLevel : 'Custom');
    const partOfSpeechEn = (typeof row.partOfSpeechEn === 'string' ? row.partOfSpeechEn.trim() : '') || canonical?.partOfSpeechEn;
    const partOfSpeechJp = (typeof row.partOfSpeechJp === 'string' ? row.partOfSpeechJp.trim() : '') || canonical?.partOfSpeechJp;
    return [{ id: row.id, expression: row.expression, reading: row.reading, meaning: row.meaning, level,
      ...(partOfSpeechEn ? { partOfSpeechEn: partOfSpeechEn.slice(0, 80) } : {}),
      ...(partOfSpeechJp ? { partOfSpeechJp: partOfSpeechJp.slice(0, 80) } : {}) }];
  });
}

/** Resolve a personal collection into a safe copy source without mutating user_data. */
export async function resolvePersonalContentSource(
  db: D1Database,
  sourceUid: string,
  sourceKind: AdminContentSourceKind,
  sourceId: string | null,
  sourceAll: boolean,
  selectedSourceIds: string[],
): Promise<{ version: number; sourceName: string; cards: AdminContentCardSource[] } | null> {
  const row = await db.prepare('SELECT lists, custom_words, card_groups, version FROM user_data WHERE uid = ?').bind(sourceUid)
    .first<{ lists: string; custom_words: string; card_groups: string | null; version: number }>();
  if (!row) return null;

  const customWords = cleanPersonalWords(safeJson(row.custom_words));
  const customById = new Map(customWords.map(card => [card.id, card]));
  let sourceName = 'My words';
  let ids: string[];
  if (sourceKind === 'my_words') {
    ids = customWords.map(card => card.id);
  } else if (sourceKind === 'list') {
    const listId = sourceId ?? '';
    const list = sourceLists(row.lists).find(item => item.id === listId);
    if (!list) return { version: row.version, sourceName: '', cards: [] };
    sourceName = list.name; ids = list.wordIds;
  } else {
    const groupId = sourceId ?? '';
    const group = sourceGroups(row.card_groups).find(item => item.id === groupId);
    if (!group) return { version: row.version, sourceName: '', cards: [] };
    sourceName = group.name; ids = group.wordIds;
  }
  const selected = sourceAll ? new Set(ids) : new Set(selectedSourceIds);
  const uniqueCards = new Map<string, AdminContentCardSource>();
  for (const id of [...new Set(ids)]) {
    if (!selected.has(id)) continue;
    const personal = customById.get(id);
    const original = originals.get(id);
    const card = personal ?? (original ? { id: original.id, expression: original.expression, reading: original.reading,
      meaning: original.meaning, level: original.level,
      ...(original.partOfSpeechEn ? { partOfSpeechEn: original.partOfSpeechEn } : {}),
      ...(original.partOfSpeechJp ? { partOfSpeechJp: original.partOfSpeechJp } : {}) } : null);
    if (!card) continue;
    const key = adminContentIdentity(card.expression, card.reading);
    if (!uniqueCards.has(key)) uniqueCards.set(key, card);
  }
  return { version: row.version, sourceName, cards: [...uniqueCards.values()] };
}

export function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return [];
  try { return JSON.parse(raw) as unknown; } catch { return []; }
}
