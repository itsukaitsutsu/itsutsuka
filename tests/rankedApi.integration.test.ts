// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { emptyMastered, progressKey } from '../shared/ranked';
import { tierWords } from '../worker/rankedQuestions';
let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeAll(async () => {
  const compiled = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], plugins: [{ name: 'test-auth-only', setup(builder) {
    builder.onLoad({ filter: /worker[\\/]auth\.ts$/ }, () => ({ contents: `
      export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
      export async function uidFromRequest(request) {
        const value = request.headers.get('Authorization');
        if (!value?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in.');
        return value.slice(7);
      }
    `, loader: 'js' }));
  } }] });
  mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-03', d1Databases: ['DB'], durableObjects: { MATCH_ROOM: { className: 'MatchRoom', useSQLite: true } } });
  db = await mf.getD1Database('DB');
  for (const file of ['0001_init.sql', '0002_ranked_matches.sql', '0003_ranked_accounts.sql', '0004_ranked_review_time.sql', '0005_ranked_cursed_cards.sql', '0007_ranked_quiz_type.sql']) {
    if (file === '0004_ranked_review_time.sql') {
      await db.prepare("INSERT INTO ranked_matches (id,room_code,host_uid,tier,wager_type,wager_points,created_at) VALUES ('pre-review','OLDROOM','old-host','N5','points',10,'before-update')").run();
    }
    await db.exec(readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); });
