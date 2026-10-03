import bank from './rankedBank.json';
import type { Word, WordLevel } from '../shared/vocabulary';
import { HttpError } from './auth';
import { loadAdminCatalog, PUBLISHED_DECK_CHUNK_PREFIX } from './adminContent';

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

const MAX_INLINE_SNAPSHOT_BYTES = 700_000; // Keep inline single-row snapshots well below D1's 1 MB statement / 2 MB row limit.
const PUBLISHED_CHUNK_CARDS = 1500;
const MAX_TOTAL_SNAPSHOT_BYTES = 15_000_000;

export function serializeDeckSnapshot(snapshot: DeckSnapshot): string {
  const raw = JSON.stringify(snapshot);
  if (new TextEncoder().encode(raw).byteLength > MAX_TOTAL_SNAPSHOT_BYTES) {
    throw new HttpError(413, 'This source list or group is too large to publish as a permanent copy.');
  }
  return raw;
}

type CompactSubgroup = { id: string; name: string; idx: number[] };

export function preparePublishedDeckStatements(
  db: D1Database,
  row: {
    id: string;
    sourceUid: string;
    sourceListId: string;
    visibility: Visibility;
    recipientUids: string[];
    createdBy: string;
    timestamp: string;
  },
  snapshot: DeckSnapshot,
): D1PreparedStatement[] {
  const fullRaw = serializeDeckSnapshot(snapshot);
  const fullBytes = new TextEncoder().encode(fullRaw).byteLength;

  if (fullBytes <= MAX_INLINE_SNAPSHOT_BYTES) {
    return [
      db.prepare(`INSERT OR IGNORE INTO published_decks
        (id, source_uid, source_list_id, visibility, recipient_uids, created_by, created_at, updated_at, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, row.sourceUid, row.sourceListId, row.visibility, JSON.stringify(row.recipientUids), row.createdBy, row.timestamp, row.timestamp, fullRaw),
    ];
  }

  // Large deck (e.g. 25,000–30,000 cards): split cards into <350 KB chunk rows
  // and map subgroup cardIds to integer indexes so the manifest stays small.
  const indexByCardId = new Map(snapshot.cards.map((card, index) => [card.id, index]));
  const compactSubgroups: CompactSubgroup[] | undefined = snapshot.subgroups?.map(sg => ({
    id: sg.id,
    name: sg.name,
    idx: sg.cardIds.map(id => indexByCardId.get(id)).filter((n): n is number => n !== undefined),
  }));

  const chunkCount = Math.ceil(snapshot.cards.length / PUBLISHED_CHUNK_CARDS);
  const manifestJson = JSON.stringify({
    name: snapshot.name,
    cardCount: snapshot.cards.length,
    chunkCount,
    cards: [],
    ...(compactSubgroups ? { compactSubgroups } : {}),
  });

  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO published_decks
      (id, source_uid, source_list_id, visibility, recipient_uids, created_by, created_at, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.sourceUid, row.sourceListId, row.visibility, JSON.stringify(row.recipientUids), row.createdBy, row.timestamp, row.timestamp, manifestJson),
  ];

  for (let i = 0; i < chunkCount; i++) {
    const chunkId = `${PUBLISHED_DECK_CHUNK_PREFIX}${row.id}_${i}`;
    const slice = snapshot.cards.slice(i * PUBLISHED_CHUNK_CARDS, (i + 1) * PUBLISHED_CHUNK_CARDS);
    statements.push(
      db.prepare(`INSERT OR REPLACE INTO published_decks
        (id, source_uid, source_list_id, visibility, recipient_uids, created_by, created_at, updated_at, snapshot_json)
        VALUES (?, '__pub_chunk__', ?, 'selected', '[]', ?, ?, ?, ?)`)
        .bind(chunkId, `${row.id}:${i}`, row.createdBy, row.timestamp, row.timestamp, JSON.stringify(slice)),
    );
  }
  return statements;
}

export async function deletePublishedDeckAndChunks(db: D1Database, deckId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM published_decks WHERE id = ?').bind(deckId).run();
  if (!result.meta.changes) return false;
  await db.prepare(`DELETE FROM published_decks WHERE id LIKE ?`).bind(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_%`).run();
  try {
    await db.prepare(`DELETE FROM admin_content_cards WHERE id LIKE ? OR expression = '__pub_chunk__'`).bind(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_%`).run();
  } catch { /* ignore if 0012 not applied */ }
  return true;
}

function sanitizeSnapshotCards(rawCards: unknown[]): Word[] {
  return rawCards.filter((item): item is Word => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const card = item as Record<string, unknown>;
    return typeof card.id === 'string' && typeof card.expression === 'string'
      && typeof card.reading === 'string' && typeof card.meaning === 'string'
      && ['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(card.level as string)
      && Array.isArray(card.tags) && card.tags.every(tag => typeof tag === 'string')
      && (card.partOfSpeechEn === undefined || typeof card.partOfSpeechEn === 'string')
      && (card.partOfSpeechJp === undefined || typeof card.partOfSpeechJp === 'string');
  }).map(withCanonicalPartOfSpeech);
}

export function parseDeckSnapshotSummary(raw: string | null | undefined): { name: string; cardCount: number; chunkCount: number } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.name !== 'string') return null;
    const name = snapshot.name.trim().slice(0, 120) || 'Untitled list';
    const chunkCount = typeof snapshot.chunkCount === 'number' && Number.isSafeInteger(snapshot.chunkCount) && snapshot.chunkCount > 0
      ? snapshot.chunkCount
      : 0;
    if (chunkCount > 0 && typeof snapshot.cardCount === 'number') {
      return { name, cardCount: snapshot.cardCount, chunkCount };
    }
    if (!Array.isArray(snapshot.cards)) return null;
    const cards = sanitizeSnapshotCards(snapshot.cards);
    return { name, cardCount: cards.length, chunkCount: 0 };
  } catch { return null; }
}

export function parseDeckSnapshot(raw: string | null | undefined): DeckSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.name !== 'string' || !Array.isArray(snapshot.cards)) return null;
    const canonicalCards = sanitizeSnapshotCards(snapshot.cards);
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

async function loadChunkedDeckSnapshot(db: D1Database, deckId: string, raw: string): Promise<DeckSnapshot | null> {
  try {
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof manifest.name === 'string' ? (manifest.name.trim().slice(0, 120) || 'Untitled list') : 'Untitled list';
    const chunkRows = await db.prepare(
      `SELECT id, snapshot_json FROM published_decks WHERE id LIKE ?`,
    ).bind(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_%`).all<{ id: string; snapshot_json: string | null }>();
    const rawCards: unknown[] = [];
    if (chunkRows.results.length > 0) {
      chunkRows.results.sort((a, b) => Number(a.id.slice(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_`.length)) - Number(b.id.slice(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_`.length)));
      for (const row of chunkRows.results) {
        if (!row.snapshot_json) continue;
        const parsed: unknown = JSON.parse(row.snapshot_json);
        if (Array.isArray(parsed)) rawCards.push(...parsed);
      }
    } else {
      // Fallback for chunks written to admin_content_cards previously
      const legacyChunks = await db.prepare(
        `SELECT reading, meaning FROM admin_content_cards WHERE id LIKE ?`,
      ).bind(`${PUBLISHED_DECK_CHUNK_PREFIX}${deckId}_%`).all<{ reading: string; meaning: string | null }>();
      legacyChunks.results.sort((a, b) => Number(a.reading) - Number(b.reading));
      for (const row of legacyChunks.results) {
        if (!row.meaning) continue;
        const parsed: unknown = JSON.parse(row.meaning);
        if (Array.isArray(parsed)) rawCards.push(...parsed);
      }
    }
    const canonicalCards = sanitizeSnapshotCards(rawCards);
    const subgroups = Array.isArray(manifest.compactSubgroups) ? manifest.compactSubgroups.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const sg = item as Record<string, unknown>;
      if (!validListId(sg.id) || typeof sg.name !== 'string' || !Array.isArray(sg.idx)) return [];
      const sgName = sg.name.trim().slice(0, 120);
      const cardIds = [...new Set((sg.idx as unknown[])
        .filter((n): n is number => typeof n === 'number' && n >= 0 && n < canonicalCards.length)
        .map(n => canonicalCards[n].id))];
      return sgName && cardIds.length ? [{ id: sg.id, name: sgName, cardIds }] : [];
    }) : undefined;
    return { name, cards: canonicalCards, ...(subgroups ? { subgroups } : {}) };
  } catch { return null; }
}

