import { useEffect, useRef, useState } from 'react';
import { auth } from '@/utils/firebase/client';
import { Check, Clock3, Copy, Swords, Trophy, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import { playUserSound, type SoundSlot } from '@/lib/soundSettings';
import { SoundMuteToggle } from '@/components/SoundSettings';
import { useMarkSeen, useRankedLibrarySync } from '@/components/CardProgress';
import { wordProgressKey } from '@/lib/cardProgress';
import { feedbackAudio, playFeedback } from '@/lib/vocabulary';
import { RULES, RANKED_RULES_VERSION, WS_CLOSE, surrenderWindow, reviewTimeLabel, type BattleState } from '../../shared/ranked';
export type RankedBattleState = BattleState;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const MAX_BACKOFF_MS = 10000;

export function RankedBattle({ matchId, playerId, onExit }: { matchId: string; playerId: string; onExit: () => void }) {
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState<BattleState | null>(null);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ questionId: string; choice: string } | null>(null);
  const pendingRef = useRef<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [consentLeft, setConsentLeft] = useState(0);
  const [starting, setStarting] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const offset = useRef(0);
  const sounded = useRef<{ scope: string; answered: number } | null>(null);
  const me = state?.players[playerId];
  const question = state?.question;
  const selected = me?.selection ?? (pending?.questionId === question?.id ? pending?.choice : undefined);
  const online = connection === 'connected';
  const endingEarly = state?.status === 'live' && (state.endReason === 'aborted' || state.endReason === 'surrender' || state.endReason === 'afk');
  const canAnswer = !endingEarly && !(controlBusy && state?.mode === 'solo') && online && state?.status === 'live' && state.phase === 'question' && !me?.answered && !pending && timeLeft > 0;

  useEffect(() => {
    let alive = true, retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The last message the server sent over the socket. A generic transport error must not hide it.
    let serverError = '';
    setState(null); setControlBusy(false); setPending(null); pendingRef.current = null; setError(''); setConnection('connecting'); setAttempt(0);
    const retry = () => { setConnection('reconnecting'); setAttempt(retries + 1); timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, MAX_BACKOFF_MS)); };
    const connect = async () => {
      try {
        // HTTP preflight surfaces auth/membership/migration errors instead of an opaque WS failure.
        const snapshot = await api.rankedMatch(matchId);
        const room = snapshot.match;
        const resumableLegacy = room?.rules_version === 2 && (room.status === 'live' || room.status === 'complete');
        if (room && room.rules_version !== RANKED_RULES_VERSION && !resumableLegacy) {
          throw new Error('This room uses unsupported rules. Please exit and create a new room.');
        }
        const token = await auth.currentUser?.getIdToken();
        if (!alive) return;
        if (!token) throw new Error('Please sign in again.');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/api/ranked/matches/${encodeURIComponent(matchId)}/ws?token=${encodeURIComponent(token)}`);
        socket.current = ws;
        ws.onopen = () => { if (alive) { retries = 0; serverError = ''; setConnection('connected'); setError(''); setAttempt(0); } };
        ws.onmessage = event => {
          if (!alive || socket.current !== ws) return;
          try {
            const message = JSON.parse(event.data) as { type: string; room?: BattleState; error?: string };
            if (message.type === 'state' && message.room) {
              offset.current = message.room.serverNow - Date.now();
              setState(message.room); setControlBusy(false);
              const room = message.room;
              setPending(previous => previous?.questionId === room.question?.id && room.phase === 'question' && !room.players[playerId]?.answered ? previous : null);
              if (room.phase !== 'question' || room.players[playerId]?.answered || pendingRef.current !== room.question?.id) pendingRef.current = null;
            } else if (message.type === 'error') { serverError = message.error || 'Room error.'; setError(serverError); setControlBusy(false); setPending(null); pendingRef.current = null; }
          } catch { /* ignore malformed frames */ }
        };
        ws.onclose = event => {
          if (!alive || socket.current !== ws) return;
          setControlBusy(false); setPending(null); pendingRef.current = null;
          if (event.code === 4001) { setConnection('closed'); setError('This match was opened in another tab. Close that tab and reload here to reconnect.'); return; }
          // The server explained why it refused this room; retrying cannot change the answer.
          if (event.code === WS_CLOSE.permanent) { setConnection('closed'); setError(serverError || event.reason || 'This room is unavailable.'); return; }
          // Server-side error (database, settlement). Keep its message visible while backing off.
          if (event.code === WS_CLOSE.retryable) { setError(serverError || event.reason || 'The room hit a server error. Retrying…'); retry(); return; }
          if (!serverError) setError(retries >= 2 ? 'Still trying to reach the match server. Check your connection; the server timer continues.' : 'Connection interrupted. Reconnecting automatically…');
          retry();
        };
        ws.onerror = () => { if (alive && !serverError) setError('Connection interrupted. Reconnecting automatically…'); };
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        if (e instanceof TypeError || (e instanceof ApiError && (e.status >= 500 || e.status === 0))) retry();
        else setConnection('closed');
      }
    };
    void connect();
    return () => { alive = false; clearTimeout(timer); socket.current?.close(); socket.current = null; };
  }, [matchId, playerId]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now() + offset.current;
      setTimeLeft(state?.deadline ? Math.max(0, Math.ceil((state.deadline - now) / 1000)) : 0);
      setConsentLeft(state?.surrender?.deadline ? Math.max(0, Math.ceil((state.surrender.deadline - now) / 1000)) : 0);
    };
    tick(); const timer = setInterval(tick, 100); return () => clearInterval(timer);
  }, [state?.deadline, state?.surrender?.deadline]);
  useEffect(() => {
    if (!me) return;
    const scope = `${matchId}:${playerId}`;
    const answered = me.correct + me.mistakes;
    const previous = sounded.current;
    sounded.current = { scope, answered };

    // Seed from the initial snapshot without replaying an old answer on refresh.
    // Use resolved-answer counts, not review phase: zero review skips that phase.
    if (!previous || previous.scope !== scope || answered <= previous.answered || me.combo === undefined) return;

    const combo = Math.min(Math.max(me.combo, 0), 5);
    const correct = combo > 0;
    const slot: SoundSlot = correct ? `quizCombo${combo}` as SoundSlot : 'quizIncorrect';
    void playUserSound(playerId, slot, () =>
      playFeedback(correct ? feedbackAudio.combo[combo - 1] : feedbackAudio.wrong)
    );
  }, [me?.correct, me?.mistakes, me?.combo, matchId, playerId]);

  // Ranked → Card library, one way only. Each card the round shows becomes Seen
  // so the player can review it afterwards without playing casual mode. The
  // library never feeds anything back into ranked: mastery, points and tier
  // stay on the ranked account.
  const markSeen = useMarkSeen();
  useEffect(() => {
    if (!question?.expression || !question.reading) return;
    markSeen(wordProgressKey({ expression: question.expression, reading: question.reading }));
  }, [question?.id, question?.expression, question?.reading, markSeen]);

  const send = (message: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)); };
  const submit = (choice: string) => {
    if (!canAnswer || !question || pendingRef.current) return;
    pendingRef.current = question.id; setPending({ questionId: question.id, choice });
    send({ type: 'answer', questionIndex: state!.questionIndex, questionId: question.id, selectedAnswerId: choice });
  };
  const start = async () => {
    setStarting(true); setError('');
    try { await api.startRankedMatch(matchId); } catch (e) { setError((e as Error).message); } finally { setStarting(false); }
  };
  const control = (type: 'abort' | 'surrender_request' | 'surrender_accept' | 'surrender_decline' | 'surrender_cancel', confirmation?: string) => {
    if (!online || controlBusy || endingEarly || state?.status !== 'live' || socket.current?.readyState !== WebSocket.OPEN) return;
    if (confirmation && !window.confirm(confirmation)) return;
    setControlBusy(true); setError('');
    send({ type, ...(type === 'surrender_accept' || type === 'surrender_decline' || type === 'surrender_cancel' ? { requestId: state.surrender?.id } : {}) });
  };
  const abortRound = () => control('abort', 'Abort this ranked round now? Points, penalties, and mastery from answers already graded will be kept. Unanswered questions will not receive an extra penalty.');
  const exit = () => {
    if (state?.status === 'live' && state.mode === 'solo') { abortRound(); return; }
    onExit();
  };
  const players = Object.entries(state?.players ?? {});
  const isHost = state?.hostUid === playerId;
  const isParty = state?.mode !== 'solo';
  const result = state?.results?.[playerId];
  // Cards newly mastered/won in this round go straight to the library, so they
  // are reviewable without reopening the Ranked page first.
  useRankedLibrarySync(result?.gainedCards?.length ? { gained: result.gainedCards } : null);
  const surrenderOffer = surrenderWindow((state?.questionIndex ?? 0) + 1, state?.surrenderUsed);
  const limitedSurrender = state?.rulesVersion === RANKED_RULES_VERSION;
  const allReady = players.length === (isParty ? 2 : 1) && players.every(([, p]) => p.ready && p.connected);
  return <div className="mx-auto max-w-[980px] px-5 py-8 pb-28 md:px-10 md:py-14">
    <header className="mb-6 flex items-center justify-between gap-4"><div><p className="mono-label flex items-center gap-2 text-[hsl(var(--accent))]"><Swords size={15} /> {isParty ? 'Invite party' : 'Solo ranked'} · {connection}</p><h1 className="mt-2 font-serif text-4xl">{state?.tier ?? 'Ranked'} {isParty ? 'duel' : 'round'}</h1></div><div className="flex flex-wrap items-center justify-end gap-2">
      <SoundMuteToggle mode="ranked" owner={playerId} />
      {state?.status === 'live' && state.mode === 'solo' ? <button onClick={abortRound} disabled={!online || controlBusy || endingEarly} className="flex items-center gap-2 rounded-xl border border-destructive px-3 py-2 text-sm disabled:opacity-50"><X size={15} /> {controlBusy || endingEarly ? 'Ending round…' : 'Abort round'}</button> : state?.status === 'live' ? null : <button onClick={exit} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"><X size={15} /> Exit</button>}
      {state?.status === 'live' && isParty && <button onClick={() => control('surrender_request', limitedSurrender ? 'Request surrender? This uses the current shared opportunity. The other player must respond within 30 seconds or lose by AFK. Agreement ends the match with no wager transfer. The question timer continues.' : 'Request surrender? Both players must agree to end with no wager transfer. The timer continues.')} disabled={!online || controlBusy || !!state.endReason || state.surrender?.status === 'pending' || (limitedSurrender && !surrenderOffer.available)} className="rounded-xl border border-destructive px-3 py-2 text-sm disabled:opacity-50">{state.surrender?.status === 'pending' ? 'Surrender pending' : 'Request surrender'}</button>}
    </div></header>
    {state?.status === 'live' && isParty && limitedSurrender && !state.endReason && <p className="mb-4 text-sm text-muted-foreground" data-testid="surrender-limit">Shared surrender opportunities: Q1, Q10, Q20. {state.surrender?.status === 'pending' ? 'Current opportunity used; awaiting a response.' : surrenderOffer.available ? 'Request available now; unused opportunities do not stack.' : surrenderOffer.nextQuestion ? `Next request unlocks at question ${surrenderOffer.nextQuestion}.` : 'No requests remain. Continue to the end of the match.'} Declining or withdrawing consumes the opportunity.</p>}
    {error && <p role="alert" className="mb-4 rounded-xl border border-destructive p-3 text-sm">{error} {connection === 'closed' && <button onClick={() => window.location.reload()} className="underline">Retry</button>}</p>}
    {endingEarly && <p role="status" className="mb-4 rounded-xl bg-muted p-4 text-sm">Ending the round and saving balances… Please wait for confirmation.</p>}
    {state?.status === 'live' && !state.endReason && state.surrender?.status === 'pending' && <section aria-label="Surrender request" className="mb-5 rounded-2xl border border-[hsl(var(--accent))] bg-card p-5">
      <h2 className="font-bold">{state.surrender.requestedBy === playerId ? 'Surrender requested' : `${state.players[state.surrender.requestedBy]?.nickname ?? 'Your opponent'} requests surrender`}</h2>
      <p className="mt-2 text-sm text-muted-foreground">Both players must agree. No winner, no wager points or cards transferred. The timer continues while this request is pending.</p>
      {state.surrender.deadline && <p role="status" className="mt-3 font-bold">{state.surrender.requestedBy === playerId ? 'Opponent must respond' : 'Respond'} within {consentLeft}s. No response means an AFK loss plus a {state.questionIndex >= 20 ? 10 : 5}-point fine. Answering a question is not a response; choose Accept surrender or Keep playing.</p>}
      {state.surrender.requestedBy === playerId ? <><p className="mt-3 text-sm">Waiting for your opponent’s agreement. You can keep answering.</p><button onClick={() => control('surrender_cancel')} disabled={!online || controlBusy} className="mt-3 rounded-xl border px-4 py-2 text-sm disabled:opacity-50">Withdraw request</button></> : <div className="mt-4 flex flex-wrap gap-3"><button onClick={() => control('surrender_accept', 'Accept surrender? The match ends now. Neither player wins or loses any wager points or cards. Cursed-card repairs already earned are saved.')} disabled={!online || controlBusy} className="rounded-xl bg-[hsl(var(--primary))] px-4 py-2 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-50">Accept surrender</button><button onClick={() => control('surrender_decline')} disabled={!online || controlBusy} className="rounded-xl border px-4 py-2 text-sm disabled:opacity-50">Keep playing</button></div>}
    </section>}
    {state?.status === 'live' && !state.endReason && (state.surrender?.status === 'declined' || state.surrender?.status === 'withdrawn') && <p role="status" className="mb-4 text-sm text-muted-foreground">{state.surrender.status === 'declined' ? 'Surrender request declined.' : 'Surrender request withdrawn.'} The match continues.</p>}
    {state && isParty && <p className="mb-5 rounded-xl bg-muted p-4 text-sm"><strong>Wager per player:</strong> {state.wagerPoints} ranked points{state.wagerCards > 0 && ` + ${state.wagerCards} unique mastered ${state.tier} cards`}. {limitedSurrender ? 'Normally the winner gains the stake and the loser loses it. A higher-ranked loser instead loses only owned missed cards, capped at the card wager; those cards are not transferred. All their missed cards become cursed. AFK adds a separate fine.' : 'Winner gains the stake, loser loses it. A tie changes nothing.'}</p>}
    <div className={cn('grid gap-4', isParty && 'md:grid-cols-2')}>{players.map(([uid, p]) => <section key={uid} className={cn('rounded-2xl border bg-card p-5', uid === playerId ? 'border-[hsl(var(--accent))]' : 'border-border')}><div className="flex justify-between gap-3"><h2 className="font-bold">{p.nickname}{uid === playerId ? ' · You' : ''}</h2><span className="text-xs text-muted-foreground">{p.connected ? 'Online' : 'Disconnected'}</span></div><p className="mt-3 font-serif text-4xl">{p.score}</p><p className="mt-1 text-xs text-muted-foreground">{p.correct} correct · {p.mistakes}/4 mistakes{isParty && limitedSurrender && ` · ${p.timeoutStreak ?? 0}/4 consecutive timeouts`}</p>{state?.status === 'live' && <p className="mt-3 text-sm">{state.phase === 'review' ? `${p.answer?.result === 'timeout' ? 'Time out' : p.answer?.result === 'correct' ? 'Correct' : 'Incorrect'} · ${signed(p.answer?.delta ?? 0)}` : p.answered ? 'Answer locked' : 'Choosing…'}</p>}</section>)}</div>
    {!state && <div role="status" className="mt-10 text-center"><p>{connection === 'closed' ? 'Could not open this match.' : connection === 'reconnecting' ? `Reconnecting to your match… (attempt ${attempt})` : 'Connecting to your match…'}</p>{connection !== 'connecting' && <button onClick={onExit} className="mt-4 rounded-xl border px-4 py-2 text-sm">Back to modes</button>}</div>}
    {state?.status === 'lobby' && <section className="mt-5 rounded-2xl border bg-card p-6 text-center">
      <h2 className="font-serif text-3xl">{isParty ? 'Party lobby' : 'Ready for your round?'}</h2>
      {isParty && <button className="mx-auto mt-4 flex items-center gap-3 rounded-xl bg-muted px-5 py-3 font-mono text-2xl tracking-widest" onClick={async () => { try { await navigator.clipboard.writeText(state.roomCode); setCopied(true); } catch { setError('Copy unavailable. Select and copy the room code manually.'); } }}>{state.roomCode}<Copy size={18} /><span className="text-xs tracking-normal">{copied ? 'Copied' : 'Copy'}</span></button>}
      <p className="mx-auto mt-5 max-w-xl text-sm leading-6 text-muted-foreground">{state.totalQuestions} questions · 10 seconds each · +4 correct, −2 incorrect, −1 timeout. {isParty ? 'Both players finish the same question before advancing. The whole round ends if either player reaches 4 mistakes. That player loses; if both reach 4 together, the higher score wins.' : 'Four mistakes ends the round. Only new mastery earns points; incorrect answers remove the card’s mastery and one other mastered card.'}</p>
      {isParty && <p className="mt-3 text-sm text-muted-foreground">Lowest player tier is used. Both players must confirm. During play, either can request surrender; both must agree to end with no wager transfer. Disconnecting alone does not cancel a wager.</p>}
      {limitedSurrender && isParty && <p className="mt-3 text-sm text-muted-foreground">AFK: four consecutive timeouts or no response to surrender within 30 seconds. The AFK player loses the wager plus 5 points on Q1–20, or 10 points on Q21+. On Q21+, the opponent also earns 1 account point per graded correct non-repair answer. If both time out four times consecutively, both pay the fine, with no winner or wager transfer. Surrender has three shared opportunities: Q1, Q10, Q20; unused opportunities do not stack.</p>}
      {limitedSurrender && <p className="mt-3 text-sm text-muted-foreground">Cursed cards come first, including repairs from other tiers. Owners earn/lose no points or score on repair answers, but misses still count. One correct answer restores mastery and clears the curse, even on mutual surrender. An opponent without that curse gets +2 match score for answering correctly. Remaining curses carry into later rounds.</p>}
      {!isParty && <p className="mt-3 text-sm text-muted-foreground">You can abort during play. Points and mastery changes from graded answers are kept; unanswered questions get no extra penalty.</p>}
      <p className="mt-3 rounded-xl bg-muted p-3 text-sm" data-testid="room-review-time"><strong>Review time:</strong> {reviewTimeLabel(state.reviewMs ?? RULES.reviewMs)}. {state.reviewMs === 0 ? 'No answer-review screen: move directly to the next question or results.' : 'The correct answer is shown during this pause.'}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">{players.map(([uid, p]) => <span key={uid} className="rounded-lg bg-muted px-3 py-2 text-xs">{p.nickname}: {p.ready ? 'Confirmed' : 'Not ready'}</span>)}</div>
      <button onClick={() => send({ type: 'ready', rulesVersion: RANKED_RULES_VERSION, tier: state.tier, reviewMs: state.reviewMs ?? RULES.reviewMs })} disabled={!online || me?.ready} className="mt-5 rounded-xl border px-5 py-3 font-bold disabled:opacity-50">{me?.ready ? 'Confirmed — waiting to start' : isParty ? 'Accept wager & ready' : 'Ready'}</button>
      {isHost && <button onClick={start} disabled={!online || !allReady || starting} className="ml-3 mt-5 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40">{starting ? 'Starting…' : 'Start round'}</button>}
      {!isHost && me?.ready && <p className="mt-3 text-sm">Waiting for the host to start.</p>}
    </section>}
    {state?.status === 'live' && !endingEarly && question && <section className="mt-5 rounded-[1.75rem] border bg-card p-6 md:p-10">
      <div className="flex justify-between gap-4"><p className="mono-label text-muted-foreground">Question {state.questionIndex + 1} / {state.totalQuestions}</p><span className="flex items-center gap-2 text-sm font-bold"><Clock3 size={16} /> {state.phase === 'review' ? 'Review' : 'Answer'} · {timeLeft}s</span></div>
      {!!question.cursedFor?.length && <p role="status" className="mt-4 rounded-xl bg-muted p-3 text-sm">{question.cursedFor.includes(playerId) ? 'Your cursed-card repair: 0 points or score. Correct clears the curse and restores mastery; a miss still counts as a mistake.' : 'Opponent’s cursed card: correct earns +2 match score, not account points. Normal wrong/timeout penalties apply.'} Card tier: {question.tier ?? state.tier}.</p>}
      <div className="py-10 text-center"><h2 className="kanji-display text-6xl md:text-7xl">{question.expression}</h2><p className="mt-4 text-lg text-[hsl(var(--secondary))]">{question.reading}</p><p className="mt-3 text-sm text-muted-foreground">Choose the meaning</p></div>
      <div className="grid gap-3 md:grid-cols-2">{question.choices.map((choice, index) => {
        const correct = state.phase === 'review' && choice.id === state.answerId;
        const wrong = state.phase === 'review' && choice.id === selected && !correct;
        return <button key={`${question.id}:${choice.id}`} onClick={() => submit(choice.id)} disabled={!canAnswer} className={cn('flex min-h-16 items-center gap-3 rounded-xl border p-4 text-left text-sm transition-colors', canAnswer && 'hover:border-[hsl(var(--accent))]', selected === choice.id && 'border-[hsl(var(--accent))]', correct && 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.15)]', wrong && 'border-destructive bg-destructive/10')}><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted font-mono">{index + 1}</span><span className="flex-1">{choice.meaning}</span>{correct && <Check aria-label="Correct answer" size={18} />}{wrong && <X aria-label="Incorrect answer" size={18} />}</button>;
      })}</div>
      <p role="status" aria-live="polite" className="mt-5 rounded-xl bg-muted p-4 text-center text-sm">{state.phase === 'review' ? `${me?.answer?.result === 'correct' ? 'Correct' : me?.answer?.result === 'timeout' ? 'Time out' : 'Incorrect'}. ${state.endReason ? 'Round over — settling results…' : 'Next question starts automatically.'}` : me?.answered || pending ? 'Answer locked. Waiting for the other player or the shared deadline…' : !online ? 'Reconnecting — the server timer continues.' : timeLeft === 0 ? 'Time is up. Waiting for server…' : 'Choose one answer. You cannot change it after submitting.'}</p>
    </section>}
    {state?.status === 'complete' && <section className="mt-5 rounded-2xl border bg-card p-8 text-center"><Trophy className="mx-auto text-[hsl(var(--accent))]" size={36} /><h2 className="mt-4 font-serif text-4xl">{state.endReason === 'afk' ? state.afk?.uids.includes(playerId) ? 'AFK loss' : 'Opponent AFK — you won' : state.endReason === 'aborted' ? 'Round aborted' : state.endReason === 'surrender' ? 'Match surrendered' : !isParty ? 'Round complete' : state.winnerUid === playerId ? 'You won!' : state.winnerUid ? 'You lost' : 'It’s a tie'}</h2><p className="mt-3 text-sm text-muted-foreground">{state.endReason === 'afk' ? `AFK: ${state.afk?.cause === 'surrender' ? 'surrender request was not answered within 30 seconds' : 'four consecutive timeouts'}. Penalties and wager results are shown below.` : state.endReason === 'aborted' ? 'Only graded answers were saved. No extra penalty for unanswered questions.' : state.endReason === 'surrender' ? 'Both players agreed to surrender. No winner and no wager transfer. Earned cursed-card repairs were kept.' : state.endReason === 'mistakes' ? 'The round ended at the four-mistake limit.' : 'All questions completed.'} Results saved to your account.</p>
      {result && <div className="mx-auto mt-6 max-w-md rounded-xl bg-muted p-5"><p className="font-bold">Ranked points: {result.pointsBefore} → {result.pointsAfter} ({signed(result.pointsAfter - result.pointsBefore)})</p><p className="mt-2 text-sm">Mastered cards: {result.cardsBefore} → {result.cardsAfter} ({signed(result.cardsAfter - result.cardsBefore)})</p><p className="mt-2 text-sm">Current tier: {result.tier}</p>{result.cursesAfter !== undefined && <p className="mt-2 text-sm">Cursed cards remaining: {result.cursesAfter}</p>}{!!result.afkFine && <p className="mt-2 text-sm">Additional AFK fine: −{result.afkFine} points</p>}{!!result.afkBonus && <p className="mt-2 text-sm">Late-match correct-answer bonus: +{result.afkBonus} points</p>}{isParty && !state.winnerUid && <p className="mt-3 text-sm">No wager points or cards were transferred.</p>}{(result.gainedCards.length > 0 || result.lostCards.length > 0) && <details className="mt-4 text-left text-xs"><summary className="cursor-pointer font-bold">Transferred / changed cards</summary>{result.gainedCards.map(k => <p key={k} className="mt-1">+ {k.replace(/^word:/, '')}</p>)}{result.lostCards.map(k => <p key={k} className="mt-1">− {k.replace(/^word:/, '')}</p>)}</details>}</div>}
      <button onClick={onExit} className="mt-6 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 font-bold text-[hsl(var(--primary-foreground))]">Back to modes</button>
    </section>}
  </div>;
}
