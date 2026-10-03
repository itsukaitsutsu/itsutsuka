/**
 * MyKotoba API — Cloudflare Worker + D1.
 *
 * Security model: there are no firestore.rules any more. THIS FILE is the
 * authorisation layer. Every route resolves the uid from the verified Firebase
 * ID token and then filters every query by that uid. When you add a route, the
 * first two lines must be `const uid = await uidFromRequest(...)` and a WHERE
 * clause containing that uid.
 *
 * Local dev:  npx wrangler dev          (API on :8787, local copy of D1)
 *             npm run dev               (Vite on :5173, proxies /api -> :8787)
 * Deploy:     npm run deploy
 */

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { deviceSessionFromRequest, HttpError, uidFromRequest, type Env } from './auth';
import { MatchRoom } from './matchRoom';
import { getAccount, sanitizeLegacy, transferable } from './rankedAccounts';
import { higherRank } from './rankedPolicy';
import { RULES, RANKED_RULES_VERSION, TIERS, isValidReviewMs, isQuizType, lowerTier, type RankedAccount, type QuizType } from '../shared/ranked';
import type { Level } from '../shared/vocabulary';
import { tierWords } from './rankedQuestions';
import { isWordAdmin, requireWordAdmin, wordAdminUid, uidFromHeader } from './adminAccess';
import { ADMIN_MAX_BYTES, prepareAdminWordChange, type AdminWordChange } from './adminWords';
import { createDeckSnapshot, deletePublishedDeckAndChunks, ensureDeckSummary, groupSourceId, preparePublishedDeckStatements, readPublishedDeck, sourceGroups, sourceLists, toAdminDeck, validListId, validUid, validatePublication, type AdminDeckRow, type PublishedRow, type PublishInput } from './publishedDecks';
import adminContentRoutes from './adminContentRoutes';

export { MatchRoom };

const app = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

// Required tables across the ordered migrations. /api/health compares against this list.
const EXPECTED_TABLES = [
  'card_discovery', 'friend_requests', 'invites', 'leaderboard', 'nicknames', 'pairs',
  'device_sessions', 'ranked_accounts', 'ranked_match_events', 'ranked_match_players', 'ranked_matches', 'user_data', 'users', 'published_decks',
  'admin_content_groups', 'admin_content_batches', 'admin_content_cards', 'admin_content_batch_cards', 'admin_content_events', 'admin_content_event_cards',
];

app.onError((err, c) => {
  const status = (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode;
  if (status === 500) console.error(err);
  return c.json({ error: err.message || 'Something went wrong.', ...(err instanceof HttpError && err.code ? { code: err.code } : {}) }, status);
});

app.route('/', adminContentRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type UserDataRow = {
  uid: string;
  lists: string;
  active_id: string | null;
  custom_words: string;
  card_groups?: string;
  history: string;
  share_scores: number;
  nickname: string;
  friend_code: string;
  version: number;
};

type MePayload = {
  lists: unknown[];
  activeId: string | null;
  customWords: unknown[];
  history: unknown[];
  shareScores: boolean;
  nickname: string;
  friendCode: string;
  version: number;
};

type DiscoveryRecord = { key: string; cardId: string; seen: boolean; version: number; operation: string };

const EMPTY_ME: MePayload = {
  lists: [], activeId: null, customWords: [], history: [],
  shareScores: false, nickname: '', friendCode: '', version: 0,
};

const EXPECTED_RANKED_COLUMNS: Array<[string, string, string]> = [
  ['ranked_matches', 'mode', '0003_ranked_accounts.sql'],
  ['ranked_matches', 'rules_version', '0003_ranked_accounts.sql'],
  ['ranked_matches', 'review_ms', '0004_ranked_review_time.sql'],
  ['ranked_accounts', 'cursed', '0005_ranked_cursed_cards.sql'],
  ['ranked_matches', 'quiz_type', '0007_ranked_quiz_type.sql'],
];
// /api/health checks all post-0001 columns; ranked rooms check only their own schema.
const EXPECTED_COLUMNS: Array<[string, string, string]> = [
  ...EXPECTED_RANKED_COLUMNS,
  ['published_decks', 'snapshot_json', '0010_published_deck_snapshots.sql'],
  ['user_data', 'card_groups', '0011_admin_card_groups.sql'],
  ['admin_content_groups', 'name', '0012_admin_content_library.sql'],
  ['admin_content_batches', 'source_uid', '0012_admin_content_library.sql'],
  ['admin_content_cards', 'identity_key', '0012_admin_content_library.sql'],
  ['admin_content_batch_cards', 'source_card_id', '0012_admin_content_library.sql'],
  ['admin_content_events', 'summary', '0012_admin_content_library.sql'],
  ['admin_content_event_cards', 'change_type', '0012_admin_content_library.sql'],
];
async function missingSchemaColumns(db: D1Database, expected: Array<[string, string, string]>): Promise<string[]> {
  const missing: string[] = [];
  for (const table of new Set(expected.map(([t]) => t))) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const present = new Set(results.map(r => r.name));
    for (const [t, column, migration] of expected) if (t === table && !present.has(column)) missing.push(`${table}.${column} (apply migrations/${migration})`);
  }
  return missing;
}
export async function missingRankedColumns(db: D1Database): Promise<string[]> {
  return missingSchemaColumns(db, EXPECTED_RANKED_COLUMNS);
}
async function missingExpectedColumns(db: D1Database): Promise<string[]> {
  return missingSchemaColumns(db, EXPECTED_COLUMNS);
}

const parseJson = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const toMe = (row: UserDataRow): MePayload => ({
  lists: parseJson<unknown[]>(row.lists, []),
  activeId: row.active_id,
  customWords: parseJson<unknown[]>(row.custom_words, []),
  history: parseJson<unknown[]>(row.history, []),
  shareScores: row.share_scores === 1,
  nickname: row.nickname ?? '',
  friendCode: row.friend_code ?? '',
  version: row.version ?? 0,
});

const sortedPairId = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// ─────────────────────────────────────────────────────────────────────────────
// Health (no auth) — handy smoke test: curl http://127.0.0.1:8787/api/health
// ─────────────────────────────────────────────────────────────────────────────
// No auth: it never reads your data, and it answers the three questions that
// account for almost every "it works locally but not online" report — is the
// Firebase project id set, is the D1 database attached, and do the tables exist?
app.get('/api/health', async (c) => {
  const report: Record<string, unknown> = { ok: true, time: nowIso() };
  report.firebaseProjectId = c.env.FIREBASE_PROJECT_ID || '(MISSING)';

  if (!c.env.DB) {
    report.ok = false;
    report.database = '(MISSING) — Pages → Settings → Functions → D1 database bindings → name it exactly DB';
    return c.json(report);
  }
  report.database = 'bound';
  report.rankedRooms = c.env.MATCH_ROOM ? 'bound' : 'MISSING MATCH_ROOM Durable Object binding';
  if (!c.env.MATCH_ROOM) report.ok = false;

  try {
    const { results } = await c.env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
      .all<{ name: string }>();
    report.tables = results.map((row) => row.name);
    const missing = EXPECTED_TABLES.filter(name => !results.some(row => row.name === name));
    if (missing.length) {
      report.ok = false; report.missingTables = missing;
      report.hint = 'Run npm run db:migrate:remote to apply all database migrations.';
    }
    // Surface columns added by later migrations so the affected feature fails clearly.
    const missingColumns = await missingExpectedColumns(c.env.DB);
    if (missingColumns.length) {
      report.ok = false; report.missingColumns = missingColumns;
      report.hint = 'Run npm run db:migrate:remote to apply all database migrations.';
    }
  } catch (err) {
    report.ok = false;
    report.databaseError = (err as Error).message;
  }
  return c.json(report);
});

// ─────────────────────────────────────────────────────────────────────────────
// Device sessions — list signed-in browsers and revoke a specific device.
// Authentication itself binds every API request to an active device session.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/devices/check', async (c) => {
  await uidFromRequest(c.req.raw, c.env);
  return c.json({ ok: true });
});

