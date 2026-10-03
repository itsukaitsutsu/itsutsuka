import bank from './rankedBank.json';
import type { Word, WordLevel } from '../shared/vocabulary';
import { HttpError } from './auth';
import { loadAdminCatalog } from './adminContent';

export type Visibility = 'public' | 'selected';
export type PublishedRow = {
  id: string; source_uid: string; source_list_id: string; visibility: Visibility;
  recipient_uids: string; created_by: string; created_at: string; updated_at: string;
  snapshot_json: string | null;
};
export type DeckSubgroup = { id: string; name: string; cardIds: string[] };
export type DeckSnapshot = { name: string; cards: Word[]; subgroups?: DeckSubgroup[] };
export type DeckSummary = { id: string; name: string; cardCount: number; visibility: Visibility; updatedAt: string };
export type DeckDetail = DeckSummary & DeckSnapshot;
export type AdminDeckSummary = DeckSummary & { sourceUid: string; sourceListId: string; recipientUids: string[] };
export type AdminDeckRow = PublishedRow & { name: string | null; card_count: number | null };
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
export type SourceGroup = { id: string; name: string; wordIds: string[] };
export const GROUP_SOURCE_PREFIX = 'group:';
export const ADMIN_CONTENT_GROUP_SOURCE_PREFIX = 'admin-content-group:';
export const groupSourceId = (groupId: string) => `${GROUP_SOURCE_PREFIX}${groupId}`;
export const adminContentGroupSourceId = (groupId: string) => `${ADMIN_CONTENT_GROUP_SOURCE_PREFIX}${groupId}`;
export function sourceGroups(raw: string | null | undefined): SourceGroup[] {
  let data: unknown;
  try { data = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .filter(item => validListId(item.id) && typeof item.name === 'string' && Array.isArray(item.wordIds))
    .map(item => ({ id: item.id as string, name: (item.name as string).trim().slice(0, 120) || 'Untitled group',
      wordIds: (item.wordIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 5000) }));
}
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
// Imported personal copies can have a stale/default level or missing POS even
// when their expression + reading match an original. Recover metadata only for
// exact identity matches; never guess from expression alone.
const identity = (word: Pick<Word, 'expression' | 'reading'>) =>
  JSON.stringify([word.expression.normalize('NFKC').trim(), word.reading.normalize('NFKC').trim()]);
const originalByIdentity = new Map((bank as Word[]).map(word => [identity(word), word]));
const originalLevels = new Map((bank as Word[]).map(word => [identity(word), word.level]));
function withCanonicalPartOfSpeech(card: Word): Word {
  const original = originalByIdentity.get(identity(card));
  const partOfSpeechEn = card.partOfSpeechEn?.trim() || original?.partOfSpeechEn;
  const partOfSpeechJp = card.partOfSpeechJp?.trim() || original?.partOfSpeechJp;
  return { ...card, ...(partOfSpeechEn ? { partOfSpeechEn } : {}), ...(partOfSpeechJp ? { partOfSpeechJp } : {}) };
}

/** Build an independent, immutable copy from the source list at publish time. */
export async function createDeckSnapshot(db: D1Database, sourceUid: string, listId: string): Promise<DeckSnapshot | null> {
  if (listId.startsWith(ADMIN_CONTENT_GROUP_SOURCE_PREFIX)) {
    const groupId = listId.slice(ADMIN_CONTENT_GROUP_SOURCE_PREFIX.length);
    const group = await db.prepare('SELECT name FROM admin_content_groups WHERE id=?').bind(groupId).first<{ name: string }>();
    if (!group) return null;
    const catalog = await loadAdminCatalog(db);
    const groupBatches = catalog.batches
      .filter(batch => batch.group_id === groupId && batch.links.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const cardsById = new Map<string, Word>();
    const subgroups: DeckSubgroup[] = [];
    for (const batch of groupBatches) {
      const cardIds: string[] = [];
      for (const link of batch.links) {
        const stored = catalog.cardsById.get(link.cardId);
        if (!stored) continue;
        if (!cardsById.has(stored.id)) {
          const card: Word = {
            id: stored.id,
            expression: stored.expression,
            reading: stored.reading,
            meaning: stored.meaning ?? '',
            level: (['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(stored.level ?? '') ? stored.level : 'Custom') as WordLevel,
            tags: [],
            ...(stored.partOfSpeechEn ? { partOfSpeechEn: stored.partOfSpeechEn } : {}),
            ...(stored.partOfSpeechJp ? { partOfSpeechJp: stored.partOfSpeechJp } : {}),
          };
          cardsById.set(stored.id, { ...withCanonicalPartOfSpeech(card), level: originalLevels.get(identity(card)) ?? card.level });
        }
        cardIds.push(stored.id);
      }
      const uniqueIds = [...new Set(cardIds)];
      if (uniqueIds.length) subgroups.push({ id: batch.id, name: batch.name, cardIds: uniqueIds });
    }
    const cards = [...cardsById.values()].sort((a, b) =>
      a.expression.localeCompare(b.expression, undefined, { sensitivity: 'base' })
      || a.reading.localeCompare(b.reading, undefined, { sensitivity: 'base' }));
    return { name: group.name, cards, subgroups };
  }

  const source = await db.prepare('SELECT lists, custom_words, card_groups FROM user_data WHERE uid = ?').bind(sourceUid)
    .first<{ lists: string; custom_words: string; card_groups: string | null }>();
  if (!source) return null;
  const groupId = listId.startsWith(GROUP_SOURCE_PREFIX) ? listId.slice(GROUP_SOURCE_PREFIX.length) : null;
  const group = groupId !== null ? sourceGroups(source.card_groups).find(item => item.id === groupId) : null;
  const list = groupId === null ? sourceLists(source.lists).find(item => item.id === listId) : null;
  const sourceName = group?.name ?? list?.name;
  const sourceWordIds = group?.wordIds ?? list?.wordIds;
  if (!sourceName || !sourceWordIds) return null;

  let rawWords: unknown;
  try { rawWords = JSON.parse(source.custom_words); } catch { rawWords = []; }
  const personal = new Map<string, Word>();
  if (Array.isArray(rawWords)) for (const item of rawWords) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.expression !== 'string' || typeof item.reading !== 'string' || typeof item.meaning !== 'string') continue;
    if (!['N1','N2','N3','N4','N5','Custom'].includes(item.level)) continue;
    personal.set(item.id, {
      id: item.id, expression: item.expression, reading: item.reading, meaning: item.meaning,
      level: item.level as WordLevel, tags: [],
      ...(typeof item.partOfSpeechEn === 'string' && item.partOfSpeechEn.trim() ? { partOfSpeechEn: item.partOfSpeechEn.trim().slice(0, 80) } : {}),
      ...(typeof item.partOfSpeechJp === 'string' && item.partOfSpeechJp.trim() ? { partOfSpeechJp: item.partOfSpeechJp.trim().slice(0, 80) } : {}),
    });
  }
  const cards = [...new Set(sourceWordIds)].flatMap(id => {
    const card = personal.get(id) ?? originals.get(id);
    if (!card) return [];
    return [{ ...withCanonicalPartOfSpeech(card), level: originalLevels.get(identity(card)) ?? 'Custom' }];
  });
  return { name: sourceName, cards };
}

const MAX_PUBLISHED_SNAPSHOT_BYTES = 1_900_000; // Stay below D1's 2 MB per-row limit.
export function serializeDeckSnapshot(snapshot: DeckSnapshot): string {
  const raw = JSON.stringify(snapshot);
  if (new TextEncoder().encode(raw).byteLength > MAX_PUBLISHED_SNAPSHOT_BYTES) {
    throw new HttpError(413, 'This source list or group is too large to publish as a permanent copy.');
  }
  return raw;
}

export function parseDeckSnapshot(raw: string | null | undefined): DeckSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.name !== 'string' || !Array.isArray(snapshot.cards)) return null;
    const cards = snapshot.cards.filter((item): item is Word => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const card = item as Record<string, unknown>;
      return typeof card.id === 'string' && typeof card.expression === 'string'
        && typeof card.reading === 'string' && typeof card.meaning === 'string'
        && ['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(card.level as string)
        && Array.isArray(card.tags) && card.tags.every(tag => typeof tag === 'string')
        && (card.partOfSpeechEn === undefined || typeof card.partOfSpeechEn === 'string')
        && (card.partOfSpeechJp === undefined || typeof card.partOfSpeechJp === 'string');
    });
    const canonicalCards = cards.map(withCanonicalPartOfSpeech);
    const cardIds = new Set(canonicalCards.map(card => card.id));
    const subgroups = Array.isArray(snapshot.subgroups) ? snapshot.subgroups.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const subgroup = item as Record<string, unknown>;
      if (!validListId(subgroup.id) || typeof subgroup.name !== 'string' || !Array.isArray(subgroup.cardIds)) return [];
      const name = subgroup.name.trim().slice(0, 120);
      const subgroupCardIds = [...new Set((subgroup.cardIds as unknown[]).filter((id): id is string => typeof id === 'string' && cardIds.has(id)))];
      return name && subgroupCardIds.length ? [{ id: subgroup.id, name, cardIds: subgroupCardIds }] : [];
    }) : undefined;
    return { name: snapshot.name.trim().slice(0, 120) || 'Untitled list', cards: canonicalCards,
      ...(subgroups ? { subgroups } : {}) };
  } catch { return null; }
}

