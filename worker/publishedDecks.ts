import bank from './rankedBank.json';
import type { Word, WordLevel } from '../shared/vocabulary';
import { HttpError } from './auth';

export type Visibility = 'public' | 'selected';
export type PublishedRow = {
  id: string; source_uid: string; source_list_id: string; visibility: Visibility;
  recipient_uids: string; created_by: string; created_at: string; updated_at: string;
};
export type DeckSummary = { id: string; name: string; cardCount: number; visibility: Visibility; updatedAt: string };
export type DeckDetail = DeckSummary & { cards: Word[] };
export type AdminDeckSummary = DeckSummary & { sourceUid: string; sourceListId: string; recipientUids: string[] };
export type PublicationInput = { visibility: Visibility; recipientUids: string[] };
export type PublishInput = PublicationInput & { sourceUid: string; listId: string };

export const validUid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
export const validListId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function validatePublication(input: unknown): PublicationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid publication.');
  const body = input as Record<string, unknown>;
  if (body.visibility !== 'public' && body.visibility !== 'selected') throw new HttpError(400, 'Choose Everyone or Selected users.');
  if (!Array.isArray(body.recipientUids) || body.recipientUids.length > 100 || body.recipientUids.some(uid => !validUid(uid))) throw new HttpError(400, 'Enter up to 100 valid Firebase UIDs.');
  const recipientUids = [...new Set(body.recipientUids as string[])];
  if (body.visibility === 'selected' && !recipientUids.length) throw new HttpError(400, 'Add at least one recipient UID.');
  if (body.visibility === 'public' && recipientUids.length) throw new HttpError(400, 'Remove recipient UIDs when publishing for everyone.');
  return { visibility: body.visibility, recipientUids };
}

export type SourceList = { id: string; name: string; wordIds: string[] };
export function sourceLists(raw: string): SourceList[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .filter(item => validListId(item.id) && typeof item.name === 'string' && Array.isArray(item.wordIds))
    .map(item => ({ id: item.id as string, name: (item.name as string).trim().slice(0, 120) || 'Untitled list',
      wordIds: (item.wordIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 5000) }));
}
export async function getSourceList(db: D1Database, sourceUid: string, listId: string): Promise<SourceList | null> {
  const row = await db.prepare('SELECT lists FROM user_data WHERE uid = ?').bind(sourceUid).first<{ lists: string }>();
  return row ? sourceLists(row.lists).find(item => item.id === listId) ?? null : null;
}
function readable(row: PublishedRow, uid: string): boolean {
  if (row.visibility === 'public') return true;
  try { return (JSON.parse(row.recipient_uids) as unknown[]).includes(uid); } catch { return false; }
}
const originals = new Map((bank as Word[]).map(word => [word.id, word]));
// CSV-imported personal cards can carry an old/default N5 level even when their
// expression + reading match an original of a different JLPT level. Classify
// the published view by the canonical catalogue, without editing owner data.
const identity = (word: Pick<Word, 'expression' | 'reading'>) =>
  JSON.stringify([word.expression.normalize('NFKC').trim(), word.reading.normalize('NFKC').trim()]);
const originalLevels = new Map((bank as Word[]).map(word => [identity(word), word.level]));
export async function readPublishedDeck(db: D1Database, id: string, viewerUid: string): Promise<DeckDetail> {
  const row = await db.prepare('SELECT * FROM published_decks WHERE id = ?').bind(id).first<PublishedRow>();
  // Never reveal whether a private deck exists to an unauthorized user.
  if (!row || !readable(row, viewerUid)) throw new HttpError(404, 'Deck not found.');
  const source = await db.prepare('SELECT lists, custom_words FROM user_data WHERE uid = ?').bind(row.source_uid).first<{ lists: string; custom_words: string }>();
  const list = source && sourceLists(source.lists).find(item => item.id === row.source_list_id);
  if (!list) throw new HttpError(404, 'Deck not found.');
  let rawWords: unknown;
  try { rawWords = JSON.parse(source.custom_words); } catch { rawWords = []; }
  const personal = new Map<string, Word>();
  if (Array.isArray(rawWords)) for (const item of rawWords) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.expression !== 'string' || typeof item.reading !== 'string' || typeof item.meaning !== 'string') continue;
    if (!['N1','N2','N3','N4','N5','Custom'].includes(item.level)) continue;
    personal.set(item.id, { id: item.id, expression: item.expression, reading: item.reading, meaning: item.meaning, level: item.level as WordLevel, tags: [] });
  }
  const cards = [...new Set(list.wordIds)].flatMap(id => {
    const card = personal.get(id) ?? originals.get(id);
    if (!card) return [];
    // Match the original by expression AND reading, not by the saved card ID:
    // a CSV may have created a personal copy with a different ID and N5 default.
    return [{ ...card, level: originalLevels.get(identity(card)) ?? 'Custom' }];
  });
  return { id: row.id, name: list.name, cardCount: cards.length, visibility: row.visibility, updatedAt: row.updated_at, cards };
}
function recipients(raw: string): string[] { try { const data: unknown = JSON.parse(raw); return Array.isArray(data) ? data.filter(validUid) : []; } catch { return []; } }
export function toAdminDeck(row: PublishedRow & { name: string | null; card_count: number | null }): AdminDeckSummary {
  return { id: row.id, name: row.name || '(source list removed)', cardCount: row.card_count ?? 0,
    visibility: row.visibility, recipientUids: recipients(row.recipient_uids), sourceUid: row.source_uid,
    sourceListId: row.source_list_id, updatedAt: row.updated_at };
}