app.get('/api/devices', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const currentId = deviceSessionFromRequest(c.req.raw);
  const { results } = await c.env.DB.prepare(
    'SELECT session_id, label, created_at, last_seen_at FROM device_sessions WHERE uid = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 50',
  ).bind(uid).all<{ session_id: string; label: string; created_at: number; last_seen_at: number }>();
  return c.json({ devices: results.map(row => ({ id: row.session_id, label: row.label, createdAt: row.created_at, lastSeenAt: row.last_seen_at, current: row.session_id === currentId })) });
});

app.post('/api/devices/:id/revoke', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const targetId = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) return c.json({ error: 'Invalid device session.' }, 400);
  const result = await c.env.DB.prepare(
    'UPDATE device_sessions SET revoked_at = ? WHERE session_id = ? AND uid = ? AND revoked_at IS NULL',
  ).bind(Date.now(), targetId, uid).run();
  if (!result.meta.changes) return c.json({ error: 'Device session not found or already signed out.' }, 404);
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// userData/{uid}   — replaces onSnapshot(doc(db,'userData',uid)) + pushToCloud()
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/me', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  // NOTE: deliberately no writes on this path — it is polled every ~20s and a
  // `touchUser()` here would burn rows-written for nothing. Call touchUser()
  // from an admin route (or on first save) if you want the `users` table filled.

  const row = await c.env.DB.prepare(
    `SELECT uid, lists, active_id, custom_words, history, share_scores, nickname, friend_code, version
       FROM user_data WHERE uid = ?`,
  ).bind(uid).first<UserDataRow>();

  if (!row) return c.json(EMPTY_ME);   // nothing saved yet — client will seed from localStorage
  return c.json(toMe(row));
});

/**
 * Merge-patch. Send `version` (the one you last saw from GET /api/me) to get
 * optimistic locking: if someone else saved in between you get 409 and should
 * refetch, re-apply and retry. Omit `version` for last-write-wins.
 */
