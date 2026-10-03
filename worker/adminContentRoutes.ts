import { Hono, type Context } from 'hono';
import { HttpError, type Env } from './auth';
import { requireWordAdmin } from './adminAccess';
import {
  ADMIN_CONTENT_MAX_BYTES,
  ADMIN_CONTENT_MAX_FILES,
  ADMIN_CONTENT_MAX_GROUPS,
  ADMIN_CONTENT_MAX_ROWS,
  adminContentIdentity,
  adminContentText,
  buildCatalogCardWriteStatements,
  loadAdminCatalog,
  resolvePersonalContentSource,
  safeJson,
  serializeBatchStorage,
  validateAdminContentEntry,
  type AdminContentCardSource,
  type AdminContentEntry,
  type AdminContentSourceKind,
  type LoadedAdminCatalog,
  type StoredAdminCard,
} from './adminContent';
import { ADMIN_CONTENT_GROUP_SOURCE_PREFIX, createDeckSnapshot, preparePublishedDeckStatements, validatePublication, validUid } from './publishedDecks';
import { sortAdminCards, type CardSortOrder } from '../src/lib/adminWordSort';

const router = new Hono<{ Bindings: Env }>();
const nowIso = () => new Date().toISOString();
const groupSourceId = (id: string) => `${ADMIN_CONTENT_GROUP_SOURCE_PREFIX}${id}`;
const jsonResponseError = (message: string, status = 400) => new HttpError(status, message);

type GroupDbRow = { id: string; name: string; created_by: string; created_at: string; updated_at: string };
type AuditCard = { changeType: 'added' | 'updated' | 'removed' | 'deleted'; cardId?: string | null; expression: string; reading: string };

async function readJson(c: Context<{ Bindings: Env }>, limit = ADMIN_CONTENT_MAX_BYTES): Promise<Record<string, unknown>> {
  const raw = await c.req.raw.text();
  if (new TextEncoder().encode(raw).byteLength > limit) throw jsonResponseError('Request is too large.', 413);
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw jsonResponseError('Invalid JSON.'); }
}
function parseName(value: unknown, label = 'name'): string {
  try { return adminContentText(value, label, 120, true); }
  catch (err) { throw jsonResponseError(err instanceof Error ? err.message : `Invalid ${label}.`); }
}
function parseEntry(value: unknown): AdminContentEntry {
  try { return validateAdminContentEntry(value); }
  catch (err) { throw jsonResponseError(err instanceof Error ? err.message : 'Invalid card row.'); }
}
function parseEntries(value: unknown): AdminContentEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > ADMIN_CONTENT_MAX_ROWS) throw jsonResponseError(`Each batch needs 1–${ADMIN_CONTENT_MAX_ROWS} valid cards.`);
  return value.map(parseEntry);
}

