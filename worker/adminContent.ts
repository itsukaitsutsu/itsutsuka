import bank from './rankedBank.json';
import type { Word, WordLevel } from '../shared/vocabulary';
import { ADMIN_CONTENT_GROUP_SOURCE_PREFIX, sourceGroups, sourceLists } from './publishedDecks';

export const ADMIN_CONTENT_MAX_GROUPS = 100;
export const ADMIN_CONTENT_MAX_FILES = 100;
export const ADMIN_CONTENT_MAX_ROWS = 30000;
export const ADMIN_CONTENT_MAX_BYTES = 10_000_000;
export const ADMIN_CONTENT_CHUNK_SIZE = 1500;
export const ADMIN_CARD_CHUNK_PREFIX = '__chunk_';

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

export type StoredAdminCard = {
  id: string;
  identityKey: string;
  expression: string;
  reading: string;
  meaning: string;
  level: WordLevel;
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredBatchLink = {
  cardId: string;
  sourceCardId: string | null;
  position: number;
};

export type ParsedBatchStorage = {
  isLegacy: boolean;
  selectedSourceIds: string[];
  links: StoredBatchLink[];
};

export type RawBatchDbRow = {
  id: string;
  name: string;
  kind: 'csv' | 'personal';
  group_id: string | null;
  source_uid: string | null;
  source_kind: string | null;
  source_id: string | null;
  source_all: number;
  selected_source_ids: string;
  source_version: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type LoadedBatch = RawBatchDbRow & {
  selectedSourceIds: string[];
  links: StoredBatchLink[];
  isLegacy: boolean;
};

export type LoadedAdminCatalog = {
  cards: StoredAdminCard[];
  cardsById: Map<string, StoredAdminCard>;
  cardsByIdentity: Map<string, StoredAdminCard>;
  batches: LoadedBatch[];
  batchesById: Map<string, LoadedBatch>;
  chunkJsonById: Map<string, string>;
  legacyCardIds: string[];
  hasLegacyBatches: boolean;
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

/**
 * Parse `admin_content_batches.selected_source_ids`.
 * Legacy rows stored a plain JSON array of source card IDs and kept batch-card
 * links in `admin_content_batch_cards`. Optimized rows store `{ s, c }` in the
 * batch row itself so importing/deleting thousands of cards costs 1 row write
 * per batch instead of 4N index/table writes in `admin_content_batch_cards`.
 */
export function parseBatchStorage(raw: string | null | undefined): ParsedBatchStorage {
  const parsed = safeJson(raw);
  if (Array.isArray(parsed)) {
    return {
      isLegacy: true,
      selectedSourceIds: parsed.filter((id): id is string => typeof id === 'string'),
      links: [],
    };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const selectedSourceIds = Array.isArray(obj.s)
      ? obj.s.filter((id): id is string => typeof id === 'string')
      : [];
    const rawLinks = Array.isArray(obj.c) ? obj.c : [];
    const links: StoredBatchLink[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rawLinks.length; i++) {
      const item = rawLinks[i];
      let cardId = '';
      let sourceCardId: string | null = null;
      if (typeof item === 'string') {
        cardId = item;
      } else if (Array.isArray(item) && typeof item[0] === 'string') {
        cardId = item[0];
        sourceCardId = typeof item[1] === 'string' ? item[1] : null;
      }
      if (!cardId || seen.has(cardId)) continue;
      seen.add(cardId);
      links.push({ cardId, sourceCardId, position: links.length });
    }
    return { isLegacy: false, selectedSourceIds, links };
  }
  return { isLegacy: true, selectedSourceIds: [], links: [] };
}

export function serializeBatchStorage(
  selectedSourceIds: string[],
  links: Array<{ cardId: string; sourceCardId?: string | null }>,
): string {
  const seen = new Set<string>();
  const compactLinks: Array<string | [string, string]> = [];
  for (const link of links) {
    if (!link.cardId || seen.has(link.cardId)) continue;
    seen.add(link.cardId);
    compactLinks.push(link.sourceCardId ? [link.cardId, link.sourceCardId] : link.cardId);
  }
  return JSON.stringify({
    ...(selectedSourceIds.length ? { s: selectedSourceIds } : {}),
    c: compactLinks,
  });
}

function normalizeLevel(level: unknown): WordLevel {
  return (['N1', 'N2', 'N3', 'N4', 'N5', 'Custom'].includes(String(level ?? '')) ? level : 'Custom') as WordLevel;
}

function parseChunkCards(raw: string | null): StoredAdminCard[] {
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];
  const result: StoredAdminCard[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.expression !== 'string' || typeof row.reading !== 'string') continue;
    const identityKey = typeof row.identityKey === 'string' && row.identityKey
      ? row.identityKey
      : adminContentIdentity(row.expression, row.reading);
    result.push({
      id: row.id,
      identityKey,
      expression: row.expression,
      reading: row.reading,
      meaning: typeof row.meaning === 'string' ? row.meaning : '',
      level: normalizeLevel(row.level),
      ...(typeof row.partOfSpeechEn === 'string' && row.partOfSpeechEn ? { partOfSpeechEn: row.partOfSpeechEn } : {}),
      ...(typeof row.partOfSpeechJp === 'string' && row.partOfSpeechJp ? { partOfSpeechJp: row.partOfSpeechJp } : {}),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    });
  }
  return result;
}

/**
 * Load all admin content cards and batch memberships.
 * Supports both chunked JSON rows in `admin_content_cards` (1 row per 1,500 cards)
 * and legacy per-card rows from before the D1 write optimization.
 */
export async function loadAdminCatalog(db: D1Database): Promise<LoadedAdminCatalog> {
  const [cardRowsResult, batchRowsResult] = await Promise.all([
    db.prepare(`SELECT id, identity_key, expression, reading, meaning, level, part_of_speech_en, part_of_speech_jp, created_at, updated_at
      FROM admin_content_cards`).all<{
      id: string; identity_key: string; expression: string; reading: string; meaning: string | null;
      level: string | null; part_of_speech_en: string | null; part_of_speech_jp: string | null;
      created_at: string; updated_at: string;
    }>(),
    db.prepare(`SELECT id, name, kind, group_id, source_uid, source_kind, source_id, source_all,
      selected_source_ids, source_version, created_by, created_at, updated_at
      FROM admin_content_batches ORDER BY created_at DESC, name COLLATE NOCASE`).all<RawBatchDbRow>(),
  ]);

  const chunkRows: Array<{ index: number; id: string; raw: string }> = [];
  const legacyCards: StoredAdminCard[] = [];
  const legacyCardIds: string[] = [];
  const chunkJsonById = new Map<string, string>();

  for (const row of cardRowsResult.results) {
    if (row.id.startsWith(ADMIN_CARD_CHUNK_PREFIX)) {
      const index = Number(row.id.slice(ADMIN_CARD_CHUNK_PREFIX.length));
      const raw = row.meaning ?? '[]';
      chunkJsonById.set(row.id, raw);
      chunkRows.push({ index: Number.isFinite(index) ? index : 0, id: row.id, raw });
    } else {
      legacyCardIds.push(row.id);
      legacyCards.push({
        id: row.id,
        identityKey: row.identity_key || adminContentIdentity(row.expression, row.reading),
        expression: row.expression,
        reading: row.reading,
        meaning: row.meaning ?? '',
        level: normalizeLevel(row.level),
        ...(row.part_of_speech_en ? { partOfSpeechEn: row.part_of_speech_en } : {}),
        ...(row.part_of_speech_jp ? { partOfSpeechJp: row.part_of_speech_jp } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  }

  chunkRows.sort((a, b) => a.index - b.index);
  const cards: StoredAdminCard[] = [];
  const cardsById = new Map<string, StoredAdminCard>();
  const cardsByIdentity = new Map<string, StoredAdminCard>();

  const registerCard = (card: StoredAdminCard) => {
    if (cardsById.has(card.id) || cardsByIdentity.has(card.identityKey)) return;
    cards.push(card);
    cardsById.set(card.id, card);
    cardsByIdentity.set(card.identityKey, card);
  };

  for (const chunk of chunkRows) {
    for (const card of parseChunkCards(chunk.raw)) registerCard(card);
  }
  for (const card of legacyCards) registerCard(card);

  const parsedBatches = batchRowsResult.results.map(row => {
    const parsed = parseBatchStorage(row.selected_source_ids);
    return { ...row, selectedSourceIds: parsed.selectedSourceIds, links: parsed.links, isLegacy: parsed.isLegacy };
  });

  const hasLegacyBatches = parsedBatches.some(batch => batch.isLegacy);
  if (hasLegacyBatches) {
    const legacyLinksResult = await db.prepare(
      `SELECT batch_id, card_id, source_card_id, position FROM admin_content_batch_cards ORDER BY batch_id, position`,
    ).all<{ batch_id: string; card_id: string; source_card_id: string | null; position: number }>();
    const linksByBatch = new Map<string, StoredBatchLink[]>();
    for (const row of legacyLinksResult.results) {
      const list = linksByBatch.get(row.batch_id) ?? [];
      list.push({ cardId: row.card_id, sourceCardId: row.source_card_id, position: row.position });
      linksByBatch.set(row.batch_id, list);
    }
    for (const batch of parsedBatches) {
      if (batch.isLegacy) batch.links = linksByBatch.get(batch.id) ?? [];
    }
  }

  // Filter links to existing catalog cards so deleted cards never dangle.
  const batches: LoadedBatch[] = [];
  const batchesById = new Map<string, LoadedBatch>();
  for (const batch of parsedBatches) {
    const validLinks: StoredBatchLink[] = [];
    const seen = new Set<string>();
    for (const link of batch.links) {
      if (!cardsById.has(link.cardId) || seen.has(link.cardId)) continue;
      seen.add(link.cardId);
      validLinks.push({ cardId: link.cardId, sourceCardId: link.sourceCardId, position: validLinks.length });
    }
    const loaded: LoadedBatch = { ...batch, links: validLinks };
    batches.push(loaded);
    batchesById.set(loaded.id, loaded);
  }

  return { cards, cardsById, cardsByIdentity, batches, batchesById, chunkJsonById, legacyCardIds, hasLegacyBatches };
}

/**
 * Generate the minimal D1 write statements to persist `nextCards` into chunk rows.
 * Only chunks whose serialized JSON actually changed are written!
 */
export function buildCatalogCardWriteStatements(
  db: D1Database,
  previous: LoadedAdminCatalog,
  nextCards: StoredAdminCard[],
  timestamp: string,
  skipLegacyBatchIds: ReadonlySet<string> = new Set(),
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  // If there were legacy batches using `admin_content_batch_cards`, migrate them
  // into `admin_content_batches.selected_source_ids` before removing legacy card rows.
  if (previous.hasLegacyBatches) {
    for (const batch of previous.batches) {
      if (!batch.isLegacy || skipLegacyBatchIds.has(batch.id)) continue;
      statements.push(
        db.prepare('UPDATE admin_content_batches SET selected_source_ids = ? WHERE id = ?')
          .bind(serializeBatchStorage(batch.selectedSourceIds, batch.links), batch.id),
      );
    }
    statements.push(db.prepare('DELETE FROM admin_content_batch_cards'));
  }

  if (previous.legacyCardIds.length > 0) {
    statements.push(
      db.prepare(`DELETE FROM admin_content_cards WHERE id NOT LIKE '${ADMIN_CARD_CHUNK_PREFIX}%'`),
    );
  }

  const nextChunkIds = new Set<string>();
  const totalChunks = Math.ceil(nextCards.length / ADMIN_CONTENT_CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const chunkId = `${ADMIN_CARD_CHUNK_PREFIX}${i}`;
    nextChunkIds.add(chunkId);
    const slice = nextCards.slice(i * ADMIN_CONTENT_CHUNK_SIZE, (i + 1) * ADMIN_CONTENT_CHUNK_SIZE);
    const json = JSON.stringify(slice);
    if (previous.chunkJsonById.get(chunkId) === json) continue;
    statements.push(
      db.prepare(`INSERT INTO admin_content_cards
        (id, identity_key, expression, reading, meaning, level, part_of_speech_en, part_of_speech_jp, created_at, updated_at)
        VALUES (?, ?, '__chunk__', ?, ?, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          meaning = excluded.meaning,
          updated_at = excluded.updated_at`)
        .bind(chunkId, chunkId, String(i), json, timestamp, timestamp),
    );
  }

  for (const oldChunkId of previous.chunkJsonById.keys()) {
    if (!nextChunkIds.has(oldChunkId)) {
      statements.push(db.prepare('DELETE FROM admin_content_cards WHERE id = ?').bind(oldChunkId));
    }
  }

  return statements;
}