/** Fast summary for listing endpoints (`GET /api/decks` & `GET /api/admin/decks`). */
export async function ensureDeckSummary(db: D1Database, row: PublishedRow): Promise<{ name: string; cardCount: number } | null> {
  const summary = parseDeckSnapshotSummary(row.snapshot_json);
  if (summary) return { name: summary.name, cardCount: summary.cardCount };
  const snapshot = await ensureDeckSnapshot(db, row);
  return snapshot ? { name: snapshot.name, cardCount: snapshot.cards.length } : null;
}

/** Backfill pre-snapshot publications the first time they are opened or listed. */
export async function ensureDeckSnapshot(db: D1Database, row: PublishedRow): Promise<DeckSnapshot | null> {
  const summary = parseDeckSnapshotSummary(row.snapshot_json);
  if (summary && summary.chunkCount > 0 && row.snapshot_json) {
    return await loadChunkedDeckSnapshot(db, row.id, row.snapshot_json);
  }
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
  const summary = parseDeckSnapshotSummary(row.snapshot_json);
  return { id: row.id, name: summary?.name ?? row.name ?? '(source list removed)',
    cardCount: summary?.cardCount ?? row.card_count ?? 0, visibility: row.visibility,
    recipientUids: recipients(row.recipient_uids), sourceUid: row.source_uid,
    sourceListId: row.source_list_id, updatedAt: row.updated_at };
}