function upsertCardsInMemory(
  catalog: LoadedAdminCatalog,
  nextCards: StoredAdminCard[],
  byIdentity: Map<string, StoredAdminCard>,
  entries: Array<AdminContentEntry & { sourceCardId?: string }>,
  timestamp: string,
): Array<{ cardId: string; sourceCardId: string | null; expression: string; reading: string }> {
  const result: Array<{ cardId: string; sourceCardId: string | null; expression: string; reading: string }> = [];
  for (const entry of entries) {
    const identityKey = adminContentIdentity(entry.expression, entry.reading);
    const existing = byIdentity.get(identityKey);
    if (existing) {
      const nextMeaning = entry.meaning !== undefined ? entry.meaning : existing.meaning;
      const nextLevel = entry.level !== undefined ? entry.level : existing.level;
      const nextPosEn = entry.partOfSpeechEn !== undefined ? entry.partOfSpeechEn : existing.partOfSpeechEn;
      const nextPosJp = entry.partOfSpeechJp !== undefined ? entry.partOfSpeechJp : existing.partOfSpeechJp;
      const changed = existing.expression !== entry.expression
        || existing.reading !== entry.reading
        || existing.meaning !== nextMeaning
        || existing.level !== nextLevel
        || (existing.partOfSpeechEn ?? '') !== (nextPosEn ?? '')
        || (existing.partOfSpeechJp ?? '') !== (nextPosJp ?? '');
      if (changed) {
        existing.expression = entry.expression;
        existing.reading = entry.reading;
        existing.meaning = nextMeaning;
        existing.level = nextLevel;
        if (nextPosEn) existing.partOfSpeechEn = nextPosEn;
        else delete existing.partOfSpeechEn;
        if (nextPosJp) existing.partOfSpeechJp = nextPosJp;
        else delete existing.partOfSpeechJp;
        existing.updatedAt = timestamp;
      }
      result.push({
        cardId: existing.id,
        sourceCardId: entry.sourceCardId ?? null,
        expression: existing.expression,
        reading: existing.reading,
      });
    } else {
      const created: StoredAdminCard = {
        id: `acc-${crypto.randomUUID()}`,
        identityKey,
        expression: entry.expression,
        reading: entry.reading,
        meaning: entry.meaning ?? '',
        level: entry.level ?? 'Custom',
        ...(entry.partOfSpeechEn ? { partOfSpeechEn: entry.partOfSpeechEn } : {}),
        ...(entry.partOfSpeechJp ? { partOfSpeechJp: entry.partOfSpeechJp } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      nextCards.push(created);
      byIdentity.set(identityKey, created);
      catalog.cardsById.set(created.id, created);
      result.push({
        cardId: created.id,
        sourceCardId: entry.sourceCardId ?? null,
        expression: created.expression,
        reading: created.reading,
      });
    }
  }
  return result;
}

function auditHeader(db: D1Database, event: { id: string; actorUid: string; action: string; batchId?: string | null; batchName?: string | null; groupId?: string | null; groupName?: string | null; summary: string; createdAt: string }) {
  return db.prepare(`INSERT INTO admin_content_events (id, actor_uid, action, batch_id, batch_name, group_id, group_name, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id, event.actorUid, event.action, event.batchId ?? null, event.batchName ?? null, event.groupId ?? null, event.groupName ?? null, event.summary, event.createdAt);
}

/**
 * Pack an event's card changes + counts into a SINGLE row (`position = -1`)
 * in `admin_content_event_cards` instead of inserting up to 30,000 individual
 * rows (which previously burned up to 60,000 D1 row writes per import/delete).
 */
function auditItemStatements(db: D1Database, eventId: string, items: AuditCard[]): D1PreparedStatement[] {
  if (!items.length) return [];
  let added = 0, updated = 0, removed = 0, deleted = 0;
  for (const item of items) {
    if (item.changeType === 'added') added++;
    else if (item.changeType === 'updated') updated++;
    else if (item.changeType === 'removed') removed++;
    else if (item.changeType === 'deleted') deleted++;
  }
  const countsJson = JSON.stringify({ added, updated, removed, deleted });
  const packedItemsJson = JSON.stringify(
    items.slice(0, 5000).map(item => [item.changeType, item.expression, item.reading, item.cardId ?? null]),
  );
  return [
    db.prepare(`INSERT INTO admin_content_event_cards (event_id, position, change_type, card_id, expression, reading)
      VALUES (?, -1, 'added', '__packed__', ?, ?)`).bind(eventId, countsJson, packedItemsJson),
  ];
}

async function groupExists(db: D1Database, id: string): Promise<boolean> {
  return !!await db.prepare('SELECT id FROM admin_content_groups WHERE id = ?').bind(id).first();
}
function parseOptionalGroupId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  try { return adminContentText(value, 'group ID', 200, true); }
  catch (err) { throw jsonResponseError(err instanceof Error ? err.message : 'Invalid group ID.'); }
}
function validUidInput(value: unknown): string {
  if (!validUid(value)) throw jsonResponseError('Invalid Firebase UID.');
  return value;
}
function sourceKindInput(value: unknown): AdminContentSourceKind {
  if (value !== 'my_words' && value !== 'list' && value !== 'group') throw jsonResponseError('Choose My words, a personal save slot, or a personal group.');
  return value;
}
function serializeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ADMIN_CONTENT_MAX_ROWS || value.some(id => typeof id !== 'string' || !id || id.length > 200)) throw jsonResponseError('Invalid personal card selection.');
  return [...new Set(value as string[])];
}
function canonicalGroupName(value: unknown): string {
  return parseName(value, 'group name');
}

router.get('/api/admin/content', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const [groupResult, catalog] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, created_by, created_at, updated_at FROM admin_content_groups ORDER BY lower(name), id').all<GroupDbRow>(),
    loadAdminCatalog(c.env.DB),
  ]);
  const groupNameById = new Map(groupResult.results.map(g => [g.id, g.name]));
  const batchesByGroup = new Map<string, number>();
  const cardsByGroup = new Map<string, Set<string>>();

  for (const batch of catalog.batches) {
    if (!batch.group_id) continue;
    batchesByGroup.set(batch.group_id, (batchesByGroup.get(batch.group_id) ?? 0) + 1);
    let set = cardsByGroup.get(batch.group_id);
    if (!set) { set = new Set(); cardsByGroup.set(batch.group_id, set); }
    for (const link of batch.links) set.add(link.cardId);
  }

  const groups = groupResult.results.map(row => ({
    id: row.id,
    name: row.name,
    batchCount: batchesByGroup.get(row.id) ?? 0,
    cardCount: cardsByGroup.get(row.id)?.size ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const batches = catalog.batches.map(row => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    groupId: row.group_id,
    groupName: row.group_id ? (groupNameById.get(row.group_id) ?? null) : null,
    cardCount: row.links.length,
    sourceUid: row.source_uid,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceAll: row.source_all === 1,
    selectedSourceIds: row.selectedSourceIds,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return c.json({
    groups,
    batches,
    limits: { groups: ADMIN_CONTENT_MAX_GROUPS, filesPerUpload: ADMIN_CONTENT_MAX_FILES, rowsPerUpload: ADMIN_CONTENT_MAX_ROWS },
  });
});

router.get('/api/admin/content/cards', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.query('batchId') ?? null;
  const groupId = c.req.query('groupId') ?? null;
  if (batchId && groupId) throw jsonResponseError('Choose one card filter at a time.');
  const offset = Number(c.req.query('offset') ?? '0');
  if (!Number.isSafeInteger(offset) || offset < 0) throw jsonResponseError('Card offset must be a non-negative integer.');
  const requestedSort = c.req.query('sortOrder') ?? 'asc';
  if (requestedSort !== 'asc' && requestedSort !== 'desc') throw jsonResponseError('Sort order must be asc or desc.');
  const sortOrder = requestedSort as CardSortOrder;

  const [catalog, groupCheck] = await Promise.all([
    loadAdminCatalog(c.env.DB),
    groupId ? groupExists(c.env.DB, groupId) : Promise.resolve(true),
  ]);
  if (batchId && !catalog.batchesById.has(batchId)) throw jsonResponseError('Batch not found.', 404);
  if (groupId && !groupCheck) throw jsonResponseError('Group not found.', 404);

  const batchIdsByCard = new Map<string, string[]>();
  const groupIdsByCard = new Map<string, Set<string>>();
  for (const batch of catalog.batches) {
    for (const link of batch.links) {
      let bList = batchIdsByCard.get(link.cardId);
      if (!bList) { bList = []; batchIdsByCard.set(link.cardId, bList); }
      bList.push(batch.id);
      if (batch.group_id) {
        let gSet = groupIdsByCard.get(link.cardId);
        if (!gSet) { gSet = new Set(); groupIdsByCard.set(link.cardId, gSet); }
        gSet.add(batch.group_id);
      }
    }
  }

  let matchingCards: StoredAdminCard[];
  if (batchId) {
    const targetBatch = catalog.batchesById.get(batchId)!;
    const allowed = new Set(targetBatch.links.map(l => l.cardId));
    matchingCards = catalog.cards.filter(card => allowed.has(card.id));
  } else if (groupId) {
    matchingCards = catalog.cards.filter(card => groupIdsByCard.get(card.id)?.has(groupId));
  } else {
    matchingCards = catalog.cards;
  }

  const orderedCards = sortAdminCards(matchingCards, sortOrder);
  const pageSlice = orderedCards.slice(offset, offset + 5000);
  const cards = pageSlice.map(card => {
    const batchIds = batchIdsByCard.get(card.id) ?? [];
    const groupIds = [...(groupIdsByCard.get(card.id) ?? [])];
    return {
      id: card.id,
      expression: card.expression,
      reading: card.reading,
      meaning: card.meaning ?? '',
      level: card.level ?? 'Custom',
      partOfSpeechEn: card.partOfSpeechEn ?? undefined,
      partOfSpeechJp: card.partOfSpeechJp ?? undefined,
      batchCount: batchIds.length,
      batchIds,
      groupIds,
    };
  });

  return c.json({
    cards,
    total: orderedCards.length,
    offset,
    hasMore: offset + pageSlice.length < orderedCards.length,
  });
});

router.get('/api/admin/content/events', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 30) || 30));
  const result = await c.env.DB.prepare(`SELECT e.id, e.actor_uid, e.action, e.batch_id, e.batch_name, e.group_id, e.group_name, e.summary, e.created_at,
      CASE WHEN packed.card_id = '__packed__' THEN COALESCE(CAST(json_extract(packed.expression, '$.added') AS INTEGER), 0)
           ELSE (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.position >= 0 AND ec.change_type='added') END AS added_count,
      CASE WHEN packed.card_id = '__packed__' THEN COALESCE(CAST(json_extract(packed.expression, '$.updated') AS INTEGER), 0)
           ELSE (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.position >= 0 AND ec.change_type='updated') END AS updated_count,
      CASE WHEN packed.card_id = '__packed__' THEN COALESCE(CAST(json_extract(packed.expression, '$.removed') AS INTEGER), 0)
           ELSE (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.position >= 0 AND ec.change_type='removed') END AS removed_count,
      CASE WHEN packed.card_id = '__packed__' THEN COALESCE(CAST(json_extract(packed.expression, '$.deleted') AS INTEGER), 0)
           ELSE (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.position >= 0 AND ec.change_type='deleted') END AS deleted_count
    FROM admin_content_events e
    LEFT JOIN admin_content_event_cards packed ON packed.event_id = e.id AND packed.position = -1
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  return c.json({ events: result.results });
});

router.get('/api/admin/content/events/:id', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const event = await c.env.DB.prepare('SELECT * FROM admin_content_events WHERE id = ?').bind(c.req.param('id')).first();
  if (!event) throw jsonResponseError('History entry not found.', 404);
  const rows = await c.env.DB.prepare(
    'SELECT position, change_type, card_id, expression, reading FROM admin_content_event_cards WHERE event_id = ? ORDER BY position LIMIT 5000',
  ).bind(c.req.param('id')).all<{ position: number; change_type: string; card_id: string | null; expression: string; reading: string }>();
  let cards = rows.results;
  if (cards.length >= 1 && cards[0].position === -1 && cards[0].card_id === '__packed__') {
    const raw = safeJson(cards[0].reading);
    cards = Array.isArray(raw) ? raw.map((tuple, index) => {
      const [change_type, expression, reading, card_id] = Array.isArray(tuple) ? tuple : [];
      return {
        position: index,
        change_type: String(change_type ?? 'added'),
        card_id: typeof card_id === 'string' ? card_id : null,
        expression: String(expression ?? ''),
        reading: String(reading ?? ''),
      };
    }) : [];
  }
  return c.json({ event, cards });
});

router.post('/api/admin/content/groups', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c, 16_384);
  const name = canonicalGroupName(body.name);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM admin_content_groups').first<{ count: number }>();
  if ((count?.count ?? 0) >= ADMIN_CONTENT_MAX_GROUPS) throw jsonResponseError(`A maximum of ${ADMIN_CONTENT_MAX_GROUPS} content groups is allowed.`, 409);
  if (await c.env.DB.prepare('SELECT id FROM admin_content_groups WHERE lower(name)=lower(?)').bind(name).first()) throw jsonResponseError('A content group with this name already exists.', 409);
  const id = `acg-${crypto.randomUUID()}`, timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO admin_content_groups (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, actor, timestamp, timestamp),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'group_created', groupId: id, groupName: name, summary: `Created content group “${name}”.`, createdAt: timestamp }),
  ]);
  return c.json({ id, name, createdAt: timestamp }, 201);
});