app.put('/api/me', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const patch = await c.req.json<Partial<MePayload> & { version?: number }>();
  const now = nowIso();
  const v = patch.version ?? null;

  const [, update] = await c.env.DB.batch([
    // Create the row if this is the user's first save.
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_data (uid, lists, custom_words, history, version, updated_at)
       VALUES (?, '[]', '[]', '[]', 0, ?)`,
    ).bind(uid, now),

    // Apply only the fields that were sent.
    c.env.DB.prepare(
      `UPDATE user_data SET
         lists        = COALESCE(?, lists),
         active_id    = COALESCE(?, active_id),
         custom_words = COALESCE(?, custom_words),
         history      = COALESCE(?, history),
         share_scores = COALESCE(?, share_scores),
         nickname     = COALESCE(?, nickname),
         friend_code  = COALESCE(?, friend_code),
         version      = version + 1,
         updated_at   = ?
       WHERE uid = ? AND (? IS NULL OR version = ?)`,
    ).bind(
      patch.lists !== undefined ? JSON.stringify(patch.lists) : null,
      patch.activeId !== undefined ? patch.activeId : null,
      patch.customWords !== undefined ? JSON.stringify(patch.customWords) : null,
      patch.history !== undefined ? JSON.stringify(patch.history) : null,
      patch.shareScores !== undefined ? (patch.shareScores ? 1 : 0) : null,
      patch.nickname !== undefined ? patch.nickname : null,
      patch.friendCode !== undefined ? patch.friendCode : null,
      now, uid, v, v,
    ),
  ]);

  if (v !== null && update.meta.changes === 0) {
    return c.json({ error: 'stale', message: 'This data changed on another device. Reloading…' }, 409);
  }

  const fresh = await c.env.DB.prepare('SELECT version FROM user_data WHERE uid = ?').bind(uid).first<{ version: number }>();
  return c.json({ ok: true, version: fresh?.version ?? 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: manage a specific account's personal cards. The built-in catalogue,
// history, discovery and other profile fields are deliberately untouched.
// There is no account enumeration; an admin must supply an exact Firebase UID.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/status', async (c) => {
  const uid = await wordAdminUid(c.req.raw, c.env);
  return c.json({ isAdmin: isWordAdmin(uid, c.env) });
});

const adminTargetUid = (uid: string) => {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(uid)) throw new HttpError(400, 'Invalid Firebase UID.');
  return uid;
};
const adminFields = `SELECT uid, lists, active_id, custom_words, card_groups, history, share_scores, nickname, friend_code, version FROM user_data WHERE uid = ?`;

app.get('/api/admin/users/:uid/words', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const uid = adminTargetUid(c.req.param('uid'));
  const row = await c.env.DB.prepare(adminFields).bind(uid).first<UserDataRow>();
  if (!row) return c.json({ error: 'No saved account data for this UID.' }, 404);
  const data = toMe(row);
  return c.json({ uid, nickname: data.nickname, version: data.version, customWords: data.customWords, lists: data.lists, groups: parseJson(row.card_groups ?? null, []) });
});

app.patch('/api/admin/users/:uid/words', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const uid = adminTargetUid(c.req.param('uid'));
  if (Number(c.req.header('content-length') ?? 0) > 1_048_576) return c.json({ error: 'Request is too large (1 MiB max).' }, 413);
  const body = await c.req.raw.text();
  if (new TextEncoder().encode(body).length > 1_048_576) return c.json({ error: 'Request is too large (1 MiB max).' }, 413);
  let change: AdminWordChange;
  try { change = JSON.parse(body) as AdminWordChange; }
  catch { return c.json({ error: 'Invalid JSON.' }, 400); }
  const row = await c.env.DB.prepare(adminFields).bind(uid).first<UserDataRow>();
  if (!row) return c.json({ error: 'No saved account data for this UID.' }, 404);
  if (row.version !== change?.version) return c.json({ error: 'This account changed. Reload it before making edits.' }, 409);
  let result: ReturnType<typeof prepareAdminWordChange>;
  try { result = prepareAdminWordChange(parseJson(row.custom_words, []), parseJson(row.lists, []), change, parseJson(row.card_groups ?? null, [])); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : 'Invalid cards.' }, 400); }
  if (new TextEncoder().encode(JSON.stringify({ lists: result.lists, groups: result.groups, customWords: result.customWords, history: parseJson(row.history, []) })).length > ADMIN_MAX_BYTES) {
    return c.json({ error: 'This account would exceed the safe storage size (800 KB). Import fewer cards.' }, 413);
  }
  const saved = await c.env.DB.prepare(`UPDATE user_data SET custom_words = ?, lists = ?, card_groups = ?, version = version + 1, updated_at = ? WHERE uid = ? AND version = ?`)
    .bind(JSON.stringify(result.customWords), JSON.stringify(result.lists), JSON.stringify(result.groups), nowIso(), uid, change.version).run();
  if (saved.meta.changes !== 1) return c.json({ error: 'This account changed. Reload it before making edits.' }, 409);
  return c.json({ ok: true, version: change.version + 1, created: result.created, updated: result.updated, deleted: result.deleted, ...(result.createdGroupId ? { createdGroupId: result.createdGroupId } : {}) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Published saved-word lists. Source IDs are retained for provenance; snapshot_json
// is an immutable copy, independent of the owner's personal saved-list slots.
// ─────────────────────────────────────────────────────────────────────────────
async function publicationBody(c: Context<{ Bindings: Env }>): Promise<unknown> {
  if (Number(c.req.header('content-length') ?? 0) > 16_384) throw new HttpError(413, 'Publication is too large.');
  const text = await c.req.raw.text();
  if (new TextEncoder().encode(text).length > 16_384) throw new HttpError(413, 'Publication is too large.');
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

// Only return decks visible to this caller; never send recipient UID lists or
// source account IDs in the public response.
app.get('/api/decks', async (c) => {
  const uid = await uidFromHeader(c.req.raw, c.env);
  const page = Number(c.req.query('page') ?? '0');
  if (!Number.isSafeInteger(page) || page < 0 || page > 1000) return c.json({ error: 'Invalid page.' }, 400);
  const { results } = await c.env.DB.prepare(`
    SELECT p.* FROM published_decks p
      LEFT JOIN user_data d ON d.uid = p.source_uid
      LEFT JOIN json_each(d.lists) j ON json_extract(j.value, '$.id') = p.source_list_id
     WHERE (p.visibility = 'public'
        OR EXISTS (SELECT 1 FROM json_each(p.recipient_uids) recipients WHERE recipients.value = ?))
       AND (p.snapshot_json IS NOT NULL OR j.value IS NOT NULL)
     ORDER BY p.updated_at DESC, p.id DESC LIMIT 51 OFFSET ?
  `).bind(uid, page * 50).all<PublishedRow>();
  const decks = await Promise.all(results.slice(0, 50).map(async (row) => {
    const summary = await ensureDeckSummary(c.env.DB, row);
    return summary ? { id: row.id, name: summary.name, cardCount: summary.cardCount,
      visibility: row.visibility, updatedAt: row.updated_at } : null;
  }));
  return c.json({ decks: decks.filter((deck) => deck !== null), hasMore: results.length > 50 });
});
app.get('/api/decks/:id', async (c) => {
  const uid = await uidFromHeader(c.req.raw, c.env);
  return c.json(await readPublishedDeck(c.env.DB, c.req.param('id'), uid));
});

// Everything below this line is admin-only; all target account data is
// resolved from D1, never supplied by or trusted from a recipient's browser.
app.get('/api/admin/decks/sources/:uid', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const sourceUid = c.req.param('uid');
  if (!validUid(sourceUid)) return c.json({ error: 'Invalid Firebase UID.' }, 400);
  const row = await c.env.DB.prepare('SELECT lists, card_groups FROM user_data WHERE uid = ?').bind(sourceUid).first<{ lists: string; card_groups: string }>();
  if (!row) return c.json({ error: 'No saved account data for this UID.' }, 404);
  return c.json({
    lists: sourceLists(row.lists).map(({ id, name, wordIds }) => ({ id, name, cardCount: wordIds.length })),
    groups: sourceGroups(row.card_groups).filter(group => group.wordIds.length > 0)
      .map(({ id, name, wordIds }) => ({ id: groupSourceId(id), name, cardCount: wordIds.length })),
  });
});
app.get('/api/admin/decks', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const sourceUid = c.req.query('sourceUid') ?? null;
  if (sourceUid && !validUid(sourceUid)) return c.json({ error: 'Invalid Firebase UID.' }, 400);
  const { results } = await c.env.DB.prepare(`
    SELECT p.*,
           COALESCE(json_extract(p.snapshot_json, '$.name'), json_extract(j.value, '$.name')) AS name,
           COALESCE(CAST(json_extract(p.snapshot_json, '$.cardCount') AS INTEGER), json_array_length(json_extract(p.snapshot_json, '$.cards')), json_array_length(json_extract(j.value, '$.wordIds'))) AS card_count
      FROM published_decks p LEFT JOIN user_data d ON d.uid = p.source_uid
      LEFT JOIN json_each(d.lists) j ON json_extract(j.value, '$.id') = p.source_list_id
     WHERE (? IS NULL OR p.source_uid = ?) AND p.source_uid <> '__pub_chunk__' ORDER BY p.updated_at DESC, p.id DESC LIMIT 200
  `).bind(sourceUid, sourceUid).all<AdminDeckRow>();
  const decks = await Promise.all(results.map(async (row) => {
    const summary = await ensureDeckSummary(c.env.DB, row);
    return toAdminDeck({ ...row, name: summary?.name ?? row.name, card_count: summary?.cardCount ?? row.card_count });
  }));
  return c.json({ decks });
});
app.post('/api/admin/decks', async (c) => {
  const adminUid = await requireWordAdmin(c.req.raw, c.env);
  const raw = await publicationBody(c);
  const body = raw as Partial<PublishInput> | null;
  if (!body || !validUid(body.sourceUid) || !validListId(body.listId)) return c.json({ error: 'Choose an existing account and saved list or card group.' }, 400);
  const audience = validatePublication(body);
  if (await c.env.DB.prepare('SELECT id FROM published_decks WHERE source_uid = ? AND source_list_id = ?').bind(body.sourceUid, body.listId).first()) {
    return c.json({ error: 'This source is already published. Edit its audience instead.' }, 409);
  }
  const snapshot = await createDeckSnapshot(c.env.DB, body.sourceUid, body.listId);
  if (!snapshot) return c.json({ error: 'This saved list or card group no longer exists.' }, 404);
  const id = crypto.randomUUID(), timestamp = nowIso();
  const statements = preparePublishedDeckStatements(c.env.DB, {
    id,
    sourceUid: body.sourceUid,
    sourceListId: body.listId,
    visibility: audience.visibility,
    recipientUids: audience.recipientUids,
    createdBy: adminUid,
    timestamp,
  }, snapshot);
  const results = await c.env.DB.batch(statements);
  if (results[0]?.meta.changes !== 1) return c.json({ error: 'This source is already published. Edit its audience instead.' }, 409);
  return c.json({ id, ok: true }, 201);
});
app.patch('/api/admin/decks/:id', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const audience = validatePublication(await publicationBody(c));
  const result = await c.env.DB.prepare('UPDATE published_decks SET visibility = ?, recipient_uids = ?, updated_at = ? WHERE id = ?')
    .bind(audience.visibility, JSON.stringify(audience.recipientUids), nowIso(), c.req.param('id')).run();
  if (!result.meta.changes) return c.json({ error: 'Published deck not found.' }, 404);
  return c.json({ ok: true });
});
app.delete('/api/admin/decks/:id', async (c) => {
  await requireWordAdmin(c.req.raw, c.env);
  const deleted = await deletePublishedDeckAndChunks(c.env.DB, c.req.param('id'));
  if (!deleted) return c.json({ error: 'Published deck not found.' }, 404);
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// cardDiscovery — replaces the onSnapshot(collection(...)) listener and the
// runTransaction() "compare version, then write" in CardProgress.tsx
// ─────────────────────────────────────────────────────────────────────────────

/** Only rows changed since `since`. An idle poll therefore costs 0 D1 rows. */
app.get('/api/discovery', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const since = Number(c.req.query('since') ?? '0') || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT key, seen, version, operation FROM card_discovery
      WHERE uid = ? AND version > ? ORDER BY version ASC LIMIT 5000`,
  ).bind(uid, since).all<{ key: string; seen: number; version: number; operation: string }>();

  return c.json({
    records: results.map((r) => ({ key: r.key, seen: r.seen === 1, version: r.version, operation: r.operation })),
    syncedAt: Date.now(),
  });
});

