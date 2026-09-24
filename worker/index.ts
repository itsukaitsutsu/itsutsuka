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
import { HttpError, uidFromRequest, type Env } from './auth';
import { MatchRoom } from './matchRoom';
import { getAccount, sanitizeLegacy, transferable } from './rankedAccounts';
import { higherRank } from './rankedPolicy';
import { RULES, RANKED_RULES_VERSION, TIERS, isValidReviewMs, lowerTier, type RankedAccount } from '../shared/ranked';
import type { Level } from '../shared/vocabulary';
import { tierWords } from './rankedQuestions';

export { MatchRoom };

const app = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

// Created by migrations/0001_init.sql. /api/health compares against this list.
const EXPECTED_TABLES = [
  'card_discovery', 'friend_requests', 'invites', 'leaderboard', 'nicknames', 'pairs',
  'ranked_accounts', 'ranked_match_events', 'ranked_match_players', 'ranked_matches', 'user_data', 'users',
];

app.onError((err, c) => {
  const status = (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode;
  if (status === 500) console.error(err);
  return c.json({ error: err.message || 'Something went wrong.' }, status);
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type UserDataRow = {
  uid: string;
  lists: string;
  active_id: string | null;
  custom_words: string;
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

// (table, column, migration) for every column added after 0001. Checked by /api/health and
// before a ranked room opens, so a forgotten `npm run db:migrate:remote` is reported clearly.
const EXPECTED_COLUMNS: Array<[string, string, string]> = [
  ['ranked_matches', 'mode', '0003_ranked_accounts.sql'],
  ['ranked_matches', 'rules_version', '0003_ranked_accounts.sql'],
  ['ranked_matches', 'review_ms', '0004_ranked_review_time.sql'],
  ['ranked_accounts', 'cursed', '0005_ranked_cursed_cards.sql'],
];
export async function missingRankedColumns(db: D1Database): Promise<string[]> {
  const missing: string[] = [];
  for (const table of new Set(EXPECTED_COLUMNS.map(([t]) => t))) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const present = new Set(results.map(r => r.name));
    for (const [t, column, migration] of EXPECTED_COLUMNS) if (t === table && !present.has(column)) missing.push(`${table}.${column} (apply migrations/${migration})`);
  }
  return missing;
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
    // Columns added by later migrations. A missing one only fails mid-match, so surface it here.
    const missingColumns = await missingRankedColumns(c.env.DB);
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
       updated_at = excluded.updated_at`,
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
  const body = await c.req.json<{ mode?: string; wagerType?: string; wagerPoints?: number; wagerCards?: number; count?: number; reviewMs?: number }>();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid ranked match settings.' }, 400);
  if (body.mode && body.mode !== 'solo' && body.mode !== 'party') return c.json({ error: 'Invalid mode.' }, 400);
  const mode = body.mode === 'solo' ? 'solo' : 'party';
  if (body.reviewMs !== undefined && !isValidReviewMs(body.reviewMs)) return c.json({ error: 'Review time must be 0–10 seconds in 0.5-second steps.' }, 400);
  const reviewMs = body.reviewMs ?? RULES.reviewMs;
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
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ranked_matches (id, room_code, host_uid, tier, wager_type, wager_points, wager_cards, created_at, mode, question_count, rules_version, review_ms) VALUES (?,?,?,?,?,?,?,?,?,?,3,?)').bind(id, code, uid, a.tier, wagerType, wagerPoints!, wagerCards!, nowIso(), mode, Math.min(count, tierWords(a.tier).length), reviewMs),
    c.env.DB.prepare('INSERT INTO ranked_match_players (match_id, uid, nickname) VALUES (?,?,?)').bind(id, uid, profile?.nickname || 'Player'),
  ]);
  return c.json({ ok: true, matchId: id, roomCode: code, tier: a.tier, wagerType, wagerPoints, wagerCards, reviewMs }, 201);
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