router.patch('/api/admin/content/groups/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const id = c.req.param('id'), body = await readJson(c, 16_384), name = canonicalGroupName(body.name);
  const current = await c.env.DB.prepare('SELECT name FROM admin_content_groups WHERE id=?').bind(id).first<{ name: string }>();
  if (!current) throw jsonResponseError('Content group not found.', 404);
  if (await c.env.DB.prepare('SELECT id FROM admin_content_groups WHERE lower(name)=lower(?) AND id<>?').bind(name, id).first()) throw jsonResponseError('A content group with this name already exists.', 409);
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE admin_content_groups SET name=?, updated_at=? WHERE id=?').bind(name, timestamp, id),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'group_renamed', groupId: id, groupName: name, summary: `Renamed content group “${current.name}” to “${name}”.`, createdAt: timestamp }),
  ]);
  return c.json({ ok: true, id, name });
});

router.delete('/api/admin/content/groups/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const id = c.req.param('id');
  const group = await c.env.DB.prepare('SELECT name FROM admin_content_groups WHERE id=?').bind(id).first<{ name: string }>();
  if (!group) throw jsonResponseError('Content group not found.', 404);
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  await c.env.DB.batch([
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'group_deleted', groupId: id, groupName: group.name, summary: `Deleted group “${group.name}”; its file batches and cards were kept ungrouped.`, createdAt: timestamp }),
    c.env.DB.prepare('UPDATE admin_content_batches SET group_id=NULL, updated_at=? WHERE group_id=?').bind(timestamp, id),
    c.env.DB.prepare('DELETE FROM admin_content_groups WHERE id=?').bind(id),
  ]);
  return c.json({ ok: true });
});