/**
 * Upsert a batch of records. The Firestore transaction (read, compare version,
 * write) collapses into ONE atomic SQL statement: a stale write is dropped by
 * the WHERE clause and RETURNING tells the client what actually won.
 */
app.post('/api/discovery', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { records } = await c.req.json<{ records: DiscoveryRecord[] }>();
  if (!Array.isArray(records) || records.length === 0) return c.json({ settled: [] });

  const now = nowIso();
  const items = records.slice(0, 200);
  const batch = items.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO card_discovery (uid, card_id, key, seen, version, operation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid, card_id) DO UPDATE SET
         seen = excluded.seen,
         version = excluded.version,
         operation = excluded.operation,
         updated_at = excluded.updated_at
       WHERE excluded.version > card_discovery.version
          OR (excluded.version = card_discovery.version
              AND excluded.operation > card_discovery.operation)
       RETURNING key, seen, version, operation`,
    ).bind(uid, r.cardId, r.key, r.seen ? 1 : 0, r.version, r.operation, now),
  );

  const settled = (await c.env.DB.batch(batch))
    .flatMap((r) => (r.results ?? []) as { key: string; seen: number; version: number; operation: string }[])
    .map((r) => ({ key: r.key, seen: r.seen === 1, version: r.version, operation: r.operation }));

  // A record that LOST the race returns no row. Tell the client what actually won,
  // otherwise it would keep retrying forever (this is what the old Firestore
  // transaction did by returning the server's current value).
  const won = new Set(settled.map((s) => s.key));
  const losers = items.filter((r) => !won.has(r.key));
  if (losers.length) {
    const placeholders = losers.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(
      `SELECT key, seen, version, operation FROM card_discovery
        WHERE uid = ? AND card_id IN (${placeholders})`,
    ).bind(uid, ...losers.map((r) => r.cardId))
      .all<{ key: string; seen: number; version: number; operation: string }>();

    for (const row of rows.results ?? []) {
      settled.push({ key: row.key, seen: row.seen === 1, version: row.version, operation: row.operation });
    }
  }

  return c.json({ settled });
});

// ─────────────────────────────────────────────────────────────────────────────
// leaderboard
// ─────────────────────────────────────────────────────────────────────────────

const LEADERBOARD_SORTS: Record<string, string> = {
  bonusPoints: 'bonus_points',
  avgPct: 'avg_pct',
  totalQuizzes: 'total_quizzes',
};

app.get('/api/leaderboard', async (c) => {
  await uidFromRequest(c.req.raw, c.env);            // signed-in users only
  const sort = LEADERBOARD_SORTS[c.req.query('sort') ?? ''] ?? 'bonus_points';   // whitelist: no injection

  const { results } = await c.env.DB.prepare(
    `SELECT uid, display_name, total_quizzes, avg_pct, best_pct, bonus_points,
            best_day, jlpt_quizzes, jlpt_avg_pct, updated_at
       FROM leaderboard ORDER BY ${sort} DESC LIMIT 50`,
  ).all();

  return c.json(results.map((r) => ({
    uid: r.uid,
    displayName: r.display_name,
    totalQuizzes: r.total_quizzes,
    avgPct: r.avg_pct,
    bestPct: r.best_pct,
    bonusPoints: r.bonus_points,
    bestDay: r.best_day,
    jlptQuizzes: r.jlpt_quizzes,
    jlptAvgPct: r.jlpt_avg_pct,
    updatedAt: r.updated_at,
  })));
});

/** publish=false (or no nickname / no history) removes the card, as Firestore did. */
app.put('/api/leaderboard', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const body = await c.req.json<{ publish: boolean; displayName: string; stats?: Record<string, number> }>();

  if (!body.publish) {
    await c.env.DB.prepare('DELETE FROM leaderboard WHERE uid = ?').bind(uid).run();
    return c.json({ ok: true, published: false });
  }

  const s = body.stats ?? {};
  await c.env.DB.prepare(
    `INSERT INTO leaderboard (uid, display_name, total_quizzes, avg_pct, best_pct,
                              bonus_points, best_day, jlpt_quizzes, jlpt_avg_pct, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       display_name = excluded.display_name,
       total_quizzes = excluded.total_quizzes,
       avg_pct = excluded.avg_pct,
       best_pct = excluded.best_pct,
       bonus_points = excluded.bonus_points,
       best_day = excluded.best_day,
       jlpt_quizzes = excluded.jlpt_quizzes,
       jlpt_avg_pct = excluded.jlpt_avg_pct,
       updated_at = excluded.updated_at
     WHERE leaderboard.display_name IS NOT excluded.display_name
        OR leaderboard.total_quizzes IS NOT excluded.total_quizzes
        OR leaderboard.avg_pct IS NOT excluded.avg_pct
        OR leaderboard.best_pct IS NOT excluded.best_pct
        OR leaderboard.bonus_points IS NOT excluded.bonus_points
        OR leaderboard.best_day IS NOT excluded.best_day
        OR leaderboard.jlpt_quizzes IS NOT excluded.jlpt_quizzes
        OR leaderboard.jlpt_avg_pct IS NOT excluded.jlpt_avg_pct`,
  ).bind(
    uid,
    String(body.displayName ?? '').slice(0, 30),
    s.totalQuizzes ?? 0, s.avgPct ?? 0, s.bestPct ?? 0,
    s.bonusPoints ?? 0, s.bestDay ?? 0, s.jlptQuizzes ?? 0, s.jlptAvgPct ?? 0,
    nowIso(),
  ).run();

  return c.json({ ok: true, published: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// nicknames — the PRIMARY KEY is what makes a nickname unique (no transaction)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/nickname', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { name, previous } = await c.req.json<{ name: string; previous?: string }>();
  const key = String(name ?? '').trim().slice(0, 30).toLowerCase();
  if (key.length < 2) return c.json({ error: 'Nickname must be at least 2 characters.' }, 400);

  try {
    await c.env.DB.prepare('INSERT INTO nicknames (name, uid) VALUES (?, ?)').bind(key, uid).run();
  } catch {
    return c.json({ error: `"${name}" is already taken. Try another.` }, 409);
  }

  const prevKey = (previous ?? '').trim().toLowerCase();
  if (prevKey && prevKey !== key) {
    await c.env.DB.prepare('DELETE FROM nicknames WHERE name = ? AND uid = ?').bind(prevKey, uid).run();
  }
  return c.json({ ok: true, name: key });
});

// ─────────────────────────────────────────────────────────────────────────────
// invites
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/invites/:code', async (c) => {
  await uidFromRequest(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    'SELECT from_uid, nickname FROM invites WHERE code = ?',
  ).bind(String(c.req.param('code')).toUpperCase()).first<{ from_uid: string; nickname: string }>();

  return row
    ? c.json({ from: row.from_uid, nickname: row.nickname })
    : c.json({ error: 'Code not found. Ask your friend to double-check it.' }, 404);
});

app.post('/api/invites', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { code, nickname } = await c.req.json<{ code: string; nickname: string }>();
  try {
    await c.env.DB.prepare(
      'INSERT INTO invites (code, from_uid, nickname, created_at) VALUES (?,?,?,?)',
    ).bind(String(code).toUpperCase(), uid, String(nickname ?? '').slice(0, 30), nowIso()).run();
  } catch {
    return c.json({ error: 'That code already exists. Please try again.' }, 409);
  }
  return c.json({ ok: true, code: String(code).toUpperCase() });
});

// ─────────────────────────────────────────────────────────────────────────────
// friend requests
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/friend-requests', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT id, from_uid, to_uid, from_name, to_name, code, created_at
       FROM friend_requests WHERE from_uid = ? OR to_uid = ? ORDER BY created_at DESC`,
  ).bind(uid, uid).all<{
    id: string; from_uid: string; to_uid: string; from_name: string; to_name: string; code: string; created_at: string;
  }>();

  return c.json(results.map((r) => ({
    id: r.id, from: r.from_uid, to: r.to_uid,
    fromName: r.from_name, toName: r.to_name, code: r.code, createdAt: r.created_at,
  })));
});