/** Backfill pre-snapshot publications the first time they are opened or listed. */
export async function ensureDeckSnapshot(db: D1Database, row: PublishedRow): Promise<DeckSnapshot | null> {
  const saved = parseDeckSnapshot(row.snapshot_json);
  // A stored snapshot without subgroup metadata must remain a whole deck.
  // Its historical batch mapping cannot be reconstructed reliably from the
  // current admin catalog without changing the snapshot's original meaning.
  if (saved) return saved;
  const snapshot = await createDeckSnapshot(db, row.source_uid, row.source_list_id);
  if (!snapshot) return null;
  await db.prepare('UPDATE published_decks SET snapshot_json = ? WHERE id = ? AND snapshot_json IS NULL')
    .bind(serializeDeckSnapshot(snapshot), row.id).run();
  return snapshot;
}

export async function readPublishedDeck(db: D1Database, id: string, viewerUid: string): Promise<DeckDetail> {
  const row = await db.prepare('SELECT * FROM published_decks WHERE id = ?').bind(id).first<PublishedRow>();
  // Never reveal whether a private deck exists to an unauthorized user.
  if (!row || !readable(row, viewerUid)) throw new HttpError(404, 'Deck not found.');
  const snapshot = await ensureDeckSnapshot(db, row);
  if (!snapshot) throw new HttpError(404, 'Deck not found.');
  return { ...snapshot, id: row.id, cardCount: snapshot.cards.length,
    visibility: row.visibility, updatedAt: row.updated_at };
}
function recipients(raw: string): string[] { try { const data: unknown = JSON.parse(raw); return Array.isArray(data) ? data.filter(validUid) : []; } catch { return []; } }
export function toAdminDeck(row: AdminDeckRow): AdminDeckSummary {
  const snapshot = parseDeckSnapshot(row.snapshot_json);
  return { id: row.id, name: snapshot?.name ?? row.name ?? '(source list removed)',
    cardCount: snapshot?.cards.length ?? row.card_count ?? 0, visibility: row.visibility,
    recipientUids: recipients(row.recipient_uids), sourceUid: row.source_uid,
    sourceListId: row.source_list_id, updatedAt: row.updated_at };
}