router.post('/api/admin/content/batches/bulk-group', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c, 512_000);
  if (!Object.prototype.hasOwnProperty.call(body, 'groupId')) throw jsonResponseError('Choose a group or Ungrouped.');
  if (!Array.isArray(body.batchIds) || !body.batchIds.length || body.batchIds.length > 5000
    || body.batchIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    throw jsonResponseError('Select between 1 and 5,000 batches.');
  }
  const batchIds = [...new Set(body.batchIds as string[])];
  const groupId = parseOptionalGroupId(body.groupId);
  const group = groupId
    ? await c.env.DB.prepare('SELECT name FROM admin_content_groups WHERE id=?').bind(groupId).first<{ name: string }>()
    : null;
  if (groupId && !group) throw jsonResponseError('Content group not found.', 404);

  const encodedIds = JSON.stringify(batchIds);
  const selected = await c.env.DB.prepare(`SELECT id, group_id FROM admin_content_batches
    WHERE id IN (SELECT value FROM json_each(?))`).bind(encodedIds).all<{ id: string; group_id: string | null }>();
  if (selected.results.length !== batchIds.length) throw jsonResponseError('One or more selected batches were not found.', 404);
  const changedIds = selected.results.filter(batch => batch.group_id !== groupId).map(batch => batch.id);
  if (!changedIds.length) return c.json({ ok: true, updated: 0 });

  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  const action = groupId ? 'batches_grouped' : 'batches_ungrouped';
  const summary = groupId
    ? `Assigned ${changedIds.length} batch(es) to group “${group!.name}”.`
    : `Removed ${changedIds.length} batch(es) from their groups.`;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE admin_content_batches SET group_id=?, updated_at=?
      WHERE id IN (SELECT value FROM json_each(?))`).bind(groupId, timestamp, JSON.stringify(changedIds)),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action, groupId, groupName: group?.name ?? null, summary, createdAt: timestamp }),
  ]);
  return c.json({ ok: true, updated: changedIds.length, eventId });
});

router.patch('/api/admin/content/batches/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const id = c.req.param('id'), body = await readJson(c, 16_384);
  const current = await c.env.DB.prepare('SELECT name, group_id FROM admin_content_batches WHERE id=?').bind(id).first<{ name: string; group_id: string | null }>();
  if (!current) throw jsonResponseError('Batch not found.', 404);
  const name = body.name === undefined ? current.name : parseName(body.name, 'batch name');
  const groupId = body.groupId === undefined ? current.group_id : parseOptionalGroupId(body.groupId);
  if (groupId && !await groupExists(c.env.DB, groupId)) throw jsonResponseError('Content group not found.', 404);
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  const changedGroup = groupId !== current.group_id;
  const changedName = name !== current.name;
  if (!changedGroup && !changedName) return c.json({ ok: true });
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE admin_content_batches SET name=?, group_id=?, updated_at=? WHERE id=?').bind(name, groupId, timestamp, id),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'batch_updated', batchId: id, batchName: name, groupId, summary: `Updated batch “${name}”${changedGroup ? (groupId ? ' and assigned it to a group.' : ' and removed it from its group.') : '.'}`, createdAt: timestamp }),
  ]);
  return c.json({ ok: true });
});

router.post('/api/admin/content/import-csv', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c);
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > ADMIN_CONTENT_MAX_FILES) throw jsonResponseError(`Choose 1–${ADMIN_CONTENT_MAX_FILES} CSV files per upload.`);
  const groupId = parseOptionalGroupId(body.groupId);
  if (groupId && !await groupExists(c.env.DB, groupId)) throw jsonResponseError('Content group not found.', 404);
  let totalRows = 0;
  const files = (body.files as unknown[]).map((rawFile, fileIndex) => {
    if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) throw jsonResponseError('Invalid uploaded file entry.');
    const file = rawFile as Record<string, unknown>;
    const name = parseName(file.name, 'CSV file name');
    const entries = parseEntries(file.rows);
    totalRows += entries.length;
    if (totalRows > ADMIN_CONTENT_MAX_ROWS) throw jsonResponseError(`A multi-file upload may contain at most ${ADMIN_CONTENT_MAX_ROWS} cards in total.`);
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = adminContentIdentity(entry.expression, entry.reading);
      if (seen.has(key)) throw jsonResponseError(`Duplicate expression/reading within “${name}”. Remove duplicate rows first.`);
      seen.add(key);
    }
    return { name, entries, fileIndex, batchId: `acb-${crypto.randomUUID()}`, eventId: `ace-${crypto.randomUUID()}` };
  });

  const catalog = await loadAdminCatalog(c.env.DB);
  const nextCards = catalog.cards.map(card => ({ ...card }));
  const byIdentity = new Map(nextCards.map(card => [card.identityKey, card]));
  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [];

  for (const file of files) {
    const resolved = upsertCardsInMemory(catalog, nextCards, byIdentity, file.entries, timestamp);
    const batchStorage = serializeBatchStorage([], resolved);
    statements.push(
      c.env.DB.prepare(`INSERT INTO admin_content_batches
        (id,name,kind,group_id,source_uid,source_kind,source_id,source_all,selected_source_ids,source_version,created_by,created_at,updated_at)
        VALUES (?,?,'csv',?,NULL,NULL,NULL,0,?,NULL,?,?,?)`)
        .bind(file.batchId, file.name, groupId, batchStorage, actor, timestamp, timestamp),
    );
    statements.push(
      auditHeader(c.env.DB, {
        id: file.eventId,
        actorUid: actor,
        action: 'csv_import',
        batchId: file.batchId,
        batchName: file.name,
        groupId,
        summary: `Uploaded “${file.name}” as a separate batch with ${file.entries.length} cards.`,
        createdAt: timestamp,
      }),
    );
    statements.push(
      ...auditItemStatements(
        c.env.DB,
        file.eventId,
        resolved.map(row => ({ changeType: 'added' as const, cardId: row.cardId, expression: row.expression, reading: row.reading })),
      ),
    );
  }

  statements.unshift(...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp));
  await c.env.DB.batch(statements);
  return c.json({ ok: true, groupId, batches: files.map(file => ({ id: file.batchId, name: file.name, cardCount: file.entries.length, eventId: file.eventId })) }, 201);
});

router.post('/api/admin/content/personal-copy', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c);
  const sourceUid = validUidInput(body.sourceUid);
  const sourceKind = sourceKindInput(body.sourceKind);
  let sourceId: string | null = null;
  if (sourceKind !== 'my_words') {
    try { sourceId = adminContentText(body.sourceId, 'personal source ID', 200, true); }
    catch (err) { throw jsonResponseError(err instanceof Error ? err.message : 'Invalid personal source ID.'); }
  }
  const sourceAll = body.sourceAll === true;
  const selectedSourceIds = serializeSourceIds(body.selectedSourceIds ?? []);
  if (!sourceAll && !selectedSourceIds.length) throw jsonResponseError('Select at least one personal card to copy.');
  const name = parseName(body.name, 'batch name');
  const groupId = parseOptionalGroupId(body.groupId);
  if (groupId && !await groupExists(c.env.DB, groupId)) throw jsonResponseError('Content group not found.', 404);
  const [source, catalog] = await Promise.all([
    resolvePersonalContentSource(c.env.DB, sourceUid, sourceKind, sourceId, sourceAll, selectedSourceIds),
    loadAdminCatalog(c.env.DB),
  ]);
  if (!source) throw jsonResponseError('No saved account data was found for this Firebase UID.', 404);
  if (!source.sourceName) throw jsonResponseError('The selected personal save slot or group no longer exists.', 404);
  if (!source.cards.length || source.cards.length > ADMIN_CONTENT_MAX_ROWS) throw jsonResponseError(`The selected source must contain 1–${ADMIN_CONTENT_MAX_ROWS} cards.`);

  const nextCards = catalog.cards.map(card => ({ ...card }));
  const byIdentity = new Map(nextCards.map(card => [card.identityKey, card]));
  const batchId = `acb-${crypto.randomUUID()}`, eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const resolved = upsertCardsInMemory(
    catalog,
    nextCards,
    byIdentity,
    source.cards.map(card => ({ ...card, sourceCardId: card.id })),
    timestamp,
  );
  const batchStorage = serializeBatchStorage(sourceAll ? [] : selectedSourceIds, resolved);
  const statements: D1PreparedStatement[] = [
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp),
    c.env.DB.prepare(`INSERT INTO admin_content_batches
      (id,name,kind,group_id,source_uid,source_kind,source_id,source_all,selected_source_ids,source_version,created_by,created_at,updated_at)
      VALUES (?,?,'personal',?,?,?,?,?,?,?,?,?,?)`)
      .bind(batchId, name, groupId, sourceUid, sourceKind, sourceId, sourceAll ? 1 : 0, batchStorage, source.version, actor, timestamp, timestamp),
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'personal_copy',
      batchId,
      batchName: name,
      groupId,
      summary: `Copied ${resolved.length} cards from ${source.sourceName} (${sourceUid}) into “${name}”.`,
      createdAt: timestamp,
    }),
    ...auditItemStatements(
      c.env.DB,
      eventId,
      resolved.map(row => ({ changeType: 'added' as const, cardId: row.cardId, expression: row.expression, reading: row.reading })),
    ),
  ];
  await c.env.DB.batch(statements);
  return c.json({ ok: true, batch: { id: batchId, name, kind: 'personal', groupId, cardCount: resolved.length }, eventId }, 201);
});

router.post('/api/admin/content/batches/:id/sync', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id');
  const catalog = await loadAdminCatalog(c.env.DB);
  const batch = catalog.batchesById.get(batchId);
  if (!batch) throw jsonResponseError('Batch not found.', 404);
  if (batch.kind !== 'personal' || !batch.source_uid || !batch.source_kind) throw jsonResponseError('Only personal-source batches can be synchronized.');
  const sourceKind = sourceKindInput(batch.source_kind);
  const selectedSourceIds = serializeSourceIds(batch.selectedSourceIds);
  const source = await resolvePersonalContentSource(c.env.DB, batch.source_uid, sourceKind, batch.source_id, batch.source_all === 1, selectedSourceIds)
    ?? { version: batch.source_version ?? 0, sourceName: '', cards: [] as AdminContentCardSource[] };

  const oldBySource = new Map<string, StoredAdminCard>();
  for (const link of batch.links) {
    if (!link.sourceCardId) continue;
    const card = catalog.cardsById.get(link.cardId);
    if (card) oldBySource.set(link.sourceCardId, card);
  }

  const uniqueByIdentity = new Map<string, AdminContentCardSource>();
  for (const card of source.cards) {
    const key = adminContentIdentity(card.expression, card.reading);
    if (!uniqueByIdentity.has(key)) uniqueByIdentity.set(key, card);
  }
  const currentCards = [...uniqueByIdentity.values()];
  const currentBySource = new Map(currentCards.map(card => [card.id, card]));
  const eventItems: AuditCard[] = [];
  let added = 0, updated = 0, removed = 0;

  for (const card of currentCards) {
    const old = oldBySource.get(card.id);
    if (!old) {
      added++;
      eventItems.push({ changeType: 'added', expression: card.expression, reading: card.reading });
      continue;
    }
    const same = old.expression === card.expression
      && old.reading === card.reading
      && (old.meaning ?? '') === card.meaning
      && (old.level ?? 'Custom') === card.level
      && (old.partOfSpeechEn ?? '') === (card.partOfSpeechEn ?? '')
      && (old.partOfSpeechJp ?? '') === (card.partOfSpeechJp ?? '');
    if (!same) {
      updated++;
      eventItems.push({ changeType: 'updated', cardId: old.id, expression: card.expression, reading: card.reading });
    }
  }
  for (const [sourceCardId, old] of oldBySource) {
    if (!currentBySource.has(sourceCardId)) {
      removed++;
      eventItems.push({ changeType: 'removed', cardId: old.id, expression: old.expression, reading: old.reading });
    }
  }

  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  const nextCards = catalog.cards.map(card => ({ ...card }));
  const byIdentity = new Map(nextCards.map(card => [card.identityKey, card]));
  const resolved = upsertCardsInMemory(
    catalog,
    nextCards,
    byIdentity,
    currentCards.map(card => ({ ...card, sourceCardId: card.id })),
    timestamp,
  );
  // Keep any non-source-linked cards that were in the batch.
  const nonSourceLinks = batch.links.filter(link => !link.sourceCardId).map(link => ({ cardId: link.cardId, sourceCardId: null }));
  const nextBatchStorage = serializeBatchStorage(batch.selectedSourceIds, [...nonSourceLinks, ...resolved]);

  const summary = `Synchronized “${batch.name}”: ${added} added, ${updated} updated, ${removed} removed from this batch.${source.sourceName ? '' : ' The personal source account or collection no longer exists.'}`;
  const statements: D1PreparedStatement[] = [
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp, new Set([batchId])),
    c.env.DB.prepare('UPDATE admin_content_batches SET selected_source_ids=?, source_version=?, updated_at=? WHERE id=?')
      .bind(nextBatchStorage, source.version, timestamp, batchId),
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'personal_sync',
      batchId,
      batchName: batch.name,
      groupId: batch.group_id,
      summary,
      createdAt: timestamp,
    }),
    ...auditItemStatements(c.env.DB, eventId, eventItems),
  ];
  await c.env.DB.batch(statements);
  return c.json({ ok: true, batchId, eventId, added, updated, removed, sourceMissing: !source.sourceName });
});

router.delete('/api/admin/content/batches/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id');
  const catalog = await loadAdminCatalog(c.env.DB);
  const batch = catalog.batchesById.get(batchId);
  if (!batch) throw jsonResponseError('Batch not found.', 404);

  const deletedCardIds = new Set(batch.links.map(link => link.cardId));
  const items: AuditCard[] = [];
  for (const link of batch.links) {
    const card = catalog.cardsById.get(link.cardId);
    if (card) items.push({ changeType: 'deleted', cardId: card.id, expression: card.expression, reading: card.reading });
  }

  const nextCards = catalog.cards.filter(card => !deletedCardIds.has(card.id));
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const skipLegacy = new Set<string>([batchId]);
  const otherBatchUpdates: D1PreparedStatement[] = [];

  for (const other of catalog.batches) {
    if (other.id === batchId) continue;
    if (other.links.some(link => deletedCardIds.has(link.cardId))) {
      skipLegacy.add(other.id);
      const filteredLinks = other.links.filter(link => !deletedCardIds.has(link.cardId));
      otherBatchUpdates.push(
        c.env.DB.prepare('UPDATE admin_content_batches SET selected_source_ids = ? WHERE id = ?')
          .bind(serializeBatchStorage(other.selectedSourceIds, filteredLinks), other.id),
      );
    }
  }

  const statements: D1PreparedStatement[] = [
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'batch_deleted',
      batchId,
      batchName: batch.name,
      groupId: batch.group_id,
      summary: `Deleted batch “${batch.name}” and all ${items.length} cards from the admin catalog, including cards shared with other batches. Personal accounts and published snapshots were not changed.`,
      createdAt: timestamp,
    }),
    ...auditItemStatements(c.env.DB, eventId, items),
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp, skipLegacy),
    ...otherBatchUpdates,
    c.env.DB.prepare('DELETE FROM admin_content_batches WHERE id=?').bind(batchId),
  ];
  await c.env.DB.batch(statements);
  return c.json({ ok: true, eventId, deleted: items.length });
});

router.post('/api/admin/content/batches/bulk-delete', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c, 512_000);
  if (!Array.isArray(body.batchIds) || !body.batchIds.length || body.batchIds.length > 5000
    || body.batchIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    throw jsonResponseError('Select between 1 and 5,000 batches to delete.');
  }
  const batchIds = [...new Set(body.batchIds as string[])];
  const deleteBatchSet = new Set(batchIds);
  const catalog = await loadAdminCatalog(c.env.DB);

  const targetBatches = batchIds.map(id => catalog.batchesById.get(id));
  if (targetBatches.some(batch => !batch)) {
    throw jsonResponseError('One or more selected batches were not found. Reload and try again.', 404);
  }
  const validBatches = targetBatches as NonNullable<(typeof targetBatches)[number]>[];

  const deletedCardIds = new Set<string>();
  const items: AuditCard[] = [];
  for (const batch of validBatches) {
    for (const link of batch.links) {
      if (deletedCardIds.has(link.cardId)) continue;
      deletedCardIds.add(link.cardId);
      const card = catalog.cardsById.get(link.cardId);
      if (card) items.push({ changeType: 'deleted', cardId: card.id, expression: card.expression, reading: card.reading });
    }
  }

  const nextCards = catalog.cards.filter(card => !deletedCardIds.has(card.id));
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const skipLegacy = new Set<string>(batchIds);
  const otherBatchUpdates: D1PreparedStatement[] = [];

  for (const other of catalog.batches) {
    if (deleteBatchSet.has(other.id)) continue;
    if (other.links.some(link => deletedCardIds.has(link.cardId))) {
      skipLegacy.add(other.id);
      const filteredLinks = other.links.filter(link => !deletedCardIds.has(link.cardId));
      otherBatchUpdates.push(
        c.env.DB.prepare('UPDATE admin_content_batches SET selected_source_ids = ? WHERE id = ?')
          .bind(serializeBatchStorage(other.selectedSourceIds, filteredLinks), other.id),
      );
    }
  }

  const previewNames = validBatches.slice(0, 3).map(b => `“${b.name}”`).join(', ');
  const summary = `Deleted ${validBatches.length} batch(es)${previewNames ? ` (${previewNames}${validBatches.length > 3 ? ', …' : ''})` : ''} and ${items.length} card(s) from the admin catalog, including cards shared with other batches. Personal accounts and published snapshots were not changed.`;

  const statements: D1PreparedStatement[] = [
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'batches_deleted',
      batchId: validBatches.length === 1 ? validBatches[0].id : null,
      batchName: validBatches.length === 1 ? validBatches[0].name : null,
      summary,
      createdAt: timestamp,
    }),
    ...auditItemStatements(c.env.DB, eventId, items),
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp, skipLegacy),
    ...otherBatchUpdates,
    c.env.DB.prepare('DELETE FROM admin_content_batches WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(batchIds)),
  ];
  await c.env.DB.batch(statements);
  return c.json({ ok: true, eventId, deletedBatches: validBatches.length, deletedCards: items.length });
});

router.post('/api/admin/content/batches/:id/remove-cards', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id'), body = await readJson(c, 256_000);
  if (!Array.isArray(body.cardIds) || !body.cardIds.length || body.cardIds.length > ADMIN_CONTENT_MAX_ROWS || body.cardIds.some(id => typeof id !== 'string')) throw jsonResponseError('Select cards from this batch first.');
  const ids = [...new Set(body.cardIds as string[])];
  const removeSet = new Set(ids);

  const catalog = await loadAdminCatalog(c.env.DB);
  const batch = catalog.batchesById.get(batchId);
  if (!batch) throw jsonResponseError('Batch not found.', 404);

  const presentIds = new Set(batch.links.map(link => link.cardId));
  if (ids.some(id => !presentIds.has(id))) {
    throw jsonResponseError('Some selected cards are no longer in this batch. Reload the batch first.', 409);
  }

  const items: AuditCard[] = [];
  for (const id of ids) {
    const card = catalog.cardsById.get(id);
    if (card) items.push({ changeType: 'removed', cardId: card.id, expression: card.expression, reading: card.reading });
  }
  const remainingLinks = batch.links.filter(link => !removeSet.has(link.cardId));
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const statements: D1PreparedStatement[] = [
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'cards_removed_from_batch',
      batchId,
      batchName: batch.name,
      groupId: batch.group_id,
      summary: `Removed ${items.length} cards from batch “${batch.name}”; catalog cards were kept.`,
      createdAt: timestamp,
    }),
    ...auditItemStatements(c.env.DB, eventId, items),
    c.env.DB.prepare('UPDATE admin_content_batches SET selected_source_ids = ?, updated_at = ? WHERE id = ?')
      .bind(serializeBatchStorage(batch.selectedSourceIds, remainingLinks), timestamp, batchId),
  ];
  if (batch.isLegacy) {
    statements.push(
      c.env.DB.prepare('DELETE FROM admin_content_batch_cards WHERE batch_id = ?').bind(batchId),
    );
  }
  await c.env.DB.batch(statements);
  return c.json({ ok: true, eventId, removed: items.length });
});

router.post('/api/admin/content/cards/delete', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c, 256_000);
  if (!Array.isArray(body.cardIds) || !body.cardIds.length || body.cardIds.length > ADMIN_CONTENT_MAX_ROWS || body.cardIds.some(id => typeof id !== 'string' || !id)) {
    throw jsonResponseError('Select admin catalog cards to delete first.');
  }
  const ids = [...new Set(body.cardIds as string[])];
  const deleteSet = new Set(ids);
  const catalog = await loadAdminCatalog(c.env.DB);

  const foundCards: StoredAdminCard[] = [];
  for (const id of ids) {
    const card = catalog.cardsById.get(id);
    if (!card) throw jsonResponseError('Some selected cards are no longer in the admin catalog. Reload the card list first.', 409);
    foundCards.push(card);
  }
  foundCards.sort((a, b) =>
    a.expression.localeCompare(b.expression, undefined, { sensitivity: 'base' })
    || a.reading.localeCompare(b.reading, undefined, { sensitivity: 'base' }));

  let removedReferences = 0;
  const skipLegacy = new Set<string>();
  const batchUpdates: D1PreparedStatement[] = [];
  for (const batch of catalog.batches) {
    const matchingCount = batch.links.filter(link => deleteSet.has(link.cardId)).length;
    if (matchingCount > 0) {
      removedReferences += matchingCount;
      skipLegacy.add(batch.id);
      const remaining = batch.links.filter(link => !deleteSet.has(link.cardId));
      batchUpdates.push(
        c.env.DB.prepare('UPDATE admin_content_batches SET selected_source_ids = ? WHERE id = ?')
          .bind(serializeBatchStorage(batch.selectedSourceIds, remaining), batch.id),
      );
    }
  }

  const nextCards = catalog.cards.filter(card => !deleteSet.has(card.id));
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const items: AuditCard[] = foundCards.map(card => ({
    changeType: 'deleted',
    cardId: card.id,
    expression: card.expression,
    reading: card.reading,
  }));

  await c.env.DB.batch([
    auditHeader(c.env.DB, {
      id: eventId,
      actorUid: actor,
      action: 'cards_deleted',
      summary: `Deleted ${items.length} selected card(s) from the admin catalog and removed ${removedReferences} batch reference(s). Personal source accounts and published snapshots were not changed.`,
      createdAt: timestamp,
    }),
    ...auditItemStatements(c.env.DB, eventId, items),
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp, skipLegacy),
    ...batchUpdates,
  ]);
  return c.json({ ok: true, eventId, deleted: items.length, removedReferences });
});

router.patch('/api/admin/content/cards/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const id = c.req.param('id'), body = await readJson(c, 16_384);
  const catalog = await loadAdminCatalog(c.env.DB);
  const current = catalog.cardsById.get(id);
  if (!current) throw jsonResponseError('Admin content card not found.', 404);
  const entry = parseEntry({
    expression: body.expression ?? current.expression,
    reading: body.reading ?? current.reading,
    meaning: body.meaning ?? current.meaning ?? '',
    level: body.level ?? current.level ?? 'Custom',
    partOfSpeechEn: body.partOfSpeechEn ?? current.partOfSpeechEn ?? undefined,
    partOfSpeechJp: body.partOfSpeechJp ?? current.partOfSpeechJp ?? undefined,
  });
  const identityKey = adminContentIdentity(entry.expression, entry.reading);
  const duplicate = catalog.cardsByIdentity.get(identityKey);
  if (duplicate && duplicate.id !== id) {
    throw jsonResponseError('Another admin card already has this exact expression and reading. Remove the duplicate from this batch instead.', 409);
  }
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  const nextCards = catalog.cards.map(card => {
    if (card.id !== id) return card;
    const updated: StoredAdminCard = {
      ...card,
      identityKey,
      expression: entry.expression,
      reading: entry.reading,
      meaning: entry.meaning ?? '',
      level: entry.level ?? 'Custom',
      updatedAt: timestamp,
    };
    if (entry.partOfSpeechEn) updated.partOfSpeechEn = entry.partOfSpeechEn;
    else delete updated.partOfSpeechEn;
    if (entry.partOfSpeechJp) updated.partOfSpeechJp = entry.partOfSpeechJp;
    else delete updated.partOfSpeechJp;
    return updated;
  });

  await c.env.DB.batch([
    ...buildCatalogCardWriteStatements(c.env.DB, catalog, nextCards, timestamp),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'card_updated', summary: `Updated admin card “${entry.expression} / ${entry.reading}”.`, createdAt: timestamp }),
    ...auditItemStatements(c.env.DB, eventId, [{ changeType: 'updated', cardId: id, expression: entry.expression, reading: entry.reading }]),
  ]);
  return c.json({ ok: true });
});

router.post('/api/admin/content/groups/:id/publish', async c => {
  const adminUid = await requireWordAdmin(c.req.raw, c.env);
  const groupId = c.req.param('id');
  if (!await groupExists(c.env.DB, groupId)) throw jsonResponseError('Content group not found.', 404);
  const audience = validatePublication(await readJson(c, 16_384));
  const sourceId = groupSourceId(groupId);
  if (await c.env.DB.prepare('SELECT id FROM published_decks WHERE source_uid = ? AND source_list_id = ?').bind(adminUid, sourceId).first()) {
    throw jsonResponseError('This admin content group is already published. Edit its audience instead.', 409);
  }
  const snapshot = await createDeckSnapshot(c.env.DB, adminUid, sourceId);
  if (!snapshot || !snapshot.cards.length) throw jsonResponseError('This group has no cards to publish.', 400);
  const id = crypto.randomUUID(), timestamp = nowIso();
  const statements = preparePublishedDeckStatements(c.env.DB, {
    id,
    sourceUid: adminUid,
    sourceListId: sourceId,
    visibility: audience.visibility,
    recipientUids: audience.recipientUids,
    createdBy: adminUid,
    timestamp,
  }, snapshot);
  const results = await c.env.DB.batch(statements);
  if (results[0]?.meta.changes !== 1) throw jsonResponseError('This admin content group is already published. Edit its audience instead.', 409);
  return c.json({ id, ok: true }, 201);
});

export default router;