app.post('/api/friend-requests', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { to, code } = await c.req.json<{ to: string; code: string }>();
  if (!to || to === uid) return c.json({ error: 'That is your own code.' }, 400);

  const id = sortedPairId(uid, to);
  const [a, b] = [uid, to].sort();

  const alreadyFriends = await c.env.DB.prepare('SELECT 1 AS x FROM pairs WHERE id = ?').bind(id).first();
  if (alreadyFriends) return c.json({ error: 'You are already friends.' }, 409);

  const pending = await c.env.DB.prepare(
    'SELECT from_uid FROM friend_requests WHERE id = ?',
  ).bind(id).first<{ from_uid: string }>();

  if (pending) {
    if (pending.from_uid === uid) {
      return c.json({ error: 'You already sent them an invitation — waiting for them to confirm.' }, 409);
    }
    // They invited us first and we just entered their code -> friends immediately.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO pairs (id, uid_a, uid_b, names, created_at) VALUES (?,?,?,?,?)`,
      ).bind(id, a, b, '{}', nowIso()),
      c.env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(id),
    ]);
    return c.json({ ok: true, autoAccepted: true });
  }

  await c.env.DB.prepare(
    `INSERT INTO friend_requests (id, from_uid, to_uid, from_name, to_name, code, created_at)
     SELECT ?, ?, ?,
            COALESCE((SELECT nickname FROM user_data WHERE uid = ?), ''),
            COALESCE((SELECT nickname FROM user_data WHERE uid = ?), ''),
            ?, ?`,
  ).bind(id, uid, to, uid, to, String(code ?? '').toUpperCase(), nowIso()).run();

  return c.json({ ok: true });
});