const call = (path: string, uid = '', body?: object, method = body ? 'POST' : 'GET') => mf.dispatchFetch(`http://example.com/api/ranked/${path}`, { method, headers: { ...(uid ? { Authorization: `Bearer ${uid}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function account(uid: string) { await call('account', uid, { points: 30, mastered: { ...emptyMastered(), N5: tierWords('N5').slice(0, 30).map(progressKey) } }); }
describe('ranked authenticated API and migrations', () => {
  it('migrates existing rooms to the unchanged 3-second default without changing their wager', async () => {
    const row = await db.prepare("SELECT review_ms, wager_points FROM ranked_matches WHERE id = 'pre-review'").first();
    expect(row).toEqual({ review_ms: 3000, wager_points: 10 });
  });
  it('requires authentication, initializes once, and never overwrites authoritative balances', async () => {
    expect((await call('account')).status).toBe(401);
    expect(await (await call('account', 'alice')).json()).toEqual({ account: null });
    await account('alice'); await call('account', 'alice', { points: 999999 });
    const result: any = await (await call('account', 'alice')).json(); expect(result.account.points).toBe(30); expect(result.account.tier).toBe('N5');
  });
  it('validates wagers/counts, ignores forged tiers, and supports solo at zero points', async () => {
    await account('host');
    for (const wagerPoints of [-1, 0, 1.1, '10', null]) expect((await call('matches', 'host', { wagerType: 'points', wagerPoints })).status).toBe(400);
    expect((await call('matches', 'host', { wagerType: 'cards_points', wagerPoints: 10, wagerCards: 0 })).status).toBe(400);
    expect((await call('matches', 'host', { wagerType: 'points', wagerPoints: 31 })).status).toBe(409);
    expect((await call('matches', 'host', { wagerType: 'points', wagerPoints: 10, count: 1.5 })).status).toBe(400);
    const match: any = await (await call('matches', 'host', { wagerType: 'points', wagerPoints: 10, tier: 'N1' })).json(); expect(match.tier).toBe('N5');
    await call('account', 'new', {}); expect((await call('matches', 'new', { mode: 'solo', count: 1 })).status).toBe(201);
  });
  it('persists validated review timing for party and solo; defaults to 3s', async () => {
    await account('timing');
    for (const reviewMs of [0, 500, 1500, 10000]) {
      const response = await call('matches', 'timing', { wagerType: 'points', wagerPoints: 10, reviewMs });
      expect(response.status).toBe(201); const match: any = await response.json(); expect(match.reviewMs).toBe(reviewMs);
      const saved: any = await (await call(`matches/${match.matchId}`, 'timing')).json(); expect(saved.match.review_ms).toBe(reviewMs);
    }
    for (const reviewMs of [-1, 10001, 10500, 1.5, 750, '1000', null, true]) {
      expect((await call('matches', 'timing', { wagerType: 'points', wagerPoints: 10, reviewMs })).status).toBe(400);
    }
    const defaultRoom: any = await (await call('matches', 'timing', { wagerType: 'points', wagerPoints: 10 })).json(); expect(defaultRoom.reviewMs).toBe(3000);
    const solo: any = await (await call('matches', 'timing', { mode: 'solo', count: 1, reviewMs: 0 })).json(); expect(solo.reviewMs).toBe(0);
    await expect(db.prepare('UPDATE ranked_matches SET review_ms = -1 WHERE id = ?').bind(defaultRoom.matchId).run()).rejects.toThrow();
  });
  it('stores curses only on the server, defaults them empty and does not let reset/import erase them', async () => {
    await account('cursed-account'); const key = progressKey(tierWords('N5')[50]);
    let response: any = await (await call('account', 'cursed-account')).json(); expect(response.account.cursed).toEqual(emptyMastered());
    await db.prepare('UPDATE ranked_accounts SET cursed = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: [key] }), 'cursed-account').run();
    await call('account', 'cursed-account', { cursed: emptyMastered(), points: 99999 });
    await call('account/reset', 'cursed-account', {});
    response = await (await call('account', 'cursed-account')).json(); expect(response.account.cursed.N5).toEqual([key]);
    expect(response.account.points).toBe(0);
    await call('account', 'fake-curses', { cursed: { ...emptyMastered(), N5: [key] } });
    expect((await (await call('account', 'fake-curses')).json() as any).account.cursed).toEqual(emptyMastered());
  });
  it('requires owned/eligible mastery before a card wager and stamps new rooms with policy 3', async () => {
    await account('cards-host'); await call('account', 'no-cards', {});
    expect((await call('matches', 'cards-host', { wagerType: 'cards_points', wagerPoints: 10, wagerCards: 31 })).status).toBe(409);
    const match: any = await (await call('matches', 'cards-host', { wagerType: 'cards_points', wagerPoints: 10, wagerCards: 2 })).json();
    await db.prepare('UPDATE ranked_accounts SET points = 100 WHERE uid = ?').bind('no-cards').run();
    expect((await call(`matches/${match.matchId}/join`, 'no-cards', {})).status).toBe(409);
    expect((await db.prepare('SELECT rules_version FROM ranked_matches WHERE id = ?').bind(match.matchId).first<any>()).rules_version).toBe(3);
    await db.prepare('UPDATE ranked_accounts SET mastered = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: tierWords('N5').slice(40, 45).map(progressKey) }), 'no-cards').run();
    expect((await call(`matches/${match.matchId}/join`, 'no-cards', {})).status).toBe(200);
  });
  it('handles concurrent joins atomically and lets existing members rejoin a full room', async () => {
    for (const uid of ['owner', 'guest-a', 'guest-b']) await account(uid);
    const match: any = await (await call('matches', 'owner', { wagerType: 'points', wagerPoints: 10 })).json();
    const responses = await Promise.all(['guest-a', 'guest-b'].map(uid => call(`matches/${match.roomCode}/join`, uid, {})));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await call(`matches/${match.matchId}/join`, 'owner', {})).status).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) n FROM ranked_match_players WHERE match_id = ?').bind(match.matchId).first<any>()).n).toBe(2);
    expect((await call(`matches/${match.matchId}`, 'outsider')).status).toBe(403);
    const ws = await mf.dispatchFetch(`http://example.com/api/ranked/matches/${match.matchId}/ws`, { headers: { Authorization: 'Bearer outsider', Upgrade: 'websocket' } }); expect(ws.status).toBe(403);
    // API must propagate the Durable Object's failure, not mark the DB live first.
    expect((await call(`matches/${match.matchId}/start`, 'owner', {})).status).toBe(409);
    expect((await db.prepare('SELECT status FROM ranked_matches WHERE id = ?').bind(match.matchId).first<any>()).status).toBe('lobby');
  });
  it('blocks resets during a live match without deleting the account or enabling re-import', async () => {
    await account('locked'); await db.prepare('UPDATE ranked_accounts SET active_match = ? WHERE uid = ?').bind('match', 'locked').run();
    expect((await call('account/reset', 'locked', {})).status).toBe(409);
    await db.prepare('UPDATE ranked_accounts SET active_match = NULL WHERE uid = ?').bind('locked').run();
    expect((await call('account/reset', 'locked', {})).status).toBe(200);
    await account('locked'); const result: any = await (await call('account', 'locked')).json(); expect(result.account.points).toBe(0);
  });

  it('ranked leaderboards list every nicknamed ranked account, sorted by points or by tier, with the caller\u2019s own rank', async () => {
    const n5 = tierWords('N5').map(progressKey);
    const seed = async (uid: string, nickname: string, tier: string, points: number, masteredInTier: number) => {
      await call('account', uid, {});
      await db.batch([
        db.prepare('UPDATE ranked_accounts SET tier = ?, points = ?, mastered = ? WHERE uid = ?').bind(tier, points, JSON.stringify({ ...emptyMastered(), [tier]: n5.slice(0, masteredInTier) }), uid),
        db.prepare("INSERT INTO user_data (uid, nickname, updated_at) VALUES (?,?,'now') ON CONFLICT(uid) DO UPDATE SET nickname = excluded.nickname").bind(uid, nickname),
      ]);
    };
    await seed('lb-a', 'Aki', 'N5', 500, 10);
    await seed('lb-b', 'Ben', 'N2', 40, 3);
    await seed('lb-c', 'Cho', 'N2', 90, 7);
    await seed('lb-d', '', 'N1', 9999, 0);            // no nickname: never listed
    await db.batch([
      db.prepare("INSERT INTO ranked_matches (id,room_code,host_uid,tier,wager_type,wager_points,created_at,mode,status,winner_uid,rules_version) VALUES ('lb-m1','LBM1','lb-b','N5','points',10,'now','party','complete','lb-b',3)"),
      db.prepare("INSERT INTO ranked_match_players (match_id,uid,nickname) VALUES ('lb-m1','lb-b','Ben'), ('lb-m1','lb-c','Cho')"),
    ]);
    const byPoints: any = await (await call('leaderboard?by=points', 'lb-c')).json();
    expect(byPoints.rows.map((r: any) => r.displayName)).toEqual(['Aki', 'Cho', 'Ben']);
    expect(byPoints.rows.map((r: any) => r.rank)).toEqual([1, 2, 3]);
    expect(byPoints.me).toMatchObject({ uid: 'lb-c', rank: 2, points: 90, tier: 'N2', masteredInTier: 7, matches: 1, wins: 0 });
    expect(byPoints.rows[2]).toMatchObject({ matches: 1, wins: 1 });
    expect(byPoints.total).toBe(3);
    const byTier: any = await (await call('leaderboard?by=tier', 'lb-a')).json();
    // N2 before N5; within N2, closer to promotion (7 > 3) first.
    expect(byTier.rows.map((r: any) => r.displayName)).toEqual(['Cho', 'Ben', 'Aki']);
    expect(byTier.me.rank).toBe(3);
    expect((await call('leaderboard', '')).status).toBe(401);
  });
});
