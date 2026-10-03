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
  resolvePersonalContentSource,
  safeJson,
  validateAdminContentEntry,
  type AdminContentCardSource,
  type AdminContentEntry,
  type AdminContentSourceKind,
} from './adminContent';
import { ADMIN_CONTENT_GROUP_SOURCE_PREFIX, createDeckSnapshot, serializeDeckSnapshot, validatePublication, validUid } from './publishedDecks';

const router = new Hono<{ Bindings: Env }>();
const nowIso = () => new Date().toISOString();
const groupSourceId = (id: string) => `${ADMIN_CONTENT_GROUP_SOURCE_PREFIX}${id}`;
const jsonResponseError = (message: string, status = 400) => new HttpError(status, message);

type GroupRow = { id: string; name: string; created_by: string; created_at: string; updated_at: string; batch_count: number; card_count: number };
type BatchRow = {
  id: string; name: string; kind: 'csv' | 'personal'; group_id: string | null; source_uid: string | null;
  source_kind: string | null; source_id: string | null; source_all: number; selected_source_ids: string;
  source_version: number | null; created_by: string; created_at: string; updated_at: string;
  group_name: string | null; card_count: number;
};
type CardRow = {
  id: string; expression: string; reading: string; meaning: string | null; level: string | null;
  part_of_speech_en: string | null; part_of_speech_jp: string | null; created_at: string; updated_at: string;
  batch_ids: string | null; group_ids: string | null;
};
type SourceBatchRow = Pick<BatchRow, 'id' | 'name' | 'kind' | 'group_id' | 'source_uid' | 'source_kind' | 'source_id' | 'source_all' | 'selected_source_ids' | 'source_version'>;
type ExistingBatchCard = { source_card_id: string | null; id: string; expression: string; reading: string; meaning: string | null; level: string | null; part_of_speech_en: string | null; part_of_speech_jp: string | null };
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
function entryRows(entries: Array<AdminContentEntry & { sourceCardId?: string }>) {
  return entries.map((entry, position) => ({
    cardId: `acc-${crypto.randomUUID()}`,
    identityKey: adminContentIdentity(entry.expression, entry.reading),
    expression: entry.expression,
    reading: entry.reading,
    meaning: entry.meaning ?? null,
    level: entry.level ?? null,
    partOfSpeechEn: entry.partOfSpeechEn ?? null,
    partOfSpeechJp: entry.partOfSpeechJp ?? null,
    sourceCardId: entry.sourceCardId ?? null,
    position,
  }));
}
function cardUpsert(db: D1Database, rows: ReturnType<typeof entryRows>, timestamp: string) {
  return db.prepare(`INSERT INTO admin_content_cards
      (id, identity_key, expression, reading, meaning, level, part_of_speech_en, part_of_speech_jp, created_at, updated_at)
    SELECT json_extract(value, '$.cardId'), json_extract(value, '$.identityKey'),
           json_extract(value, '$.expression'), json_extract(value, '$.reading'),
           json_extract(value, '$.meaning'), json_extract(value, '$.level'),
           json_extract(value, '$.partOfSpeechEn'), json_extract(value, '$.partOfSpeechJp'), ?, ?
      FROM json_each(?) WHERE 1
    ON CONFLICT(identity_key) DO UPDATE SET
      expression = excluded.expression,
      reading = excluded.reading,
      meaning = COALESCE(excluded.meaning, admin_content_cards.meaning),
      level = COALESCE(excluded.level, admin_content_cards.level),
      part_of_speech_en = COALESCE(excluded.part_of_speech_en, admin_content_cards.part_of_speech_en),
      part_of_speech_jp = COALESCE(excluded.part_of_speech_jp, admin_content_cards.part_of_speech_jp),
      updated_at = excluded.updated_at`).bind(timestamp, timestamp, JSON.stringify(rows));
}
function batchCardLinks(db: D1Database, batchId: string, rows: ReturnType<typeof entryRows>) {
  return db.prepare(`INSERT INTO admin_content_batch_cards (batch_id, card_id, source_card_id, position)
    SELECT ?, c.id, json_extract(source.value, '$.sourceCardId'), CAST(json_extract(source.value, '$.position') AS INTEGER)
      FROM json_each(?) source JOIN admin_content_cards c
        ON c.identity_key = json_extract(source.value, '$.identityKey')
      WHERE 1
    ON CONFLICT(batch_id, card_id) DO UPDATE SET
      source_card_id = COALESCE(excluded.source_card_id, admin_content_batch_cards.source_card_id),
      position = excluded.position`).bind(batchId, JSON.stringify(rows));
}
function auditHeader(db: D1Database, event: { id: string; actorUid: string; action: string; batchId?: string | null; batchName?: string | null; groupId?: string | null; groupName?: string | null; summary: string; createdAt: string }) {
  return db.prepare(`INSERT INTO admin_content_events (id, actor_uid, action, batch_id, batch_name, group_id, group_name, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id, event.actorUid, event.action, event.batchId ?? null, event.batchName ?? null, event.groupId ?? null, event.groupName ?? null, event.summary, event.createdAt);
}
function auditItemStatements(db: D1Database, eventId: string, items: AuditCard[]) {
  const result: D1PreparedStatement[] = [];
  for (let start = 0; start < items.length; start += 500) {
    const chunk = items.slice(start, start + 500).map((item, index) => ({ ...item, position: start + index }));
    result.push(db.prepare(`INSERT INTO admin_content_event_cards (event_id, position, change_type, card_id, expression, reading)
      SELECT ?, CAST(json_extract(value, '$.position') AS INTEGER), json_extract(value, '$.changeType'),
             json_extract(value, '$.cardId'), json_extract(value, '$.expression'), json_extract(value, '$.reading')
        FROM json_each(?)`).bind(eventId, JSON.stringify(chunk)));
  }
  return result;
}
async function groupExists(db: D1Database, id: string): Promise<boolean> {
  return !!await db.prepare('SELECT id FROM admin_content_groups WHERE id = ?').bind(id).first();
}
function parseOptionalGroupId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  try { return adminContentText(value, 'group ID', 200, true); }
  catch (err) { throw jsonResponseError(err instanceof Error ? err.message : 'Invalid group ID.'); }
}
function mapGroup(row: GroupRow) {
  return { id: row.id, name: row.name, batchCount: row.batch_count, cardCount: row.card_count, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapBatch(row: BatchRow) {
  return { id: row.id, name: row.name, kind: row.kind, groupId: row.group_id, groupName: row.group_name,
    cardCount: row.card_count, sourceUid: row.source_uid, sourceKind: row.source_kind, sourceId: row.source_id,
    sourceAll: row.source_all === 1, selectedSourceIds: safeJson(row.selected_source_ids), sourceVersion: row.source_version,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapCard(row: CardRow) {
  return { id: row.id, expression: row.expression, reading: row.reading, meaning: row.meaning ?? '', level: row.level ?? 'Custom',
    partOfSpeechEn: row.part_of_speech_en ?? undefined, partOfSpeechJp: row.part_of_speech_jp ?? undefined,
    batchIds: row.batch_ids ? row.batch_ids.split(',') : [], groupIds: row.group_ids ? row.group_ids.split(',') : [] };
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
  const name = parseName(value, 'group name');
  return name;
}

router.get('/api/admin/content', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const [groupResult, batchResult] = await Promise.all([
    c.env.DB.prepare(`SELECT g.id, g.name, g.created_by, g.created_at, g.updated_at,
        (SELECT COUNT(*) FROM admin_content_batches b WHERE b.group_id = g.id) AS batch_count,
        (SELECT COUNT(DISTINCT bc.card_id) FROM admin_content_batches b JOIN admin_content_batch_cards bc ON bc.batch_id = b.id WHERE b.group_id = g.id) AS card_count
      FROM admin_content_groups g ORDER BY lower(g.name), g.id`).all<GroupRow>(),
    c.env.DB.prepare(`SELECT b.id, b.name, b.kind, b.group_id, b.source_uid, b.source_kind, b.source_id, b.source_all,
        b.selected_source_ids, b.source_version, b.created_by, b.created_at, b.updated_at, g.name AS group_name,
        COUNT(DISTINCT bc.card_id) AS card_count
      FROM admin_content_batches b LEFT JOIN admin_content_groups g ON g.id = b.group_id
      LEFT JOIN admin_content_batch_cards bc ON bc.batch_id = b.id
      GROUP BY b.id ORDER BY b.created_at DESC, b.name COLLATE NOCASE`).all<BatchRow>(),
  ]);
  return c.json({ groups: groupResult.results.map(mapGroup), batches: batchResult.results.map(mapBatch),
    limits: { groups: ADMIN_CONTENT_MAX_GROUPS, filesPerUpload: ADMIN_CONTENT_MAX_FILES, rowsPerUpload: ADMIN_CONTENT_MAX_ROWS } });
});

router.get('/api/admin/content/cards', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.query('batchId') ?? null;
  const groupId = c.req.query('groupId') ?? null;
  if (batchId && groupId) throw jsonResponseError('Choose one card filter at a time.');
  if (batchId && !await c.env.DB.prepare('SELECT id FROM admin_content_batches WHERE id = ?').bind(batchId).first()) throw jsonResponseError('Batch not found.', 404);
  if (groupId && !await groupExists(c.env.DB, groupId)) throw jsonResponseError('Group not found.', 404);
  const where = batchId ? 'WHERE EXISTS (SELECT 1 FROM admin_content_batch_cards bc WHERE bc.card_id = c.id AND bc.batch_id = ?)'
    : groupId ? 'WHERE EXISTS (SELECT 1 FROM admin_content_batch_cards bc JOIN admin_content_batches b ON b.id = bc.batch_id WHERE bc.card_id = c.id AND b.group_id = ?)'
      : '';
  const statement = c.env.DB.prepare(`SELECT c.id, c.expression, c.reading, c.meaning, c.level, c.part_of_speech_en, c.part_of_speech_jp, c.created_at, c.updated_at,
      (SELECT GROUP_CONCAT(bc.batch_id) FROM admin_content_batch_cards bc WHERE bc.card_id = c.id) AS batch_ids,
      (SELECT GROUP_CONCAT(DISTINCT b.group_id) FROM admin_content_batch_cards bc JOIN admin_content_batches b ON b.id = bc.batch_id WHERE bc.card_id = c.id AND b.group_id IS NOT NULL) AS group_ids
    FROM admin_content_cards c ${where} ORDER BY length(c.expression), c.expression COLLATE NOCASE LIMIT 5001`);
  const result = await (batchId || groupId ? statement.bind(batchId ?? groupId) : statement).all<CardRow>();
  return c.json({ cards: result.results.slice(0, 5000).map(mapCard), truncated: result.results.length > 5000 });
});

router.get('/api/admin/content/events', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 30) || 30));
  const result = await c.env.DB.prepare(`SELECT e.id, e.actor_uid, e.action, e.batch_id, e.batch_name, e.group_id, e.group_name, e.summary, e.created_at,
      (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.change_type='added') AS added_count,
      (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.change_type='updated') AS updated_count,
      (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.change_type='removed') AS removed_count,
      (SELECT COUNT(*) FROM admin_content_event_cards ec WHERE ec.event_id=e.id AND ec.change_type='deleted') AS deleted_count
    FROM admin_content_events e ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  return c.json({ events: result.results });
});
router.get('/api/admin/content/events/:id', async c => {
  await requireWordAdmin(c.req.raw, c.env);
  const event = await c.env.DB.prepare('SELECT * FROM admin_content_events WHERE id = ?').bind(c.req.param('id')).first();
  if (!event) throw jsonResponseError('History entry not found.', 404);
  const cards = await c.env.DB.prepare('SELECT position, change_type, card_id, expression, reading FROM admin_content_event_cards WHERE event_id = ? ORDER BY position LIMIT 5000').bind(c.req.param('id')).all();
  return c.json({ event, cards: cards.results });
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
  const timestamp = nowIso(), statements: D1PreparedStatement[] = [];
  for (const file of files) {
    const rows = entryRows(file.entries);
    const rowsJson = JSON.stringify(rows);
    statements.push(c.env.DB.prepare(`INSERT INTO admin_content_batches
      (id,name,kind,group_id,source_uid,source_kind,source_id,source_all,selected_source_ids,source_version,created_by,created_at,updated_at)
      VALUES (?,?,'csv',?,NULL,NULL,NULL,0,'[]',NULL,?,?,?)`)
      .bind(file.batchId, file.name, groupId, actor, timestamp, timestamp));
    statements.push(cardUpsert(c.env.DB, rows, timestamp));
    statements.push(batchCardLinks(c.env.DB, file.batchId, rows));
    statements.push(auditHeader(c.env.DB, { id: file.eventId, actorUid: actor, action: 'csv_import', batchId: file.batchId, batchName: file.name,
      groupId, summary: `Uploaded “${file.name}” as a separate batch with ${file.entries.length} cards.`, createdAt: timestamp }));
    statements.push(...auditItemStatements(c.env.DB, file.eventId, rows.map(row => ({ changeType: 'added' as const, expression: row.expression, reading: row.reading }))));
  }
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
  const source = await resolvePersonalContentSource(c.env.DB, sourceUid, sourceKind, sourceId, sourceAll, selectedSourceIds);
  if (!source) throw jsonResponseError('No saved account data was found for this Firebase UID.', 404);
  if (!source.sourceName) throw jsonResponseError('The selected personal save slot or group no longer exists.', 404);
  if (!source.cards.length || source.cards.length > ADMIN_CONTENT_MAX_ROWS) throw jsonResponseError(`The selected source must contain 1–${ADMIN_CONTENT_MAX_ROWS} cards.`);
  const rows = entryRows(source.cards.map(card => ({ ...card, sourceCardId: card.id })));
  const batchId = `acb-${crypto.randomUUID()}`, eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const sourceIdsJson = JSON.stringify(sourceAll ? [] : selectedSourceIds);
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO admin_content_batches
      (id,name,kind,group_id,source_uid,source_kind,source_id,source_all,selected_source_ids,source_version,created_by,created_at,updated_at)
      VALUES (?,?,'personal',?,?,?,?,?,?,?,?,?,?)`)
      .bind(batchId, name, groupId, sourceUid, sourceKind, sourceId, sourceAll ? 1 : 0, sourceIdsJson, source.version, actor, timestamp, timestamp),
    cardUpsert(c.env.DB, rows, timestamp),
    batchCardLinks(c.env.DB, batchId, rows),
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'personal_copy', batchId, batchName: name, groupId,
      summary: `Copied ${rows.length} cards from ${source.sourceName} (${sourceUid}) into “${name}”.`, createdAt: timestamp }),
    ...auditItemStatements(c.env.DB, eventId, rows.map(row => ({ changeType: 'added' as const, expression: row.expression, reading: row.reading }))),
  ];
  await c.env.DB.batch(statements);
  return c.json({ ok: true, batch: { id: batchId, name, kind: 'personal', groupId, cardCount: rows.length }, eventId }, 201);
});

router.post('/api/admin/content/batches/:id/sync', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id');
  const batch = await c.env.DB.prepare(`SELECT id,name,kind,group_id,source_uid,source_kind,source_id,source_all,selected_source_ids,source_version
    FROM admin_content_batches WHERE id=?`).bind(batchId).first<SourceBatchRow>();
  if (!batch) throw jsonResponseError('Batch not found.', 404);
  if (batch.kind !== 'personal' || !batch.source_uid || !batch.source_kind) throw jsonResponseError('Only personal-source batches can be synchronized.');
  const sourceKind = sourceKindInput(batch.source_kind);
  const selectedSourceIds = serializeSourceIds(safeJson(batch.selected_source_ids));
  const source = await resolvePersonalContentSource(c.env.DB, batch.source_uid, sourceKind, batch.source_id, batch.source_all === 1, selectedSourceIds)
    ?? { version: batch.source_version ?? 0, sourceName: '', cards: [] as AdminContentCardSource[] };
  const oldRows = await c.env.DB.prepare(`SELECT bc.source_card_id,c.id,c.expression,c.reading,c.meaning,c.level,c.part_of_speech_en,c.part_of_speech_jp
    FROM admin_content_batch_cards bc JOIN admin_content_cards c ON c.id=bc.card_id
    WHERE bc.batch_id=? AND bc.source_card_id IS NOT NULL`).bind(batchId).all<ExistingBatchCard>();
  const oldBySource = new Map(oldRows.results.filter(row => row.source_card_id).map(row => [row.source_card_id!, row]));
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
    if (!old) { added++; eventItems.push({ changeType: 'added', expression: card.expression, reading: card.reading }); continue; }
    const same = old.expression === card.expression && old.reading === card.reading && (old.meaning ?? '') === card.meaning
      && (old.level ?? 'Custom') === card.level && (old.part_of_speech_en ?? '') === (card.partOfSpeechEn ?? '')
      && (old.part_of_speech_jp ?? '') === (card.partOfSpeechJp ?? '');
    if (!same) { updated++; eventItems.push({ changeType: 'updated', cardId: old.id, expression: card.expression, reading: card.reading }); }
  }
  for (const [sourceCardId, old] of oldBySource) if (!currentBySource.has(sourceCardId)) {
    removed++; eventItems.push({ changeType: 'removed', cardId: old.id, expression: old.expression, reading: old.reading });
  }
  const rows = entryRows(currentCards.map(card => ({ ...card, sourceCardId: card.id })));
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  const summary = `Synchronized “${batch.name}”: ${added} added, ${updated} updated, ${removed} removed from this batch.${source.sourceName ? '' : ' The personal source account or collection no longer exists.'}`;
  const statements: D1PreparedStatement[] = [];
  if (rows.length) statements.push(cardUpsert(c.env.DB, rows, timestamp));
  statements.push(c.env.DB.prepare('DELETE FROM admin_content_batch_cards WHERE batch_id=? AND source_card_id IS NOT NULL').bind(batchId));
  if (rows.length) statements.push(batchCardLinks(c.env.DB, batchId, rows));
  statements.push(c.env.DB.prepare('UPDATE admin_content_batches SET source_version=?, updated_at=? WHERE id=?').bind(source.version, timestamp, batchId));
  statements.push(auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'personal_sync', batchId, batchName: batch.name,
    groupId: batch.group_id, summary, createdAt: timestamp }));
  statements.push(...auditItemStatements(c.env.DB, eventId, eventItems));
  await c.env.DB.batch(statements);
  return c.json({ ok: true, batchId, eventId, added, updated, removed, sourceMissing: !source.sourceName });
});

router.delete('/api/admin/content/batches/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id');
  const batch = await c.env.DB.prepare('SELECT id,name,group_id FROM admin_content_batches WHERE id=?').bind(batchId).first<{ id: string; name: string; group_id: string | null }>();
  if (!batch) throw jsonResponseError('Batch not found.', 404);
  const cardResult = await c.env.DB.prepare(`SELECT DISTINCT c.id,c.expression,c.reading FROM admin_content_cards c
    JOIN admin_content_batch_cards bc ON bc.card_id=c.id WHERE bc.batch_id=? ORDER BY bc.position LIMIT 5000`).bind(batchId).all<{ id: string; expression: string; reading: string }>();
  const items: AuditCard[] = cardResult.results.map(card => ({ changeType: 'deleted', cardId: card.id, expression: card.expression, reading: card.reading }));
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  await c.env.DB.batch([
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'batch_deleted', batchId, batchName: batch.name, groupId: batch.group_id,
      summary: `Deleted batch “${batch.name}” and all ${items.length} cards from the admin catalog, including cards shared with other batches. Personal accounts and published snapshots were not changed.`, createdAt: timestamp }),
    ...auditItemStatements(c.env.DB, eventId, items),
    c.env.DB.prepare('DELETE FROM admin_content_cards WHERE id IN (SELECT card_id FROM admin_content_batch_cards WHERE batch_id=?)').bind(batchId),
    c.env.DB.prepare('DELETE FROM admin_content_batches WHERE id=?').bind(batchId),
  ]);
  return c.json({ ok: true, eventId, deleted: items.length });
});

router.post('/api/admin/content/batches/:id/remove-cards', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const batchId = c.req.param('id'), body = await readJson(c, 256_000);
  if (!Array.isArray(body.cardIds) || !body.cardIds.length || body.cardIds.length > ADMIN_CONTENT_MAX_ROWS || body.cardIds.some(id => typeof id !== 'string')) throw jsonResponseError('Select cards from this batch first.');
  const ids = [...new Set(body.cardIds as string[])];
  const batch = await c.env.DB.prepare('SELECT name,group_id FROM admin_content_batches WHERE id=?').bind(batchId).first<{ name: string; group_id: string | null }>();
  if (!batch) throw jsonResponseError('Batch not found.', 404);
  const found = await c.env.DB.prepare(`SELECT c.id,c.expression,c.reading FROM admin_content_batch_cards bc
    JOIN admin_content_cards c ON c.id=bc.card_id WHERE bc.batch_id=? AND c.id IN (SELECT value FROM json_each(?))`)
    .bind(batchId, JSON.stringify(ids)).all<{ id: string; expression: string; reading: string }>();
  if (found.results.length !== ids.length) throw jsonResponseError('Some selected cards are no longer in this batch. Reload the batch first.', 409);
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const items: AuditCard[] = found.results.map(card => ({ changeType: 'removed', cardId: card.id, expression: card.expression, reading: card.reading }));
  await c.env.DB.batch([
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'cards_removed_from_batch', batchId, batchName: batch.name, groupId: batch.group_id,
      summary: `Removed ${items.length} cards from batch “${batch.name}”; catalog cards were kept.`, createdAt: timestamp }),
    ...auditItemStatements(c.env.DB, eventId, items),
    c.env.DB.prepare('DELETE FROM admin_content_batch_cards WHERE batch_id=? AND card_id IN (SELECT value FROM json_each(?))').bind(batchId, JSON.stringify(ids)),
  ]);
  return c.json({ ok: true, eventId, removed: items.length });
});

router.post('/api/admin/content/cards/delete', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const body = await readJson(c, 256_000);
  if (!Array.isArray(body.cardIds) || !body.cardIds.length || body.cardIds.length > ADMIN_CONTENT_MAX_ROWS || body.cardIds.some(id => typeof id !== 'string' || !id)) {
    throw jsonResponseError('Select admin catalog cards to delete first.');
  }
  const ids = [...new Set(body.cardIds as string[])];
  const found = await c.env.DB.prepare(`SELECT id,expression,reading FROM admin_content_cards
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY expression COLLATE NOCASE,reading COLLATE NOCASE`)
    .bind(JSON.stringify(ids)).all<{ id: string; expression: string; reading: string }>();
  if (found.results.length !== ids.length) throw jsonResponseError('Some selected cards are no longer in the admin catalog. Reload the card list first.', 409);
  const refCount = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_content_batch_cards
    WHERE card_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).first<{ count: number }>();
  const eventId = `ace-${crypto.randomUUID()}`, timestamp = nowIso();
  const items: AuditCard[] = found.results.map(card => ({ changeType: 'deleted', cardId: card.id, expression: card.expression, reading: card.reading }));
  await c.env.DB.batch([
    auditHeader(c.env.DB, { id: eventId, actorUid: actor, action: 'cards_deleted',
      summary: `Deleted ${items.length} selected card(s) from the admin catalog and removed ${refCount?.count ?? 0} batch reference(s). Personal source accounts and published snapshots were not changed.`, createdAt: timestamp }),
    ...auditItemStatements(c.env.DB, eventId, items),
    c.env.DB.prepare('DELETE FROM admin_content_cards WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)),
  ]);
  return c.json({ ok: true, eventId, deleted: items.length, removedReferences: refCount?.count ?? 0 });
});

router.patch('/api/admin/content/cards/:id', async c => {
  const actor = await requireWordAdmin(c.req.raw, c.env);
  const id = c.req.param('id'), body = await readJson(c, 16_384);
  const current = await c.env.DB.prepare(`SELECT id,identity_key,expression,reading,meaning,level,part_of_speech_en,part_of_speech_jp
    FROM admin_content_cards WHERE id=?`).bind(id).first<Record<string, unknown>>();
  if (!current) throw jsonResponseError('Admin content card not found.', 404);
  const entry = parseEntry({
    expression: body.expression ?? current.expression,
    reading: body.reading ?? current.reading,
    meaning: body.meaning ?? current.meaning ?? '',
    level: body.level ?? current.level ?? 'Custom',
    partOfSpeechEn: body.partOfSpeechEn ?? current.part_of_speech_en ?? undefined,
    partOfSpeechJp: body.partOfSpeechJp ?? current.part_of_speech_jp ?? undefined,
  });
  const identityKey = adminContentIdentity(entry.expression, entry.reading);
  const duplicate = await c.env.DB.prepare('SELECT id FROM admin_content_cards WHERE identity_key=? AND id<>?').bind(identityKey, id).first<{ id: string }>();
  if (duplicate) throw jsonResponseError('Another admin card already has this exact expression and reading. Remove the duplicate from this batch instead.', 409);
  const timestamp = nowIso(), eventId = `ace-${crypto.randomUUID()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE admin_content_cards SET identity_key=?,expression=?,reading=?,meaning=?,level=?,part_of_speech_en=?,part_of_speech_jp=?,updated_at=? WHERE id=?`)
      .bind(identityKey, entry.expression, entry.reading, entry.meaning ?? '', entry.level ?? 'Custom', entry.partOfSpeechEn ?? null, entry.partOfSpeechJp ?? null, timestamp, id),
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
  const snapshot = await createDeckSnapshot(c.env.DB, adminUid, sourceId);
  if (!snapshot || !snapshot.cards.length) throw jsonResponseError('This group has no cards to publish.', 400);
  const snapshotJson = serializeDeckSnapshot(snapshot);
  const id = crypto.randomUUID(), timestamp = nowIso();
  const result = await c.env.DB.prepare(`INSERT OR IGNORE INTO published_decks
      (id, source_uid, source_list_id, visibility, recipient_uids, created_by, created_at, updated_at, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, adminUid, sourceId, audience.visibility, JSON.stringify(audience.recipientUids), adminUid, timestamp, timestamp, snapshotJson).run();
  if (result.meta.changes !== 1) throw jsonResponseError('This admin content group is already published. Edit its audience instead.', 409);
  return c.json({ id, ok: true }, 201);
});

export default router;