app.delete('/api/friend-requests/:id', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  // Decline, cancel — and both sides may do it.
  await c.env.DB.prepare(
    'DELETE FROM friend_requests WHERE id = ? AND (from_uid = ? OR to_uid = ?)',
  ).bind(c.req.param('id'), uid, uid).run();
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// pairs (friendships)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns my friendships, optionally with each friend's public bonus points
 *  (one query instead of the per-friend onSnapshot loop in App.tsx). */
app.get('/api/pairs', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const withBonus = c.req.query('withBonus') === '1';

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.uid_a, p.uid_b, p.names, p.created_at ${withBonus ? ', l.bonus_points AS friend_bonus' : ''}
       FROM pairs p
       ${withBonus
         ? 'LEFT JOIN leaderboard l ON l.uid = CASE WHEN p.uid_a = ? THEN p.uid_b ELSE p.uid_a END'
         : ''}
      WHERE p.uid_a = ? OR p.uid_b = ?`,
  )
    .bind(...(withBonus ? [uid, uid, uid] : [uid, uid]))
    .all<{
    id: string; uid_a: string; uid_b: string; names: string; created_at: string; friend_bonus?: number | null;
  }>();

  return c.json(results.map((r) => ({
    id: r.id,
    members: [r.uid_a, r.uid_b],
    names: parseJson<Record<string, string>>(r.names, {}),
    createdAt: r.created_at,
    ...(withBonus ? { friendBonus: r.friend_bonus ?? null } : {}),
  })));
});

/** Confirm an invitation: create the pair, delete the request. */
app.post('/api/pairs', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const { requestId, names } = await c.req.json<{ requestId: string; names?: Record<string, string> }>();

  const req = await c.env.DB.prepare(
    'SELECT from_uid, to_uid, from_name, to_name FROM friend_requests WHERE id = ?',
  ).bind(requestId).first<{ from_uid: string; to_uid: string; from_name: string; to_name: string }>();

  if (!req) return c.json({ error: 'No such invitation.' }, 404);
  if (req.to_uid !== uid) return c.json({ error: 'Only the person who was invited can confirm.' }, 403);

  const [a, b] = [req.from_uid, req.to_uid].sort();
  const pairNames = {
    [req.from_uid]: req.from_name || 'Friend',
    [req.to_uid]: req.to_name || 'Friend',
    ...(names ?? {}),
  };

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO pairs (id, uid_a, uid_b, names, created_at) VALUES (?,?,?,?,?)',
    ).bind(requestId, a, b, JSON.stringify(pairNames), nowIso()),
    c.env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(requestId),
  ]);

  return c.json({ ok: true, id: requestId });
});

app.delete('/api/pairs/:id', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  await c.env.DB.prepare('DELETE FROM pairs WHERE id = ? AND (uid_a = ? OR uid_b = ?)')
    .bind(c.req.param('id'), uid, uid).run();
  // Also clear anything pending between the same two people, like Firestore did.
  await c.env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});


// ─────────────────────────────────────────────────────────────────────────────
// Ranked Party matches
// ─────────────────────────────────────────────────────────────────────────────
// Account data is never overwritten by a browser snapshot after initialization.
app.get('/api/ranked/account', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const exists = await c.env.DB.prepare('SELECT uid FROM ranked_accounts WHERE uid = ?').bind(uid).first();
  return c.json({ account: exists ? await getAccount(c.env.DB, uid) : null });
});
app.post('/api/ranked/account', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const raw = await c.req.json<Partial<RankedAccount>>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'Invalid ranked account data.' }, 400);
  const data = sanitizeLegacy(raw);
  await c.env.DB.prepare('INSERT OR IGNORE INTO ranked_accounts (uid, points, tier, mastered) VALUES (?,?,?,?)').bind(uid, data.points, data.tier, JSON.stringify(data.mastered)).run();
  return c.json({ account: await getAccount(c.env.DB, uid) });
});
app.post('/api/ranked/account/reset', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const a = sanitizeLegacy({});
  const result = await c.env.DB.prepare('UPDATE ranked_accounts SET points = 0, tier = ?, mastered = ?, version = version + 1 WHERE uid = ? AND active_match IS NULL').bind(a.tier, JSON.stringify(a.mastered), uid).run();
  if (!result.meta.changes) return c.json({ error: 'Finish your live ranked round before resetting.' }, 409);
  return c.json({ ok: true });
});
const roomCode = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
app.post('/api/ranked/matches', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const a = await getAccount(c.env.DB, uid);
  if (a.activeMatch) return c.json({ error: 'Finish your live ranked round first.' }, 409);
  const body = await c.req.json<{ mode?: string; wagerType?: string; wagerPoints?: number; wagerCards?: number; count?: number; reviewMs?: number; quizType?: string }>();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid ranked match settings.' }, 400);
  if (body.mode && body.mode !== 'solo' && body.mode !== 'party') return c.json({ error: 'Invalid mode.' }, 400);
  const mode = body.mode === 'solo' ? 'solo' : 'party';
  if (body.reviewMs !== undefined && !isValidReviewMs(body.reviewMs)) return c.json({ error: 'Review time must be 0–10 seconds in 0.5-second steps.' }, 400);
  if (body.quizType !== undefined && !isQuizType(body.quizType)) return c.json({ error: 'Invalid quiz type.' }, 400);
  const reviewMs = body.reviewMs ?? RULES.reviewMs;
  const quizType: QuizType = isQuizType(body.quizType) ? body.quizType : 'meaning';
  const wagerType = body.wagerType ?? 'points';
  const wagerPoints = mode === 'solo' ? 0 : body.wagerPoints;
  const wagerCards = mode === 'solo' || wagerType === 'points' ? 0 : body.wagerCards;
  const count = body.count ?? 10;
  if (!['points','cards_points'].includes(wagerType) || !Number.isSafeInteger(wagerPoints) || !Number.isSafeInteger(wagerCards) ||
      (wagerPoints ?? -1) < (mode === 'solo' ? 0 : 1) || (wagerCards ?? -1) < (mode === 'party' && wagerType === 'cards_points' ? 1 : 0) ||
      !Number.isSafeInteger(count) || count < 1 || count > 10000) return c.json({ error: 'Invalid ranked match settings.' }, 400);
  if (mode === 'party' && a.points < wagerPoints!) return c.json({ error: 'Not enough ranked points. Earn points in solo ranked first.' }, 409);
  if (wagerCards! > Object.values(a.mastered).flat().length) return c.json({ error: 'You must own the mastered cards before wagering them.' }, 409);
  const id = crypto.randomUUID(), code = roomCode();
  const profile = await c.env.DB.prepare('SELECT nickname FROM user_data WHERE uid = ?').bind(uid).first<{ nickname: string }>();
  // Solo rounds only earn points from new mastery, so cap the card count at the
  // host's UNMASTERED pool (e.g. N5: 718 words, 38 mastered → max 680, synced
  // with the player's rank). Party rounds keep the full tier pool because both
  // players compete over the whole tier.
  const tierPool = tierWords(a.tier).length;
  const maxCount = mode === 'solo' ? Math.max(1, tierPool - (a.mastered[a.tier] ?? []).length) : tierPool;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ranked_matches (id, room_code, host_uid, tier, wager_type, wager_points, wager_cards, created_at, mode, question_count, rules_version, review_ms, quiz_type) VALUES (?,?,?,?,?,?,?,?,?,?,3,?,?)').bind(id, code, uid, a.tier, wagerType, wagerPoints!, wagerCards!, nowIso(), mode, Math.min(count, maxCount), reviewMs, quizType),
    c.env.DB.prepare('INSERT INTO ranked_match_players (match_id, uid, nickname) VALUES (?,?,?)').bind(id, uid, profile?.nickname || 'Player'),
  ]);
  return c.json({ ok: true, matchId: id, roomCode: code, tier: a.tier, wagerType, wagerPoints, wagerCards, reviewMs, quizType }, 201);
});
app.post('/api/ranked/matches/:id/join', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const match = await c.env.DB.prepare('SELECT * FROM ranked_matches WHERE id = ? OR room_code = ?').bind(c.req.param('id'), c.req.param('id').toUpperCase()).first<{ id: string; room_code: string; status: string; tier: RankedAccount['tier']; mode: string; rules_version: number; host_uid: string; wager_points: number; wager_cards: number }>();
  if (!match) return c.json({ error: 'Match not found.' }, 404);
  if (match.rules_version !== RANKED_RULES_VERSION) return c.json({ error: 'This is an old room. Create a new invite room.' }, 409);
  const member = await c.env.DB.prepare('SELECT uid FROM ranked_match_players WHERE match_id = ? AND uid = ?').bind(match.id, uid).first();
  if (member) return c.json({ ok: true, matchId: match.id, roomCode: match.room_code, tier: match.tier });
  if (match.status !== 'lobby' || match.mode !== 'party') return c.json({ error: 'This match is not accepting players.' }, 409);
  const a = await getAccount(c.env.DB, uid);
  if (a.activeMatch) return c.json({ error: 'Finish your live ranked round first.' }, 409);
  const host = await getAccount(c.env.DB, match.host_uid), tier = lowerTier(host.tier, a.tier);
  if (a.points < match.wager_points || host.points < match.wager_points) return c.json({ error: 'Both players need enough ranked points for this wager.' }, 409);
  for (const [from, to] of [[a, host], [host, a]]) {
    const eligible = higherRank(from, to) ? from.mastered[tier] : transferable(from, to, tier);
    if (eligible.length < match.wager_cards) return c.json({ error: `Both players must own ${match.wager_cards} eligible mastered ${tier} cards before playing this wager.` }, 409);
  }

  const profile = await c.env.DB.prepare('SELECT nickname FROM user_data WHERE uid = ?').bind(uid).first<{ nickname: string }>();
  // One statement handles capacity and status atomically; no count-then-insert race.
  const result = await c.env.DB.prepare("INSERT OR IGNORE INTO ranked_match_players (match_id, uid, nickname) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM ranked_match_players WHERE match_id = ?) < 2 AND (SELECT status FROM ranked_matches WHERE id = ?) = 'lobby'").bind(match.id, uid, profile?.nickname || 'Player', match.id, match.id).run();
  if (!result.meta.changes) return c.json({ error: 'This match is full or has already started.' }, 409);
  return c.json({ ok: true, matchId: match.id, roomCode: match.room_code, tier: lowerTier(match.tier, a.tier) });
});
app.get('/api/ranked/matches/:id', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const match = await c.env.DB.prepare('SELECT * FROM ranked_matches WHERE id = ? OR room_code = ?').bind(c.req.param('id'), c.req.param('id').toUpperCase()).first<{ id: string }>();
  if (!match) return c.json({ error: 'Match not found.' }, 404);
  const member = await c.env.DB.prepare('SELECT uid FROM ranked_match_players WHERE match_id = ? AND uid = ?').bind(match.id, uid).first();
  if (!member) return c.json({ error: 'You are not a player in this match.' }, 403);
  // The client calls this before opening the socket, so a pending migration is shown as text here.
  const missing = await missingRankedColumns(c.env.DB);
  if (missing.length) return c.json({ error: `Ranked database migrations are pending: ${missing.join(', ')}. Run npm run db:migrate:remote.` }, 503);
  const { results } = await c.env.DB.prepare('SELECT * FROM ranked_match_players WHERE match_id = ?').bind(match.id).all();
  return c.json({ match, players: results });
});
// ─────────────────────────────────────────────────────────────────────────────
// Ranked leaderboards — public by nickname. No opt-in: ranked is competitive by
// design, and only nickname, tier, points, mastery counts and party W/L are shown.
// ─────────────────────────────────────────────────────────────────────────────
type RankedLeaderRow = { uid: string; displayName: string; tier: Level; points: number; masteredInTier: number; tierTotal: number; masteredTotal: number; curses: number; matches: number; wins: number };
const tierRank = (tier: Level) => TIERS.indexOf(tier);
const RANKED_LEADERBOARD_SORTS: Record<string, (a: RankedLeaderRow, b: RankedLeaderRow) => number> = {
  // Top Global: most ranked points. Ties: higher tier, then more mastery.
  points: (a, b) => b.points - a.points || tierRank(b.tier) - tierRank(a.tier) || b.masteredTotal - a.masteredTotal || a.displayName.localeCompare(b.displayName),
  // Top Rank: highest tier. Ties: closest to promotion, then points.
  tier: (a, b) => tierRank(b.tier) - tierRank(a.tier) || b.masteredInTier - a.masteredInTier || b.points - a.points || a.displayName.localeCompare(b.displayName),
};
export async function rankedLeaderboard(db: D1Database, by: 'points' | 'tier', uid: string, limit = 50) {
  const { results } = await db.prepare(
    `SELECT a.uid, u.nickname, a.tier, a.points, a.mastered, a.cursed,
            (SELECT COUNT(*) FROM ranked_match_players p JOIN ranked_matches m ON m.id = p.match_id WHERE p.uid = a.uid AND m.mode = 'party' AND m.status = 'complete') AS matches,
            (SELECT COUNT(*) FROM ranked_matches m WHERE m.winner_uid = a.uid AND m.mode = 'party' AND m.status = 'complete') AS wins
       FROM ranked_accounts a JOIN user_data u ON u.uid = a.uid
      WHERE TRIM(u.nickname) <> ''`,
  ).all<{ uid: string; nickname: string; tier: Level; points: number; mastered: string; cursed: string | null; matches: number; wins: number }>();
  const rows: RankedLeaderRow[] = results.map(r => {
    const mastered = parseJson<Record<string, string[]>>(r.mastered, {});
    const cursed = parseJson<Record<string, string[]>>(r.cursed, {});
    return { uid: r.uid, displayName: r.nickname, tier: r.tier, points: r.points,
      masteredInTier: mastered[r.tier]?.length ?? 0, tierTotal: tierWords(r.tier).length,
      masteredTotal: Object.values(mastered).flat().length, curses: Object.values(cursed).flat().length,
      matches: r.matches, wins: r.wins };
  });
  rows.sort(RANKED_LEADERBOARD_SORTS[by]);
  const index = rows.findIndex(r => r.uid === uid);
  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  return { by, total: rows.length, rows: ranked.slice(0, limit), me: index >= 0 ? ranked[index] : null };
}
app.get('/api/ranked/leaderboard', async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const by = c.req.query('by') === 'tier' ? 'tier' : 'points';
  return c.json(await rankedLeaderboard(c.env.DB, by, uid));
});
// Only verified, registered members are forwarded to the private Durable Object.
app.on(['GET', 'POST'], ['/api/ranked/matches/:id/ws', '/api/ranked/matches/:id/start'], async (c) => {
  const uid = await uidFromRequest(c.req.raw, c.env);
  const match = await c.env.DB.prepare('SELECT id, room_code, rules_version FROM ranked_matches WHERE id = ? OR room_code = ?').bind(c.req.param('id'), c.req.param('id').toUpperCase()).first<{ id: string; room_code: string; rules_version: number }>();
  if (!match) return c.json({ error: 'Match not found.' }, 404);
  if (match.rules_version !== 2 && match.rules_version !== RANKED_RULES_VERSION) return c.json({ error: 'This is an old room. Create a new invite room.' }, 409);
  const member = await c.env.DB.prepare('SELECT uid FROM ranked_match_players WHERE match_id = ? AND uid = ?').bind(match.id, uid).first();
  if (!member) return c.json({ error: 'You are not a player in this match.' }, 403);
  // Refuse before the socket opens: a schema mismatch would otherwise crash the room mid-round.
  const missing = await missingRankedColumns(c.env.DB);
  if (missing.length) return c.json({ error: `Ranked database migrations are pending: ${missing.join(', ')}. Run npm run db:migrate:remote.` }, 503);
  const target = new URL('https://match-room/' + (c.req.path.endsWith('/start') ? 'start' : 'ws'));
  target.searchParams.set('uid', uid); target.searchParams.set('matchId', match.id);
  target.searchParams.set('session', deviceSessionFromRequest(c.req.raw));
  if (!c.env.MATCH_ROOM) return c.json({ error: 'Ranked rooms are not configured. Add the MATCH_ROOM Durable Object binding.' }, 503);
  const room = c.env.MATCH_ROOM.get(c.env.MATCH_ROOM.idFromName(match.room_code));
  return room.fetch(new Request(target, c.req.raw));
});

// ─────────────────────────────────────────────────────────────────────────────
// Feedback — the "Report a problem" button in the footer (public, no login needed)
// ─────────────────────────────────────────────────────────────────────────────
const FEEDBACK_CATEGORIES = ['bug', 'wrong_answer', 'typo', 'other'];
const FEEDBACK_MAX_LEN = 2000;
const FEEDBACK_MAX_PER_HOUR = 3;

// Optional auth: if a valid Firebase token is present we record which uid sent
// the report; otherwise it is accepted as anonymous. Never blocks the report.
async function optionalUid(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const header = c.req.raw.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return await uidFromRequest(c.req.raw, c.env);
  } catch {
    return null;
  }
}

// Admin-only check. The token is the FEEDBACK_ADMIN_TOKEN env var set in the
// Cloudflare dashboard — it deliberately does NOT live in this repository.
function feedbackTokenOk(c: Context<{ Bindings: Env }>): boolean {
  const token = c.env.FEEDBACK_ADMIN_TOKEN;
  if (!token) return false;
  const given = (c.req.raw.headers.get('Authorization') ?? '').replace(/^Bearer /, '') || c.req.query('token') || '';
  return given.length > 0 && given === token;
}

app.post('/api/feedback', async (c) => {
  // Hard body cap: reject oversized requests BEFORE JSON.parse touches them,
  // so a malicious/huge payload can't burn CPU or memory on the free 10 ms budget.
  const declaredBytes = Number(c.req.raw.headers.get('content-length') ?? 0);
  if (declaredBytes > 16_384) return c.json({ error: 'Report is too large.' }, 413);

  const uid = await optionalUid(c);
  let body: { category?: unknown; page?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request.' }, 400);
  }
  const category = FEEDBACK_CATEGORIES.includes(String(body.category)) ? String(body.category) : 'bug';
  const message = String(body.message ?? '').trim();
  if (!message) return c.json({ error: 'Please write a short description first.' }, 400);
  if (message.length > FEEDBACK_MAX_LEN) return c.json({ error: `Please keep it under ${FEEDBACK_MAX_LEN} characters.` }, 400);
  const page = String(body.page ?? '').slice(0, 200);

  // Spam guard: at most FEEDBACK_MAX_PER_HOUR reports per hour, per IP
  // (and per user, when signed in). One cheap COUNT — fits the free-tier CPU budget.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback
     WHERE (ip = ? OR uid = ?) AND created_at > datetime('now', '-1 hour')`,
  ).bind(ip, uid).first<{ n: number }>();
  if (recent && recent.n >= FEEDBACK_MAX_PER_HOUR) {
    return c.json({ error: 'You have already sent a few reports recently. Please try again in an hour.' }, 429);
  }

  const nickname = uid
    ? ((await c.env.DB.prepare('SELECT name FROM nicknames WHERE uid = ?').bind(uid).first<{ name: string }>())?.name ?? '')
    : '';
  await c.env.DB.prepare(
    'INSERT INTO feedback (uid, nickname, ip, category, page, message) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(uid, nickname || null, ip, category, page, message).run();
  return c.json({ ok: true });
});

