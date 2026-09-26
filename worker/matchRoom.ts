import { DurableObject } from 'cloudflare:workers';
import { RULES, RANKED_RULES_VERSION, SURRENDER_RESPONSE_MS, WS_CLOSE, surrenderWindow, emptyMastered, lowerTier, winner, shuffle, type BattleState, type PrivateQuestion, type RankedAccount, type CardRef, type QuizType } from '../shared/ranked';
import { higherRank, cursedPriorities, repairCard, curseDelta, applyHigherRankLoss } from './rankedPolicy';
import type { Level } from '../shared/vocabulary';
import { readRoom, writeRoom } from './roomStorage';
import { makeQuestions, tierWords } from './rankedQuestions';
import { applySoloAnswer, getAccount, resultOf, transferable } from './rankedAccounts';
export type MatchRoomEnv = { DB: D1Database };
/** An unrecoverable room condition. Clients should stop reconnecting and show the message. */
export class RoomError extends Error { constructor(message: string, public status = 409) { super(message); this.name = 'RoomError'; } }
/** Close reasons are limited to 123 UTF-8 bytes. */
export function closeReason(message: string): string {
  const bytes = new TextEncoder().encode(message);
  return bytes.length <= 120 ? message : new TextDecoder().decode(bytes.slice(0, 120)).replace(/\uFFFD+$/, '') + '…';
}
function rejectSocket(error: unknown): Response {
  const message = (error as Error).message || 'Room error.';
  const pair = new WebSocketPair(); pair[1].accept();
  pair[1].send(JSON.stringify({ type: 'error', error: message }));
  pair[1].close(error instanceof RoomError ? WS_CLOSE.permanent : WS_CLOSE.retryable, closeReason(message));
  return new Response(null, { status: 101, webSocket: pair[0] });
}
type Room = BattleState & { questions: PrivateQuestion[]; before: Record<string, RankedAccount>; accounts: Record<string, RankedAccount>; stakes: Record<string, string[]>; missed?: Record<string, CardRef[]>; repairs?: Record<string, CardRef[]> };
type MatchRow = { rules_version: number; id: string; room_code: string; host_uid: string; tier: Level; wager_type: 'points' | 'cards_points'; wager_points: number; wager_cards: number; mode: 'party' | 'solo'; question_count: number; review_ms: number; quiz_type: QuizType | null; status: BattleState['status']; result_json: string | null };
export class MatchRoom extends DurableObject<MatchRoomEnv> {
  private state: Room | null = null;
  constructor(ctx: DurableObjectState, env: MatchRoomEnv) { super(ctx, env); }
  // Serialize all events across D1 awaits. Durable storage remains the recovery source on errors.
  // Errors are returned as values, not thrown: an exception escaping blockConcurrencyWhile makes the
  // runtime reset the whole object, which drops EVERY player's WebSocket in this room.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.ctx.blockConcurrencyWhile(async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
      try { await this.reload(); return { ok: true, value: await fn() }; }
      catch (error) { this.state = null; return { ok: false, error }; }
    }).then(result => { if (result.ok) return result.value; throw result.error; });
  }
  private async reload() { this.state = (await readRoom<Room>(this.ctx.storage)) ?? null; }
  private async load(matchId?: string): Promise<Room> {
    if (this.state) {
      if (!this.state.before) throw new RoomError('This is a legacy room. Please create a new invite room.');
      this.state.reviewMs ??= RULES.reviewMs; // Existing durable snapshots keep the old 3-second default.
      this.state.quizType ??= 'meaning'; // Existing durable snapshots predate quiz types; they were all "choose meaning".
      return this.state;
    }
    if (!matchId) throw new RoomError('Room not initialized.');
    const row = await this.env.DB.prepare('SELECT * FROM ranked_matches WHERE id = ?').bind(matchId).first<MatchRow>();
    if (!row) throw new RoomError('Match not found.');
    if (row.status !== 'lobby') throw new RoomError('This old room cannot be resumed. Please create a new match.');
    this.state = { rulesVersion: row.rules_version, surrenderUsed: 0, matchId: row.id, roomCode: row.room_code, hostUid: row.host_uid, tier: row.tier, mode: row.mode,
      wagerType: row.wager_type, wagerPoints: row.wager_points, wagerCards: row.wager_cards, totalQuestions: row.question_count, reviewMs: row.review_ms ?? RULES.reviewMs,
      quizType: row.quiz_type ?? 'meaning', // Rows created before this column existed default to the original "choose meaning" quiz.
      status: 'lobby', phase: 'question', players: {}, questionIndex: 0, deadline: null, serverNow: 0, winnerUid: null,
      questions: [], accounts: {}, before: {}, stakes: {} };
    await this.syncLobby(); return this.state;
  }
  private async syncLobby() {
    const r = this.state!; if (r.status !== 'lobby') return;
    const { results } = await this.env.DB.prepare('SELECT uid, nickname FROM ranked_match_players WHERE match_id = ?').bind(r.matchId).all<{ uid: string; nickname: string }>();
    for (const row of results) r.players[row.uid] ??= { nickname: row.nickname, score: 0, correct: 0, mistakes: 0, combo: 0, answered: false, ready: false, connected: false };
    let tier: Level = 'N1';
    for (const uid of Object.keys(r.players)) tier = lowerTier(tier, (await getAccount(this.env.DB, uid)).tier);
    if (tier !== r.tier) { r.tier = tier; Object.values(r.players).forEach(p => p.ready = false); }
    r.totalQuestions = Math.min(r.totalQuestions, tierWords(tier).length);
    await this.env.DB.prepare('UPDATE ranked_matches SET tier = ? WHERE id = ? AND status = ?').bind(tier, r.matchId, 'lobby').run();
  }
  private connected(uid: string) { return this.ctx.getWebSockets().some(s => s.deserializeAttachment()?.uid === uid); }
  private publicRoom(uid: string): BattleState {
    const r = this.state!;
    const { questions, before, accounts, stakes, missed, repairs, ...safe } = r;
    const q = questions[r.questionIndex];
    // Once the round is being reviewed (or the match is over) it's safe to reveal everything.
    // Before that, only show the fields the current quiz type doesn't ask the player to guess —
    // e.g. for `word`/`reading` the true expression/reading must stay hidden since they ARE the
    // answer choices, or players could tell the correct choice just from the prompt.
    const revealed = r.phase === 'review' || r.status === 'complete';
    const prompt = revealed ? { expression: q?.expression, reading: q?.reading, meaning: q?.meaning }
      : r.quizType === 'word' ? { meaning: q?.meaning }
      : r.quizType === 'reading' ? { expression: q?.expression }
      : { expression: q?.expression, reading: q?.reading };
    return { ...safe, serverNow: Date.now(), question: r.status === 'live' && q ? { tier: q.tier ?? r.tier, cursedFor: q.cursedFor, id: q.id, prompt, choices: q.choices } : undefined,
      answerId: r.phase === 'review' ? q?.answerId : undefined,
      players: Object.fromEntries(Object.entries(r.players).map(([id, p]) => [id, { ...p, connected: this.connected(id),
        // Hide answer and score changes until both players lock in. No answer hints through opponent scores.
        selection: id === uid ? p.answer?.selectedAnswerId : undefined,
        answer: r.phase === 'review' || r.status === 'complete' ? p.answer : undefined }])) };
  }
  private broadcast() { for (const socket of this.ctx.getWebSockets()) { try { socket.send(JSON.stringify({ type: 'state', room: this.publicRoom(socket.deserializeAttachment().uid) })); } catch { /* disconnected */ } } }
  private nextAlarm() {
    const r = this.state!;
    if (r.status !== 'live') return null;
    const consent = !r.endReason && r.surrender?.status === 'pending' ? r.surrender.deadline : undefined;
    return consent ? Math.min(r.deadline ?? consent, consent) : r.deadline;
  }
  private async save() {
    const r = this.state!;
    await this.ctx.storage.transaction(async tx => {
      await writeRoom(tx, r);
      const alarm = this.nextAlarm();
      if (alarm !== null) await tx.setAlarm(alarm);
      else await tx.deleteAlarm();
    });
  }
  private async start(uid: string) {
    const r = this.state!;
    if (uid !== r.hostUid) throw new Error('Only the host can start the match.');
    if (r.status !== 'lobby') { if (r.status === 'live') return; throw new Error('This match has ended.'); }
    if (r.rulesVersion !== RANKED_RULES_VERSION) throw new Error('These rules changed. Create a new room.');
    await this.syncLobby();
    const ids = Object.keys(r.players);
    if (ids.length !== (r.mode === 'solo' ? 1 : 2) || ids.some(id => !this.connected(id) || !r.players[id].ready)) throw new Error('Both players must be connected and confirm the wager first.');
    for (const id of ids) {
      const a = await getAccount(this.env.DB, id);
      if (a.activeMatch) throw new Error('A player already has a live ranked round. Finish it first.');
      if (r.mode === 'party' && a.points < r.wagerPoints) throw new Error('Both players need enough ranked points for this wager.');
      r.before[id] = a;
    }
    r.accounts = structuredClone(r.before);
    for (const id of ids) {
      const opponent = r.before[ids.find(x => x !== id)!];
      const eligible = opponent && higherRank(r.before[id], opponent) ? r.before[id].mastered[r.tier] : opponent ? transferable(r.before[id], opponent, r.tier) : [];
      r.stakes[id] = r.wagerCards ? shuffle(eligible).slice(0, r.wagerCards) : [];
      if (r.stakes[id].length < r.wagerCards) throw new Error(`Both players must own ${r.wagerCards} eligible mastered ${r.tier} cards. Transferable stakes must be cards the opponent does not own. Try a points-only wager.`);
    }
    r.questions = makeQuestions(r.tier, r.totalQuestions, r.mode === 'solo' ? r.before[uid].mastered[r.tier] : [], cursedPriorities(r.before), r.quizType);
    r.missed = {}; r.repairs = {};
    r.totalQuestions = r.questions.length;
    r.status = 'live'; r.deadline = Date.now() + RULES.questionMs;
    // Save the recovery intent + alarm BEFORE the atomic D1 start. A crash can safely retry the same locks.
    await this.save();
    try { await this.commitStart(); }
    catch (e) {
      // Only a definite guard failure rolls back the intent. Network/DB outages retain
      // the live intent + alarm so recovery can determine whether D1 committed.
      if ((e as Error).message.includes('Ranked account changed')) {
        r.status = 'lobby'; r.deadline = null; r.questions = []; await this.save();
      }
      throw e;
    }
  }
  private async commitStart() {
    const r = this.state!;
    const row = await this.env.DB.prepare('SELECT status FROM ranked_matches WHERE id = ?').bind(r.matchId).first<{status: string}>();
    if (row?.status !== 'lobby') return;
    await this.env.DB.batch([
      ...Object.entries(r.before).map(([uid, a]) => this.env.DB.prepare('UPDATE ranked_accounts SET active_match = ? WHERE uid = ? AND version = ? AND active_match IS NULL').bind(r.matchId, uid, a.version)),
      this.env.DB.prepare("UPDATE ranked_matches SET status = 'live', started_at = ?, tier = ? WHERE id = ? AND status = 'lobby'").bind(new Date().toISOString(), r.tier, r.matchId),
    ]);
  }
  private record(uid: string, selected: string | null) {
    const r = this.state!, q = r.questions[r.questionIndex];
    const result = selected === null ? 'timeout' : selected === q.answerId ? 'correct' : 'incorrect';
    r.players[uid].answered = true;
    r.players[uid].answer = { selectedAnswerId: selected, result, delta: result === 'correct' ? 4 : result === 'incorrect' ? -2 : -1 };
  }
  private async review() {
    const r = this.state!;
    for (const [uid, p] of Object.entries(r.players)) {
      const a = p.answer!, q = r.questions[r.questionIndex], tier = q.tier ?? r.tier;
      const owner = !!q.cursedFor?.includes(uid);
      if (r.rulesVersion === RANKED_RULES_VERSION) a.delta = curseDelta(q, uid, a);
      p.score += a.delta;
      p.timeoutStreak = a.result === 'timeout' ? (p.timeoutStreak ?? 0) + 1 : 0;
      if (a.result === 'correct' && !owner) p.rewardCorrect = (p.rewardCorrect ?? 0) + 1;
      if (a.result !== 'correct') (r.missed ??= {})[uid] = [...(r.missed?.[uid] ?? []), { tier, key: q.key }];
      if (owner && a.result === 'correct') {
        const card = { tier, key: q.key }; repairCard(r.accounts[uid], card);
        (r.repairs ??= {})[uid] = [...(r.repairs?.[uid] ?? []), card];
      }
      p.combo = a.result === 'correct' ? Math.min((p.combo ?? 0) + 1, 5) : 0;
      if (a.result === 'correct') p.correct++; else p.mistakes++;
      if (r.mode === 'solo' && !owner) applySoloAnswer(r.accounts[uid], tier, q, a);
    }
    r.phase = 'review'; r.deadline = Date.now() + r.reviewMs;
    const afk = r.rulesVersion === RANKED_RULES_VERSION && r.mode === 'party' ? Object.keys(r.players).filter(uid => (r.players[uid].timeoutStreak ?? 0) >= 4) : [];
    if (afk.length) this.markAfk(afk, 'timeouts');
    else if (Object.values(r.players).some(p => p.mistakes >= RULES.mistakeLimit)) r.endReason = 'mistakes';
    else if (r.questionIndex + 1 >= r.totalQuestions) r.endReason = 'questions';
    if (r.endReason && r.surrender?.status === 'pending') r.surrender.status = 'expired';
    // Save grading first so an interrupted zero-delay transition can recover without scoring twice.
    await this.save();
    if (r.endReason === 'afk') await this.finish();
    else if (r.reviewMs === 0) await this.afterReview();
    else this.broadcast();
  }
  private async afterReview() {
    const r = this.state!;
    if (r.endReason) { await this.finish(); return; }
    r.questionIndex++; r.phase = 'question'; r.deadline = Date.now() + RULES.questionMs;
    Object.values(r.players).forEach(p => { p.answered = false; delete p.answer; });
    await this.save(); this.broadcast();
  }
  private async endEarly(reason: 'aborted' | 'surrender' | 'afk', uid?: string) {
    const r = this.state!;
    // An answer locked by just one party player has not been graded yet.
    if (r.phase === 'question') Object.values(r.players).forEach(p => { p.answered = false; delete p.answer; });
    r.endReason = reason; r.endedBy = uid; r.deadline = Date.now();
    // Persist intent + recovery alarm before D1 settlement. Retries never grade another question.
    await this.save(); this.broadcast();
    await this.finish();
  }
  private markAfk(uids: string[], cause: 'timeouts' | 'surrender') {
    const r = this.state!;
    r.endReason = 'afk'; r.afk = { uids, cause, questionNumber: r.questionIndex + 1, fine: r.questionIndex >= 20 ? 10 : 5 };
  }
  private async abortSolo(uid: string) {
    const r = this.state!;
    if (r.mode !== 'solo') throw new Error('Party matches require both players to agree to surrender.');
    if (r.status === 'complete') { this.broadcast(); return; }
    if (r.status !== 'live') throw new Error('There is no live round to abort.');
    await this.commitStart();
    // If the last question was already graded, keep its natural result.
    if (r.endReason) { await this.finish(); return; }
    await this.endEarly('aborted', uid);
  }
  private async handleSurrender(uid: string, action: string, requestId?: string) {
    const r = this.state!;
    if (r.mode !== 'party') throw new Error('Use Abort round for solo ranked.');
    if (r.status === 'complete') { this.broadcast(); return; }
    if (r.status !== 'live' || r.endReason) throw new Error('This round is already ending or has not started.');
    if (action === 'surrender_request') {
      // Repeated or simultaneous requests are not a second player's acceptance.
      if (r.surrender?.status !== 'pending') {
        if (r.rulesVersion === RANKED_RULES_VERSION) {
          const window = surrenderWindow(r.questionIndex + 1, r.surrenderUsed);
          if (!window.available) throw new Error(window.nextQuestion ? `Surrender unlocks at question ${window.nextQuestion}.` : 'No surrender requests remain. Finish the match.');
          r.surrenderUsed = window.slot + 1;
        }
        r.surrender = { id: crypto.randomUUID(), requestedBy: uid, status: 'pending', ...(r.rulesVersion === RANKED_RULES_VERSION ? { deadline: Date.now() + SURRENDER_RESPONSE_MS } : {}) };
      }
    } else {
      const request = r.surrender;
      if (!request || request.status !== 'pending' || request.id !== requestId) throw new Error('This surrender request is no longer pending.');
      if (action === 'surrender_cancel') {
        if (request.requestedBy !== uid) throw new Error('Only the requester can withdraw this request.');
        request.status = 'withdrawn'; request.respondedBy = uid;
      } else {
        if (request.requestedBy === uid) throw new Error('Your opponent must respond to your surrender request.');
        request.respondedBy = uid;
        if (action === 'surrender_accept') {
          request.status = 'accepted'; await this.endEarly('surrender', uid); return;
        }
        request.status = 'declined';
      }
    }
    // Do not pause/reset the shared deadline while waiting for consent.
    await this.save(); this.broadcast();
  }
  private async finish() {
    const r = this.state!;
    r.winnerUid = r.endReason === 'surrender' ? null : r.afk ? Object.keys(r.players).find(uid => !r.afk!.uids.includes(uid)) ?? null : winner(r.players);
    if (r.surrender?.status === 'pending') r.surrender.status = 'expired';
    if (r.mode === 'party') {
      r.accounts = structuredClone(r.before);
      for (const [uid, repairs] of Object.entries(r.repairs ?? {})) for (const card of repairs) repairCard(r.accounts[uid], card);
      if (r.winnerUid) {
        const win = r.winnerUid, lose = Object.keys(r.players).find(id => id !== win)!;
        r.accounts[win].points += r.wagerPoints; r.accounts[lose].points -= r.wagerPoints;
        if (r.rulesVersion === RANKED_RULES_VERSION && higherRank(r.before[lose], r.before[win])) {
          applyHigherRankLoss(r.accounts[lose], r.before[lose], r.missed?.[lose] ?? [], r.wagerCards);
        } else {
          const cards = r.stakes[lose];
          r.accounts[lose].mastered[r.tier] = r.accounts[lose].mastered[r.tier].filter(k => !cards.includes(k));
          r.accounts[win].mastered[r.tier] = [...new Set([...r.accounts[win].mastered[r.tier], ...cards])];
        }
        // Wagers transfer mastery, not earned tier promotions; solo mastery can promote the account.
      }
    }
    if (r.afk) {
      for (const uid of r.afk.uids) r.accounts[uid].points -= r.afk.fine;
      if (r.afk.questionNumber > 20 && r.winnerUid) r.accounts[r.winnerUid].points += r.players[r.winnerUid].rewardCorrect ?? r.players[r.winnerUid].correct;
    }
    r.results = Object.fromEntries(Object.keys(r.players).map(uid => [uid, resultOf(r.before[uid], r.accounts[uid])]));
    if (r.afk) for (const [uid, result] of Object.entries(r.results)) {
      result.afkFine = r.afk.uids.includes(uid) ? r.afk.fine : 0;
      result.afkBonus = r.afk.questionNumber > 20 && uid === r.winnerUid ? r.players[uid].rewardCorrect ?? r.players[uid].correct : 0;
    }
    const now = new Date().toISOString();
    // active_match is the idempotency key. A retry after a DO restart cannot transfer the wager twice.
    await this.env.DB.batch([
      ...Object.entries(r.players).flatMap(([uid, p]) => {
        const a = r.accounts[uid], result = r.results![uid];
        return [this.env.DB.prepare('UPDATE ranked_accounts SET points = ?, tier = ?, mastered = ?, cursed = ?, version = version + 1, active_match = NULL WHERE uid = ? AND active_match = ?').bind(a.points, a.tier, JSON.stringify(a.mastered), JSON.stringify(a.cursed ?? emptyMastered()), uid, r.matchId),
          this.env.DB.prepare('UPDATE ranked_match_players SET score = ?, correct = ?, mistakes = ?, points_before = ?, points_after = ?, cards_before = ?, cards_after = ?, finished_at = ? WHERE match_id = ? AND uid = ? AND EXISTS (SELECT 1 FROM ranked_matches WHERE id = ? AND status = \'live\')').bind(p.score, p.correct, p.mistakes, result.pointsBefore, result.pointsAfter, result.cardsBefore, result.cardsAfter, now, r.matchId, uid, r.matchId)];
      }),
      this.env.DB.prepare("UPDATE ranked_matches SET status = 'complete', winner_uid = ?, result_json = ?, finished_at = ? WHERE id = ? AND status = 'live'").bind(r.winnerUid, JSON.stringify({ results: r.results, endReason: r.endReason, endedBy: r.endedBy, surrender: r.surrender, afk: r.afk, rulesVersion: r.rulesVersion }), now, r.matchId),
    ]);
    r.status = 'complete'; r.deadline = null; await this.save(); this.broadcast();
  }
  private async tick() {
    const r = this.state!;
    if (r.status !== 'live') return;
    try { await this.commitStart(); } catch (e) {
      if (!(e as Error).message.includes('Ranked account changed')) throw e;
      r.status = 'lobby'; r.deadline = null; await this.save(); this.broadcast(); return;
    }
    // A saved early-ending intent must settle before any further answer/timeout grading.
    if (r.endReason === 'aborted' || r.endReason === 'surrender' || r.endReason === 'afk') { await this.finish(); return; }
    const consent = !r.endReason && r.surrender?.status === 'pending' ? r.surrender : undefined;
    // Process the earliest deadline, independently of connection state. On equal deadlines consent expires first.
    if (consent?.deadline && Date.now() >= consent.deadline && (!r.deadline || consent.deadline <= r.deadline)) {
      consent.status = 'timed_out';
      const uid = Object.keys(r.players).find(uid => uid !== consent.requestedBy)!;
      this.markAfk([uid], 'surrender'); await this.endEarly('afk'); return;
    }
    if (!r.deadline) return;
    if (Date.now() < r.deadline) { await this.ctx.storage.setAlarm(this.nextAlarm()!); return; }
    if (r.phase === 'question') {
      for (const [id, p] of Object.entries(r.players)) if (!p.answered) this.record(id, null);
      await this.review();
    } else await this.afterReview();
    // An overdue question may have been earlier than the consent deadline. Recheck before accepting any message.
    if (r.status === 'live' && !r.endReason && r.surrender?.status === 'pending' && r.surrender.deadline && r.surrender.deadline <= Date.now()) await this.tick();
  }
  async alarm() {
    try { await this.exclusive(async () => { await this.load(); await this.tick(); }); }
    catch (error) {
      if (error instanceof RoomError) { console.error('Ranked room cannot recover', error); return; }
      console.error('Ranked room recovery will retry', error);
      await this.ctx.storage.setAlarm(Date.now() + 10000);
    }
  }
  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      const url = new URL(request.url), uid = url.searchParams.get('uid');
      const upgrade = url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      let r: Room;
      try {
        r = await this.load(url.searchParams.get('matchId') ?? undefined);
        await this.syncLobby(); await this.save(); this.broadcast();
        if (!uid || !r.players[uid]) throw new RoomError('You are not a player in this match.', 403);
      } catch (error) {
        // A browser cannot read a non-101 body for a WebSocket upgrade: it only sees an opaque
        // failure and retries forever. Hand the message over the socket instead.
        if (upgrade) return rejectSocket(error);
        return Response.json({ error: (error as Error).message }, { status: error instanceof RoomError ? error.status : 409 });
      }
      if (url.pathname === '/start' && request.method === 'POST') {
        try { await this.tick(); await this.start(uid); await this.save(); this.broadcast(); return Response.json({ ok: true, status: r.status }); }
        catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }); }
      }
      if (!upgrade) return new Response('Expected WebSocket upgrade.', { status: 426 });
      // Accept FIRST. Connecting must never depend on D1 settlement succeeding: a failing tick is
      // reported over the socket and retried by the alarm, while the player still sees the room.
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); pair[1].serializeAttachment({ uid });
      // Replace stale/multi-tab connections without creating duplicate players.
      for (const s of this.ctx.getWebSockets()) if (s !== pair[1] && s.deserializeAttachment()?.uid === uid) s.close(WS_CLOSE.replaced, 'Opened in another tab');
      try { await this.tick(); }
      catch (error) {
        console.error('Ranked room tick failed during connect; alarm will retry', error);
        // Discard partially applied in-memory changes; durable storage is the source of truth.
        try { await this.reload(); await this.load(url.searchParams.get('matchId') ?? undefined); } catch { /* reported below through the same frame */ }
        try { pair[1].send(JSON.stringify({ type: 'error', error: (error as Error).message })); } catch { /* disconnected */ }
        if (!this.state) { pair[1].close(WS_CLOSE.retryable, closeReason((error as Error).message)); return new Response(null, { status: 101, webSocket: pair[0] }); }
        await this.ctx.storage.setAlarm(Date.now() + 10000);
      }
      this.broadcast(); return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const uid = socket.deserializeAttachment()?.uid as string | undefined;
    if (!uid || typeof raw !== 'string' || raw.length > 2048) return;
    try { await this.handleMessage(socket, uid, raw); }
    catch (error) { try { socket.send(JSON.stringify({ type: 'error', error: (error as Error).message })); } catch { /* disconnected */ } }
  }
  private async handleMessage(socket: WebSocket, uid: string, raw: string) {
    await this.exclusive(async () => {
      try {
        const r = await this.load();
        const p = r.players[uid]; if (!p) return;
        const m = JSON.parse(raw) as { rulesVersion?: number; requestId?: string; reviewMs?: number; tier?: string; type?: string; questionIndex?: number; questionId?: string; selectedAnswerId?: string };
        // Abort keeps only already-graded solo answers; it does not synthesize a timeout.
        if (m.type === 'abort') { await this.abortSolo(uid); return; }
        await this.tick();
        if (m.type === 'surrender_request' || m.type === 'surrender_accept' || m.type === 'surrender_decline' || m.type === 'surrender_cancel') {
          await this.handleSurrender(uid, m.type, m.requestId); return;
        }
        if (m.type === 'ready' && r.status === 'lobby') {
          if (r.rulesVersion === RANKED_RULES_VERSION && m.rulesVersion !== RANKED_RULES_VERSION) throw new Error('Ranked rules changed. Refresh and accept the AFK and cursed-card rules.');
          await this.syncLobby();
          if (m.tier !== r.tier) { await this.save(); this.broadcast(); throw new Error('The room tier changed. Review the settings and confirm again.'); }
          // Older clients may confirm only the unchanged default. Custom timing must be visible and acknowledged.
          if ((m.reviewMs ?? RULES.reviewMs) !== r.reviewMs) {
            await this.save(); this.broadcast(); throw new Error('Review time differs from the settings you confirmed. Reload the page and confirm again.');
          }
          p.ready = true; await this.save(); this.broadcast();
        }
        else if (m.type === 'answer' && r.status === 'live' && r.phase === 'question' && !p.answered && m.questionIndex === r.questionIndex && m.questionId === r.questions[r.questionIndex].id && r.questions[r.questionIndex].choices.some(c => c.id === m.selectedAnswerId)) {
          this.record(uid, m.selectedAnswerId!);
          if (Object.values(r.players).every(p => p.answered)) await this.review();
          else { await this.save(); this.broadcast(); }
        } else socket.send(JSON.stringify({ type: 'state', room: this.publicRoom(uid) }));
      } catch (error) { socket.send(JSON.stringify({ type: 'error', error: (error as Error).message })); }
    });
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    try { socket.close(code, reason); } catch { /* already closed */ }
    try { await this.exclusive(async () => { if (this.state) this.broadcast(); }); } catch { /* storage unreadable; nothing to announce */ }
  }
  async webSocketError(socket: WebSocket) { await this.webSocketClose(socket, 1011, 'Connection error'); }
}
