// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { emptyMastered, progressKey } from '../shared/ranked';
import { tierWords } from '../worker/rankedQuestions';
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let sequence = 0;
beforeAll(async () => {
  const compiled = await build({ entryPoints: ['tests/helpers/rankedWorker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-03', d1Databases: ['DB'], durableObjects: { MATCH_ROOM: { className: 'TestMatchRoom', useSQLite: true } } });
  db = await mf.getD1Database('DB');
  for (const file of ['0001_init.sql', '0002_ranked_matches.sql', '0003_ranked_accounts.sql', '0004_ranked_review_time.sql', '0005_ranked_cursed_cards.sql']) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' ');
    await db.exec(sql);
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); });
async function room(options: { existingHost?: string; reviewMs?: number; count?: number; cards?: number; mode?: string; guestTier?: string; guestPoints?: number } = {}) {
  const id = `test-${++sequence}`, host = options.existingHost ?? `${id}-a`, guest = `${id}-b`;
  const mode = options.mode ?? 'party';
  const keys = tierWords('N5').slice(0, 10).map(progressKey);
  const a = { ...emptyMastered(), N5: keys.slice(0, 5) }, b = { ...emptyMastered(), N5: keys.slice(5) };
  await db.batch([
    ...(options.existingHost ? [] : [db.prepare('INSERT INTO ranked_accounts (uid, points, tier, mastered) VALUES (?,?,?,?)').bind(host, 100, 'N4', JSON.stringify(a))]),
    db.prepare('INSERT INTO ranked_accounts (uid, points, tier, mastered) VALUES (?,?,?,?)').bind(guest, options.guestPoints ?? 100, options.guestTier ?? 'N5', JSON.stringify(b)),
    db.prepare('INSERT INTO ranked_matches (id,room_code,host_uid,tier,wager_type,wager_points,wager_cards,created_at,mode,question_count,review_ms,rules_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,3)').bind(id, id, host, 'N4', options.cards ? 'cards_points' : 'points', mode === 'solo' ? 0 : 10, options.cards ?? 0, 'now', mode, options.count ?? 10, options.reviewMs ?? 3000),
    db.prepare('INSERT INTO ranked_match_players (match_id,uid,nickname) VALUES (?,?,?)').bind(id, host, 'Host'),
    ...(mode === 'solo' ? [] : [db.prepare('INSERT INTO ranked_match_players (match_id,uid,nickname) VALUES (?,?,?)').bind(id, guest, 'Guest')]),
  ]);
  const request = (path: string, uid = host, init: RequestInit = {}) => mf.dispatchFetch(`http://example.com/${path}?matchId=${id}&uid=${uid}`, init);
  const inspect = async () => (await request('inspect')).json() as Promise<any>;
  const sockets: any[] = [];
  const connect = async (uid: string) => {
    const res = await request('ws', uid, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!; ws.accept(); sockets.push(ws);
    let latest: any;
    const states: any[] = [];
    const errors: string[] = [];
    const acknowledgements = new Map<string, () => void>();
    const waiters = new Set<() => void>();
    ws.addEventListener('message', (event: any) => {
      const m = JSON.parse(event.data);
      if (m.type === 'test_sync_ack') acknowledgements.get(m.requestId)?.();
      if (m.type === 'error') errors.push(m.error);
      if (m.type === 'state') { latest = m.room; states.push(latest); for (const notify of waiters) notify(); }
    });
    const wait = (predicate: (state: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error('No matching room state: ' + JSON.stringify(latest))); }, 5000);
      const check = () => { if (latest && predicate(latest)) { clearTimeout(timeout); waiters.delete(check); resolve(latest); } };
      waiters.add(check); check();
    });
    const send = (payload: object) => ws.send(JSON.stringify(payload));
    send({ type: 'sync' }); await wait(s => s.matchId === id);
    const sync = () => new Promise<void>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { acknowledgements.delete(requestId); reject(new Error('Missing test sync acknowledgement')); }, 5000);
      acknowledgements.set(requestId, () => { clearTimeout(timer); acknowledgements.delete(requestId); resolve(); });
      send({ type: 'test_sync', requestId });
    });
    return { ws, wait, send, states, errors, sync, latest: () => latest };
  };
  const ca = await connect(host), cb = mode === 'solo' ? null : await connect(guest);
  const ready = async () => {
    ca.send({ type: 'ready', rulesVersion: 3, tier: ca.latest().tier, reviewMs: ca.latest().reviewMs }); await ca.wait(s => s.players[host].ready);
    if (cb) { cb.send({ type: 'ready', rulesVersion: 3, tier: cb.latest().tier, reviewMs: cb.latest().reviewMs }); await ca.wait(s => s.players[guest].ready); }
  };
  const start = async () => { await ready(); const res = await request('start', host, { method: 'POST' }); expect(res.status, await res.text()).toBe(200); await ca.wait(s => s.status === 'live'); };
  const answer = async (client: typeof ca, correct: boolean) => {
    const r = await inspect(), q = r.questions[r.questionIndex];
    client.send({ type: 'answer', questionIndex: r.questionIndex, questionId: q.id, selectedAnswerId: correct ? q.answerId : q.choices.find((c: any) => c.id !== q.answerId).id });
  };
  const expire = async () => { const res = await request('expire'); expect(res.status).toBe(200); };
  const balance = async (uid: string) => db.prepare('SELECT * FROM ranked_accounts WHERE uid = ?').bind(uid).first<any>();
  return { id, host, guest, request, inspect, connect, ca, cb: cb!, ready, start, answer, expire, balance, close: () => sockets.forEach(s => { try { s.close(); } catch { /* already closed */ } }) };
}
describe('real Durable Object + D1 ranked room', () => {
  it('shares tier/questions/choice order; waits for both, hides answers, rejects duplicate and stale inputs', async () => {
    const r = await room(); await r.start();
    const sa = await r.ca.wait(s => s.status === 'live'), sb = await r.cb.wait(s => s.status === 'live');
    expect(sa.tier).toBe('N5'); expect(sa.question).toEqual(sb.question); expect(sa.deadline).toBe(sb.deadline);
    expect(sa.answerId).toBeUndefined(); expect(sa.questions).toBeUndefined(); expect(sa.before).toBeUndefined();
    await r.answer(r.ca, true);
    const waiting = await r.cb.wait(s => s.players[r.host].answered);
    expect(waiting.questionIndex).toBe(0); expect(waiting.phase).toBe('question');
    expect(waiting.players[r.host].answer).toBeUndefined(); expect(waiting.players[r.host].selection).toBeUndefined(); expect(waiting.players[r.host].score).toBe(0);
    await r.answer(r.ca, false); await r.answer(r.cb, false);
    const review = await r.ca.wait(s => s.phase === 'review');
    expect(review.players[r.host].score).toBe(4); expect(review.players[r.guest].score).toBe(-2); expect(review.answerId).toBeDefined();
    const old = await r.inspect(); await r.expire(); await r.ca.wait(s => s.questionIndex === 1);
    r.ca.send({ type: 'answer', questionIndex: 0, questionId: old.questions[0].id, selectedAnswerId: old.questions[0].answerId });
    r.ca.send({ type: 'sync' }); await r.ca.wait(s => s.questionIndex === 1 && !s.players[r.host].answered);
    expect((await r.inspect()).players[r.host].answered).toBe(false); r.close();
  });
  it('late answers become timeouts, refresh preserves locks, and disconnects cannot stop the deadline', async () => {
    const r = await room(); await r.start(); await r.answer(r.ca, true); await r.ca.wait(s => s.players[r.host].answered);
    const again = await r.connect(r.host); expect((await again.wait(s => s.players[r.host].answered)).players[r.host].selection).toBeDefined();
    const current = await r.inspect(), q = current.questions[0];
    await r.request('late-answer', r.guest, { method: 'POST', body: JSON.stringify({ type: 'answer', questionIndex: 0, questionId: q.id, selectedAnswerId: q.answerId }) });
    const reviewed = await again.wait(s => s.phase === 'review');
    expect(reviewed.players[r.guest].answer.result).toBe('timeout'); expect(reviewed.players[r.guest].score).toBe(-1);
    r.cb.ws.close(); await r.expire(); await again.wait(s => s.questionIndex === 1);
    await r.expire(); const timeout = await again.wait(s => s.phase === 'review' && s.questionIndex === 1);
    expect(timeout.players[r.guest].mistakes).toBe(2); r.close();
  });
  it('ends the WHOLE round at four mistakes and settles points/cards exactly once', async () => {
    const r = await room({ cards: 2 }); await r.start();
    for (let i = 0; i < 4; i++) {
      await r.answer(r.ca, true); await r.answer(r.cb, false);
      await r.ca.wait(s => s.phase === 'review' && s.questionIndex === i);
      await r.expire(); await r.ca.wait(s => i === 3 ? s.status === 'complete' : s.questionIndex === i + 1);
    }
    const result = r.ca.latest(); expect(result.winnerUid).toBe(r.host); expect(result.endReason).toBe('mistakes'); expect(result.questionIndex).toBe(3);
    expect((await r.balance(r.host)).points).toBe(110); expect((await r.balance(r.guest)).points).toBe(90);
    expect(JSON.parse((await r.balance(r.host)).mastered).N5).toHaveLength(7);
    expect(JSON.parse((await r.balance(r.guest)).mastered).N5).toHaveLength(3);
    expect(result.results[r.host].gainedCards).toHaveLength(2);
    await r.request('replay-finish'); expect((await r.balance(r.host)).points).toBe(110); expect((await r.balance(r.host)).version).toBe(1);
    expect((await r.balance(r.host)).active_match).toBeNull(); r.close();
  });
  it('simultaneous four-timeout AFK keeps wagers but fines both players', async () => {
    const r = await room({ cards: 2 }); await r.start();
    for (let i = 0; i < 4; i++) { await r.expire(); await r.expire(); }
    const result = await r.ca.wait(s => s.status === 'complete');
    expect(result.winnerUid).toBeNull(); expect(result.endReason).toBe('afk'); expect((await r.balance(r.host)).points).toBe(95); expect((await r.balance(r.guest)).points).toBe(95);
    expect(JSON.parse((await r.balance(r.host)).mastered).N5).toHaveLength(5); r.close();
  });
  it('does not mark failed starts live and requires host, readiness, funds and card eligibility', async () => {
    const r = await room({ guestPoints: 0 });
    expect((await r.request('start', r.guest, { method: 'POST' })).status).toBe(409);
    expect((await r.request('start', r.host, { method: 'POST' })).status).toBe(409);
    await r.ready(); const failed = await r.request('start', r.host, { method: 'POST' }); expect(failed.status).toBe(409);
    expect((await r.balance(r.host)).active_match).toBeNull();
    expect((await db.prepare('SELECT status FROM ranked_matches WHERE id = ?').bind(r.id).first<any>()).status).toBe('lobby'); r.close();
    const cards = await room({ cards: 6 }); await cards.ready(); expect((await cards.request('start', cards.host, { method: 'POST' })).status).toBe(409); cards.close();
  });
  it('prevents nonmembers from opening a socket and rolls back partial account locks', async () => {
    const r = await room();
    // Browsers cannot read a non-101 body, so the refusal is delivered over the socket with a permanent close code.
    const refused = await r.request('ws', 'intruder', { headers: { Upgrade: 'websocket' } });
    expect(refused.status).toBe(101);
    const closed = await new Promise<{ code: number; reason: string; errors: string[] }>(resolve => {
      const ws = refused.webSocket!, errors: string[] = []; ws.accept();
      ws.addEventListener('message', (event: any) => { const m = JSON.parse(event.data); if (m.type === 'error') errors.push(m.error); });
      ws.addEventListener('close', (event: any) => resolve({ code: event.code, reason: event.reason, errors }));
    });
    expect(closed.code).toBe(4403); expect(closed.errors).toEqual(['You are not a player in this match.']); expect(closed.reason).toMatch(/not a player/);
    expect((await r.request('inspect')).status).toBe(200);
    await expect(db.batch([
      db.prepare('UPDATE ranked_accounts SET active_match = ? WHERE uid = ?').bind(r.id, r.host),
      db.prepare("UPDATE ranked_matches SET status = 'live' WHERE id = ?").bind(r.id),
    ])).rejects.toThrow();
    expect((await r.balance(r.host)).active_match).toBeNull(); r.close();
  });
  it('requires renewed consent if account tiers change before the host starts', async () => {
    const r = await room(); await r.ready();
    await db.prepare("UPDATE ranked_accounts SET tier = 'N4', version = version + 1 WHERE uid = ?").bind(r.guest).run();
    expect((await r.request('start', r.host, { method: 'POST' })).status).toBe(409);
    const changed = await r.ca.wait(s => s.tier === 'N4');
    expect(changed.players[r.host].ready).toBe(false); expect(changed.players[r.guest].ready).toBe(false);
    await r.cb.wait(s => s.tier === 'N4'); await r.start(); expect((await r.inspect()).tier).toBe('N4'); r.close();
  });
  it('rejects fabricated choices and completes a question-limit tie without moving balances', async () => {
    const r = await room({ count: 1 }); await r.start();
    const current = await r.inspect();
    r.ca.send({ type: 'answer', questionIndex: 0, questionId: current.questions[0].id, selectedAnswerId: 'forged' });
    r.ca.send({ type: 'sync' }); await r.ca.wait(s => s.phase === 'question' && !s.players[r.host].answered);
    expect((await r.inspect()).players[r.host].answered).toBe(false);
    await r.answer(r.ca, true); await r.answer(r.cb, true); await r.ca.wait(s => s.phase === 'review'); await r.expire();
    const result = await r.ca.wait(s => s.status === 'complete'); expect(result.endReason).toBe('questions'); expect(result.winnerUid).toBeNull();
    expect((await r.balance(r.host)).points).toBe(100); r.close();
  });
  it.each([1000, 1500, 10000])('uses the agreed %i ms review deadline for both players', async reviewMs => {
    const r = await room({ reviewMs }); await r.start();
    await r.answer(r.ca, true); await r.answer(r.cb, true);
    const a = await r.ca.wait(s => s.phase === 'review'), b = await r.cb.wait(s => s.phase === 'review');
    expect(a.reviewMs).toBe(reviewMs); expect(b.reviewMs).toBe(reviewMs);
    expect(a.deadline).toBe(b.deadline); expect(a.deadline - a.serverNow).toBeLessThanOrEqual(reviewMs);
    expect(a.deadline - a.serverNow).toBeGreaterThan(reviewMs - 500);
    await r.expire(); const next = await r.ca.wait(s => s.questionIndex === 1);
    expect(next.phase).toBe('question'); expect(next.deadline - next.serverNow).toBeGreaterThan(9500); r.close();
  });
  it('zero review waits for both answers, skips review frames, preserves zero on reconnect and rejects stale answers', async () => {
    const r = await room({ reviewMs: 0 }); await r.start();
    const old = await r.inspect(); await r.answer(r.ca, true); await r.ca.wait(s => s.players[r.host].answered);
    expect(r.ca.latest().questionIndex).toBe(0);
    const again = await r.connect(r.host); expect(again.latest().reviewMs).toBe(0);
    await r.answer(r.cb, false);
    const a = await again.wait(s => s.questionIndex === 1), b = await r.cb.wait(s => s.questionIndex === 1);
    expect(a.phase).toBe('question'); expect(a.question).toEqual(b.question); expect(a.deadline).toBe(b.deadline);
    expect(a.players[r.host].score).toBe(4); expect(a.players[r.guest].score).toBe(-2);
    expect(r.cb.states.some(s => s.status === 'live' && s.phase === 'review')).toBe(false);
    again.send({ type: 'answer', questionIndex: 0, questionId: old.questions[0].id, selectedAnswerId: old.questions[0].answerId });
    again.send({ type: 'sync' }); await again.wait(s => s.questionIndex === 1 && !s.players[r.host].answered);
    expect((await r.inspect()).players[r.host].answered).toBe(false); r.close();
  });
  it('zero review timeouts still end the whole round at four mistakes and settle once', async () => {
    const r = await room({ reviewMs: 0 }); await r.start();
    for (let i = 0; i < 4; i++) {
      await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === i && s.players[r.host].answered);
      await r.expire(); await r.ca.wait(s => i === 3 ? s.status === 'complete' : s.questionIndex === i + 1);
    }
    const result = r.ca.latest(); expect(result.endReason).toBe('afk'); expect(result.players[r.guest].mistakes).toBe(4);
    expect((await r.balance(r.guest)).points).toBe(85); expect(result.winnerUid).toBe(r.host); expect((await r.balance(r.host)).points).toBe(110);
    await r.request('replay-finish'); expect((await r.balance(r.host)).points).toBe(110); expect((await r.balance(r.host)).version).toBe(1); r.close();
  });
  it('zero review finishes the last question immediately and cannot be changed by an answer packet', async () => {
    const r = await room({ reviewMs: 0, count: 1 }); await r.start();
    const old = await r.inspect();
    r.ca.send({ type: 'answer', questionIndex: 0, questionId: old.questions[0].id, selectedAnswerId: old.questions[0].answerId, reviewMs: 10000 });
    await r.ca.wait(s => s.players[r.host].answered); await r.answer(r.cb, true);
    const result = await r.ca.wait(s => s.status === 'complete');
    expect(result.reviewMs).toBe(0); expect(result.endReason).toBe('questions'); expect(result.winnerUid).toBeNull();
    expect((await r.balance(r.host)).points).toBe(100); r.close();
  });
  it('requires consent to nondefault review timing, but old clients can still confirm default rooms', async () => {
    const custom = await room({ reviewMs: 0 });
    custom.ca.send({ type: 'ready', rulesVersion: 3, tier: custom.ca.latest().tier }); custom.ca.send({ type: 'sync' });
    await custom.ca.wait(s => !s.players[custom.host].ready);
    expect((await custom.inspect()).players[custom.host].ready).toBe(false); await custom.start(); custom.close();
    const legacy = await room(); legacy.ca.send({ type: 'ready', rulesVersion: 3, tier: legacy.ca.latest().tier });
    await legacy.ca.wait(s => s.players[legacy.host].ready); legacy.close();
  });
  it('defaults pre-feature durable snapshots to three seconds', async () => {
    const r = await room(); await r.request('remove-review-setting');
    r.ca.send({ type: 'sync' }); await r.ca.wait(s => s.reviewMs === 3000);
    await r.start(); expect((await r.inspect()).reviewMs).toBe(3000); r.close();
  });
  it.each(['party', 'solo'])('persists %s combo streaks through zero-review transitions and reconnects, caps at 5, and resets on mistakes/timeouts', async mode => {
    const r = await room({ mode, reviewMs: 0, count: 12 }); await r.start();
    for (let i = 0; i < 6; i++) {
      await r.answer(r.ca, true); if (mode === 'party') await r.answer(r.cb, true);
      const next = await r.ca.wait(s => s.questionIndex === i + 1);
      expect(next.players[r.host].combo).toBe(Math.min(i + 1, 5));
    }
    const again = await r.connect(r.host); expect(again.latest().players[r.host].combo).toBe(5);
    await r.answer(again, false); if (mode === 'party') await r.answer(r.cb, true);
    let next = await again.wait(s => s.questionIndex === 7); expect(next.players[r.host].combo).toBe(0);
    if (mode === 'party') await r.answer(r.cb, true);
    await r.expire(); next = await again.wait(s => s.questionIndex === 8); expect(next.players[r.host].combo).toBe(0);
    await r.answer(again, true); if (mode === 'party') await r.answer(r.cb, true);
    next = await again.wait(s => s.questionIndex === 9); expect(next.players[r.host].combo).toBe(1);
    expect(next.players[r.host].mistakes).toBe(2); r.close();
  });
  it('does not reveal combo changes until both players resolve the question', async () => {
    const r = await room({ reviewMs: 3000 }); await r.start();
    await r.answer(r.ca, true); const waiting = await r.cb.wait(s => s.players[r.host].answered);
    expect(waiting.players[r.host].combo).toBe(0);
    await r.answer(r.cb, true); const revealed = await r.ca.wait(s => s.phase === 'review');
    expect(revealed.players[r.host].combo).toBe(1); r.close();
  });
  it('aborts solo immediately, keeps already-graded rewards/penalties and releases its account once', async () => {
    const r = await room({ mode: 'solo', reviewMs: 0 }); await r.start();
    await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === 1);
    await r.answer(r.ca, false); await r.ca.wait(s => s.questionIndex === 2);
    const before = await r.inspect();
    r.ca.send({ type: 'abort' }); const result = await r.ca.wait(s => s.status === 'complete');
    expect(result.endReason).toBe('aborted'); expect(result.players[r.host].correct).toBe(1); expect(result.players[r.host].mistakes).toBe(1);
    expect(result.questionIndex).toBe(2); expect(result.deadline).toBeNull();
    const a = await r.balance(r.host); expect(a.points).toBe(102); expect(a.active_match).toBeNull();
    expect(JSON.parse(a.mastered)).toEqual(before.accounts[r.host].mastered);
    expect(await (await r.request('alarm-status')).json()).toBeNull();
    r.ca.send({ type: 'abort' }); await r.ca.sync(); await r.request('replay-finish');
    expect((await r.balance(r.host)).points).toBe(102); expect((await r.balance(r.host)).version).toBe(1);
    const saved = await db.prepare('SELECT result_json FROM ranked_matches WHERE id = ?').bind(r.id).first<any>();
    expect(JSON.parse(saved.result_json).endReason).toBe('aborted'); r.close();
  });
  it('does not add a timeout when solo abort is processed before the deadline alarm, and can abort during review', async () => {
    const r = await room({ mode: 'solo' }); await r.start();
    await r.request('expire-with-abort'); const empty = await r.ca.wait(s => s.status === 'complete');
    expect(empty.players[r.host].mistakes).toBe(0); expect((await r.balance(r.host)).points).toBe(100); r.close();
    const review = await room({ mode: 'solo', reviewMs: 10000 }); await review.start(); await review.answer(review.ca, true);
    await review.ca.wait(s => s.phase === 'review'); review.ca.send({ type: 'abort' });
    const saved = await review.ca.wait(s => s.status === 'complete'); expect(saved.endReason).toBe('aborted');
    expect((await review.balance(review.host)).points).toBe(104); review.close();
  });
  it.each([0, 10000])('ends a party only after explicit opponent acceptance and preserves both wagers with %i ms review', async reviewMs => {
    const r = await room({ reviewMs, cards: 2 }); await r.start();
    await r.answer(r.ca, true); await r.answer(r.cb, false); await r.ca.wait(s => reviewMs === 0 ? s.questionIndex === 1 : s.phase === 'review');
    const original = await r.inspect();
    r.ca.send({ type: 'surrender_request' }); const requested = await r.cb.wait(s => s.surrender?.status === 'pending');
    expect(requested.status).toBe('live'); expect(requested.deadline).toBe(original.deadline); expect((await r.balance(r.host)).active_match).toBe(r.id);
    const requestId = requested.surrender.id;
    r.cb.send({ type: 'surrender_accept', requestId }); const ended = await r.ca.wait(s => s.status === 'complete');
    await r.cb.wait(s => s.status === 'complete');
    expect(ended.endReason).toBe('surrender'); expect(ended.winnerUid).toBeNull(); expect(ended.surrender.respondedBy).toBe(r.guest);
    for (const uid of [r.host, r.guest]) {
      const a = await r.balance(uid); expect(a.points).toBe(100); expect(a.active_match).toBeNull();
      expect(JSON.parse(a.mastered)).toEqual(original.before[uid].mastered);
      expect(ended.results[uid].gainedCards).toEqual([]); expect(ended.results[uid].lostCards).toEqual([]);
    }
    r.cb.send({ type: 'surrender_accept', requestId }); await r.cb.sync(); await r.request('replay-finish');
    expect((await r.balance(r.host)).version).toBe(1); expect((await r.balance(r.guest)).version).toBe(1);
    expect(await (await r.request('alarm-status')).json()).toBeNull();
    const saved = JSON.parse((await db.prepare('SELECT result_json FROM ranked_matches WHERE id = ?').bind(r.id).first<any>()).result_json);
    expect(saved.surrender.requestedBy).toBe(r.host); expect(saved.surrender.respondedBy).toBe(r.guest); r.close();
  });
  it('requires the other player, rejects wrong/stale request IDs, and supports decline and withdrawal without pausing', async () => {
    const r = await room({ reviewMs: 0, count: 25 }); await r.start(); const deadline = (await r.inspect()).deadline;
    r.ca.send({ type: 'surrender_request' }); const request = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
    r.ca.send({ type: 'surrender_accept', requestId: request.id }); await r.ca.sync(); expect(r.ca.errors.at(-1)).toMatch(/opponent/);
    r.cb.send({ type: 'surrender_accept', requestId: 'wrong' }); await r.cb.sync(); expect(r.cb.errors.at(-1)).toMatch(/no longer pending/);
    r.cb.send({ type: 'surrender_cancel', requestId: request.id }); await r.cb.sync(); expect(r.cb.errors.at(-1)).toMatch(/requester/);
    // A second request is not acceptance, even when sent by the other player.
    r.cb.send({ type: 'surrender_request' }); await r.cb.sync(); expect((await r.inspect()).surrender.id).toBe(request.id);
    expect((await r.inspect()).status).toBe('live');
    r.cb.send({ type: 'surrender_decline', requestId: request.id }); await r.ca.wait(s => s.surrender?.status === 'declined');
    expect((await r.inspect()).deadline).toBe(deadline);
    r.ca.send({ type: 'surrender_request' }); await r.ca.sync(); expect(r.ca.errors.at(-1)).toMatch(/question 10/);
    for (let i = 0; i < 9; i++) { await r.answer(r.ca, true); await r.answer(r.cb, true); await r.ca.wait(s => s.questionIndex === i + 1); }
    const nextDeadline = (await r.inspect()).deadline;
    r.ca.send({ type: 'surrender_request' }); const next = (await r.cb.wait(s => s.surrender?.status === 'pending' && s.surrender.id !== request.id)).surrender;
    r.cb.send({ type: 'surrender_accept', requestId: request.id }); await r.cb.sync(); expect((await r.inspect()).status).toBe('live');
    r.ca.send({ type: 'surrender_cancel', requestId: next.id }); await r.ca.wait(s => s.surrender?.status === 'withdrawn');
    expect((await r.inspect()).deadline).toBe(nextDeadline); r.close();
  });
  it('continues deadlines and restores a pending surrender on reconnect; disconnected players cannot implicitly consent', async () => {
    const r = await room({ reviewMs: 0 }); await r.start();
    r.ca.send({ type: 'surrender_request' }); const pending = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
    r.cb.ws.close(); await r.expire(); await r.ca.wait(s => s.questionIndex === 1);
    expect(r.ca.latest().players[r.guest].mistakes).toBe(1); expect(r.ca.latest().status).toBe('live');
    const again = await r.connect(r.guest); expect(again.latest().surrender.id).toBe(pending.id);
    again.send({ type: 'surrender_accept', requestId: pending.id }); await r.ca.wait(s => s.status === 'complete');
    expect((await r.balance(r.host)).points).toBe(100); r.close();
  });
  it.each([0, 10000])('does not allow surrender to replace a decided result with %i ms review', async reviewMs => {
    const r = await room({ count: 1, reviewMs }); await r.start();
    r.ca.send({ type: 'surrender_request' }); const request = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
    await r.answer(r.ca, true); await r.answer(r.cb, false); const decided = await r.ca.wait(s => s.endReason === 'questions');
    expect(decided.surrender.status).toBe('expired');
    r.cb.send({ type: 'surrender_accept', requestId: request.id }); await r.cb.sync(); if (reviewMs > 0) expect(r.cb.errors.at(-1)).toMatch(/already ending/);
    await r.expire(); const complete = await r.ca.wait(s => s.status === 'complete');
    expect(complete.winnerUid).toBe(r.host); expect((await r.balance(r.host)).points).toBe(110); r.close();
  });
  it('rejects cross-mode actions and ignores late answers after early completion', async () => {
    const solo = await room({ mode: 'solo' }); await solo.start();
    solo.ca.send({ type: 'surrender_request' }); await solo.ca.sync(); expect(solo.ca.errors.at(-1)).toMatch(/Abort round/);
    const current = await solo.inspect(); solo.ca.send({ type: 'abort' }); await solo.ca.wait(s => s.status === 'complete');
    solo.ca.send({ type: 'answer', questionIndex: 0, questionId: current.questions[0].id, selectedAnswerId: current.questions[0].answerId }); await solo.ca.sync();
    expect((await solo.balance(solo.host)).points).toBe(100); expect(solo.ca.latest().players[solo.host].correct).toBe(0); solo.close();
    const party = await room(); await party.start(); party.ca.send({ type: 'abort' }); await party.ca.sync();
    expect(party.ca.errors.at(-1)).toMatch(/both players/); expect((await party.inspect()).status).toBe('live'); party.close();
  });
  it.each(['solo', 'party'] as const)('recovers interrupted %s early settlement without grading another question or settling twice', async mode => {
    const r = await room({ mode, reviewMs: 0 }); await r.start();
    let action: object = { type: 'abort' }, uid = r.host;
    if (mode === 'solo') {
      await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === 1);
    } else {
      await r.answer(r.ca, true); await r.ca.wait(s => s.players[r.host].answered);
      r.ca.send({ type: 'surrender_request' }); const request = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
      action = { type: 'surrender_accept', requestId: request.id }; uid = r.guest;
    }
    await r.request('interrupt-early-settlement', uid, { method: 'POST', body: JSON.stringify(action) });
    const intent = await r.inspect(); expect(intent.status).toBe('live'); expect(intent.endReason).toBe(mode === 'solo' ? 'aborted' : 'surrender');
    expect((await r.balance(r.host)).active_match).toBe(r.id);
    await r.expire(); const recovered = await r.ca.wait(s => s.status === 'complete');
    expect(recovered.players[r.host].correct).toBe(mode === 'solo' ? 1 : 0);
    expect(recovered.players[r.host].mistakes).toBe(0); expect((await r.balance(r.host)).points).toBe(mode === 'solo' ? 104 : 100);
    expect((await r.balance(r.host)).active_match).toBeNull();
    await r.request('replay-finish'); expect((await r.balance(r.host)).version).toBe(1);
    if (mode === 'party') { expect((await r.balance(r.guest)).points).toBe(100); expect((await r.balance(r.guest)).version).toBe(1); }
    r.close();
  });
  it('keeps the natural solo result if abort only skips the final answer review', async () => {
    const r = await room({ mode: 'solo', count: 1, reviewMs: 10000 }); await r.start();
    await r.answer(r.ca, true); await r.ca.wait(s => s.endReason === 'questions'); r.ca.send({ type: 'abort' });
    const completed = await r.ca.wait(s => s.status === 'complete'); expect(completed.endReason).toBe('questions');
    expect((await r.balance(r.host)).points).toBe(104); r.close();
  });
  it.each([20, 21])('uses the correct AFK fine and late bonus at question %i, then settles only once', async questionNumber => {
    const r = await room({ reviewMs: 0, count: 30, cards: 2 }); await r.start();
    for (let i = 0; i < questionNumber; i++) {
      await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === i && s.players[r.host].answered);
      if (i < questionNumber - 4) await r.answer(r.cb, true); else await r.expire();
      await r.ca.wait(s => i === questionNumber - 1 ? s.status === 'complete' : s.questionIndex === i + 1);
    }
    const final = r.ca.latest(), fine = questionNumber > 20 ? 10 : 5;
    expect(final.afk).toEqual({ uids: [r.guest], cause: 'timeouts', questionNumber, fine });
    expect((await r.balance(r.guest)).points).toBe(90 - fine);
    expect((await r.balance(r.host)).points).toBe(110 + (questionNumber > 20 ? questionNumber : 0));
    expect(JSON.parse((await r.balance(r.guest)).mastered).N5).toHaveLength(3);
    await r.request('replay-finish'); expect((await r.balance(r.host)).version).toBe(1); expect((await r.balance(r.guest)).version).toBe(1);
    expect((await r.balance(r.host)).active_match).toBeNull(); r.close();
  });
  it('resets the timeout streak with a submitted wrong answer but still ends at four TOTAL mistakes without an AFK fine', async () => {
    const r = await room({ reviewMs: 0 }); await r.start();
    for (let i = 0; i < 4; i++) {
      await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === i && s.players[r.host].answered);
      if (i === 2) await r.answer(r.cb, false); else await r.expire();
      await r.ca.wait(s => i === 3 ? s.status === 'complete' : s.questionIndex === i + 1);
      if (i === 2) expect(r.ca.latest().players[r.guest].timeoutStreak).toBe(0);
    }
    expect(r.ca.latest().endReason).toBe('mistakes'); expect(r.ca.latest().afk).toBeUndefined();
    expect((await r.balance(r.guest)).points).toBe(90); r.close();
  });
  it.each(['expire-consent', 'expire-both-deadlines'])('cannot accept an overdue surrender on %s, even when a question timer also needs processing', async endpoint => {
    const r = await room({ reviewMs: 10000 }); await r.start();
    r.ca.send({ type: 'surrender_request' }); const pending = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
    expect(pending.deadline - Date.now()).toBeGreaterThan(29000);
    expect(await (await r.request('alarm-status')).json()).toBe(Math.min((await r.inspect()).deadline, pending.deadline));
    r.ca.send({ type: 'surrender_request' }); await r.ca.sync(); expect((await r.inspect()).surrender.deadline).toBe(pending.deadline);
    // Ordinary answers and reconnects are not a response and do not extend consent time.
    await r.answer(r.cb, true); await r.cb.sync(); expect((await r.inspect()).surrender.deadline).toBe(pending.deadline);
    const again = await r.connect(r.guest); expect(again.latest().surrender.deadline).toBe(pending.deadline);
    await r.request(endpoint, r.guest, { method: 'POST', body: JSON.stringify({ type: 'surrender_accept', requestId: pending.id }) });
    const final = await r.ca.wait(s => s.status === 'complete'); expect(final.endReason).toBe('afk');
    expect(final.surrender.status).toBe('timed_out'); expect(final.afk.uids).toEqual([r.guest]);
    expect((await r.balance(r.guest)).points).toBe(85); expect((await r.balance(r.host)).points).toBe(110); r.close();
  });
  it('allows exactly three shared surrender opportunities at Q1/Q10/Q20', async () => {
    const r = await room({ reviewMs: 0, count: 25 }); await r.start();
    for (let i = 0; i < 21; i++) {
      if ([0, 9, 19].includes(i)) {
        const prevId = r.ca.latest().surrender?.id;
        r.ca.send({ type: 'surrender_request' }); const request = (await r.cb.wait(s => s.surrender?.status === 'pending' && s.surrender.id !== prevId)).surrender;
        if (i === 9) { r.ca.send({ type: 'surrender_cancel', requestId: request.id }); await r.ca.wait(s => s.surrender?.status === 'withdrawn'); }
        else { r.cb.send({ type: 'surrender_decline', requestId: request.id }); await r.ca.wait(s => s.surrender?.status === 'declined'); }
        r.cb.send({ type: 'surrender_request' }); await r.cb.sync(); expect(r.cb.errors.at(-1)).toMatch(i === 19 ? /No surrender requests/ : /unlocks/);
      }
      await r.answer(r.ca, true); await r.answer(r.cb, true); await r.ca.wait(s => s.questionIndex === i + 1);
    }
    expect((await r.inspect()).surrenderUsed).toBe(3);
    const again = await r.connect(r.guest); again.send({ type: 'surrender_request' }); await again.sync(); expect(again.errors.at(-1)).toMatch(/No surrender requests/);
    expect((await r.inspect()).status).toBe('live'); r.close();
  });
  it('adds curses to a higher-ranked loser, removes only capped owned misses, and never transfers those cards', async () => {
    const r = await room({ reviewMs: 0, cards: 2 });
    const hostBefore = await r.balance(r.host), owned = JSON.parse(hostBefore.mastered).N5;
    const keys = [owned[0], owned[1], owned[2], progressKey(tierWords('N5')[20])];
    // Guest repairs make these shared cards deterministic; host does not own these curses yet.
    await db.prepare('UPDATE ranked_accounts SET cursed = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: keys }), r.guest).run();
    await r.start(); const guestBefore = JSON.parse((await r.balance(r.guest)).mastered);
    for (let i = 0; i < 4; i++) {
      expect((await r.inspect()).questions[i].key).toBe(keys[i]);
      await r.answer(r.ca, false); await r.answer(r.cb, true); await r.ca.wait(s => i === 3 ? s.status === 'complete' : s.questionIndex === i + 1);
    }
    const final = r.ca.latest(); expect(final.winnerUid).toBe(r.guest); expect(final.endReason).toBe('mistakes');
    expect(final.results[r.host].lostCards).toEqual(keys.slice(0, 2));
    const hostAfter = await r.balance(r.host), guestAfter = await r.balance(r.guest);
    expect(JSON.parse(hostAfter.cursed).N5).toEqual(keys); expect(hostAfter.points).toBe(90);
    expect(JSON.parse(hostAfter.mastered).N5).toEqual(owned.slice(2));
    // Guest gets its four repairs, not two extra wager cards. Correct repair score is zero.
    expect(JSON.parse(guestAfter.mastered).N5).toEqual([...guestBefore.N5, ...keys]); expect(final.players[r.guest].score).toBe(0);
    expect(JSON.parse(guestAfter.cursed).N5).toEqual([]);
    await r.request('replay-finish'); expect((await r.balance(r.host)).version).toBe(1);
    const next = await room({ existingHost: r.host, mode: 'solo', reviewMs: 0 }); await next.start();
    expect((await next.inspect()).questions[0].key).toBe(keys[0]);
    await next.answer(next.ca, true); await next.ca.wait(s => s.questionIndex === 1); next.ca.send({ type: 'abort' }); await next.ca.wait(s => s.status === 'complete');
    expect((await next.balance(next.host)).points).toBe(90); expect(JSON.parse((await next.balance(next.host)).cursed).N5).toEqual(keys.slice(1));
    await r.request('replay-finish'); expect((await next.balance(next.host)).version).toBe(2);
    expect(JSON.parse((await next.balance(next.host)).cursed).N5).toEqual(keys.slice(1)); r.close(); next.close();
  });
  it('prioritizes personal cursed cards in a shared round, gives the opponent half score, and saves repair on surrender', async () => {
    const r = await room({ reviewMs: 0 }), key = progressKey(tierWords('N5')[25]);
    await db.prepare('UPDATE ranked_accounts SET cursed = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: [key] }), r.host).run();
    await r.start(); const q = (await r.inspect()).questions[0]; expect(q.key).toBe(key); expect(q.cursedFor).toEqual([r.host]);
    await r.answer(r.ca, true); await r.answer(r.cb, true); const graded = await r.ca.wait(s => s.questionIndex === 1);
    expect(graded.players[r.host].score).toBe(0); expect(graded.players[r.guest].score).toBe(2);
    r.ca.send({ type: 'surrender_request' }); const request = (await r.cb.wait(s => s.surrender?.status === 'pending')).surrender;
    r.cb.send({ type: 'surrender_accept', requestId: request.id }); await r.ca.wait(s => s.status === 'complete');
    expect((await r.balance(r.host)).points).toBe(100); expect((await r.balance(r.guest)).points).toBe(100);
    expect(JSON.parse((await r.balance(r.host)).cursed).N5).toEqual([]); expect(JSON.parse((await r.balance(r.host)).mastered).N5).toContain(key);
    expect(JSON.parse((await r.balance(r.guest)).mastered).N5).not.toContain(key); r.close();
  });
  it.each(['correct', 'incorrect', 'timeout'] as const)('applies zero account/score change to a solo cursed %s answer and saves on abort', async result => {
    const r = await room({ mode: 'solo', reviewMs: 0 }), key = progressKey(tierWords('N5')[26]);
    await db.prepare('UPDATE ranked_accounts SET cursed = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: [key] }), r.host).run();
    await r.start(); expect((await r.inspect()).questions[0].key).toBe(key);
    if (result === 'timeout') await r.expire(); else await r.answer(r.ca, result === 'correct');
    const graded = await r.ca.wait(s => s.questionIndex === 1); expect(graded.players[r.host].score).toBe(0);
    expect(graded.players[r.host].mistakes).toBe(result === 'correct' ? 0 : 1);
    r.ca.send({ type: 'abort' }); await r.ca.wait(s => s.status === 'complete');
    const a = await r.balance(r.host); expect(a.points).toBe(100);
    expect(JSON.parse(a.cursed).N5).toEqual(result === 'correct' ? [] : [key]);
    expect(JSON.parse(a.mastered).N5.includes(key)).toBe(result === 'correct'); r.close();
  });
  it('requires new-rule consent instead of accepting an old browser ready packet', async () => {
    const r = await room(); r.ca.send({ type: 'ready', tier: r.ca.latest().tier, reviewMs: 3000 }); await r.ca.sync();
    expect(r.ca.errors.at(-1)).toMatch(/rules changed/); expect((await r.inspect()).players[r.host].ready).toBe(false); r.close();
  });
  it('recovers a persisted AFK decision without repeating fines, wagers, or grading', async () => {
    const r = await room({ reviewMs: 0 }); await r.start();
    r.ca.send({ type: 'surrender_request' }); await r.cb.wait(s => s.surrender?.status === 'pending');
    await r.request('interrupt-afk-settlement', r.guest, { method: 'POST', body: '{}' });
    const saved = await r.inspect(); expect(saved.status).toBe('live'); expect(saved.endReason).toBe('afk');
    expect((await r.balance(r.guest)).points).toBe(100); expect((await r.balance(r.guest)).active_match).toBe(r.id);
    await r.expire(); const final = await r.ca.wait(s => s.status === 'complete');
    expect(final.players[r.guest].mistakes).toBe(0); expect((await r.balance(r.guest)).points).toBe(85);
    await r.request('replay-finish'); expect((await r.balance(r.guest)).version).toBe(1); expect((await r.balance(r.guest)).points).toBe(85); r.close();
  });
  it('does not retroactively apply AFK fines to pre-update live snapshots', async () => {
    const r = await room({ reviewMs: 0 }); await r.start(); await r.request('legacy-snapshot');
    for (let i = 0; i < 4; i++) await r.expire();
    const final = await r.ca.wait(s => s.status === 'complete'); expect(final.endReason).toBe('mistakes');
    expect((await r.balance(r.host)).points).toBe(100); expect((await r.balance(r.guest)).points).toBe(100); r.close();
  });
  it('does not turn the owner’s free repair into an account reward through the late AFK bonus', async () => {
    const r = await room({ reviewMs: 0, count: 25 }), key = progressKey(tierWords('N5')[30]);
    await db.prepare('UPDATE ranked_accounts SET cursed = ? WHERE uid = ?').bind(JSON.stringify({ ...emptyMastered(), N5: [key] }), r.host).run();
    await r.start();
    for (let i = 0; i < 21; i++) {
      await r.answer(r.ca, true); await r.ca.wait(s => s.questionIndex === i && s.players[r.host].answered);
      if (i < 17) await r.answer(r.cb, true); else await r.expire();
      await r.ca.wait(s => i === 20 ? s.status === 'complete' : s.questionIndex === i + 1);
    }
    expect(r.ca.latest().players[r.host].correct).toBe(21); expect(r.ca.latest().results[r.host].afkBonus).toBe(20);
    expect((await r.balance(r.host)).points).toBe(130); r.close();
  });
  it('grades solo on the server and credits new mastery to the same account balance', async () => {
    const r = await room({ mode: 'solo', count: 1 }); await r.start(); await r.answer(r.ca, true);
    await r.ca.wait(s => s.phase === 'review'); await r.expire(); await r.ca.wait(s => s.status === 'complete');
    expect((await r.balance(r.host)).points).toBe(104); expect(JSON.parse((await r.balance(r.host)).mastered).N4).toHaveLength(1); r.close();
  });

  it('keeps other players connected and reports the error when settlement fails on connect', async () => {
    const r = await room({ mode: 'solo', reviewMs: 0, count: 1 }); await r.start();
    // Break the settlement query the way a missed migration does, then let the deadline expire.
    await db.exec('ALTER TABLE ranked_accounts RENAME COLUMN cursed TO cursed_backup');
    let again!: Awaited<ReturnType<typeof r.connect>>;
    try {
      await r.request('expire');
      await r.ca.sync(); // Original socket is still open: the room did not reset.
      expect(r.ca.errors.at(-1)).toMatch(/cursed/);
      // A reconnecting player also stays connected and receives the message, instead of an opaque failure.
      again = await r.connect(r.host);
      expect(again.errors.at(-1)).toMatch(/cursed/); expect(again.latest().status).toBe('live');
      expect(await (await r.request('alarm-status')).json()).not.toBeNull();
    } finally { await db.exec('ALTER TABLE ranked_accounts RENAME COLUMN cursed_backup TO cursed'); }
    // Once the schema is repaired, the retry alarm settles the match without any client action.
    await r.expire(); const done = await again.wait(s => s.status === 'complete');
    expect(done.endReason).toBe('questions'); expect((await r.balance(r.host)).active_match).toBeNull(); r.close();
  });
});