// Admin: list the newest reports (latest 200).
app.get('/api/feedback', async (c) => {
  if (!c.env.FEEDBACK_ADMIN_TOKEN) return c.json({ error: 'Feedback is not configured yet.' }, 503);
  if (!feedbackTokenOk(c)) return c.json({ error: 'Not found' }, 404);
  const { results } = await c.env.DB.prepare(
    'SELECT id, uid, nickname, ip, category, page, message, resolved, created_at FROM feedback ORDER BY id DESC LIMIT 200',
  ).all<{ id: number; uid: string | null; nickname: string | null; ip: string; category: string; page: string; message: string; resolved: number; created_at: string }>();
  return c.json({ items: results });
});

// Admin: toggle a report between resolved / open.
app.patch('/api/feedback/:id', async (c) => {
  if (!c.env.FEEDBACK_ADMIN_TOKEN) return c.json({ error: 'Feedback is not configured yet.' }, 503);
  if (!feedbackTokenOk(c)) return c.json({ error: 'Not found' }, 404);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid report id.' }, 400);
  await c.env.DB.prepare('UPDATE feedback SET resolved = 1 - resolved WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything else under /api -> 404 JSON (so the client never gets HTML back)
// ─────────────────────────────────────────────────────────────────────────────
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

/**
 * Anything that is NOT /api is your React app. Hand it to the static-asset layer,
 * which applies `not_found_handling: "single-page-application"` — that's what
 * makes client-side routes like /dashboard and /exam work on a hard refresh.
 * Without this, Hono's own 404 would win and you'd get "404 Not Found".
 */
app.notFound((c) => {
  const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;
  if (!assets) {
    // Wrangler only exposes the ASSETS binding on newer versions (Node 22+).
    // Without it, hard-refreshing a client route like /dashboard 404s.
    console.warn('ASSETS binding not available — upgrade to Node 22+ and wrangler@latest.');
    return c.text('Not found', 404);
  }
  return assets.fetch(c.req.raw);
});

export default app;
