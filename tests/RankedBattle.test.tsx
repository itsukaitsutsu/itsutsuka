import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSoundSettings, playUserSound, saveSoundSettings } from '@/lib/soundSettings';
import { feedbackAudio, playFeedback } from '@/lib/vocabulary';
import { RankedBattle } from '@/components/RankedBattle';
import type { BattleState } from '../shared/ranked';
vi.mock('@/utils/firebase/client', () => ({ auth: { currentUser: { getIdToken: async () => 'token' } } }));
vi.mock('@/lib/api', () => ({ api: { rankedMatch: async () => ({}), startRankedMatch: vi.fn().mockResolvedValue({}) }, ApiError: class ApiError extends Error {} }));
const soundStore: Record<string, { enabled: boolean; finishEnabled: boolean; assets: Record<string, unknown> }> = {};
vi.mock('@/lib/soundSettings', () => ({
  playUserSound: vi.fn(), SOUND_SETTINGS_CHANGED: 'kotoba-sound-settings-changed',
  loadSoundSettings: vi.fn(async (owner: string) => soundStore[owner] ?? { enabled: true, finishEnabled: true, assets: {} }),
  saveSoundSettings: vi.fn(async (owner: string, next: typeof soundStore[string]) => { soundStore[owner] = next; }),
}));
vi.mock('@/auth/useAuth', () => ({ useAuth: () => ({ user: { uid: 'host' } }) }));
vi.mock('@/lib/vocabulary', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/vocabulary')>(), playFeedback: vi.fn() }));
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason?: string }) => void;
  onerror?: () => void;
  sent: any[] = [];
  constructor(public url: string) { Socket.instances.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() {}
  state(room: BattleState) { this.onmessage?.({ data: JSON.stringify({ type: 'state', room }) }); }
}
const player = (nickname: string) => ({ nickname, score: 0, correct: 0, mistakes: 0, combo: 0, answered: false, ready: true, connected: true });
function state(): BattleState {
  return { rulesVersion: 3, matchId: 'match', roomCode: 'ABC12345', hostUid: 'host', mode: 'party', tier: 'N5', quizType: 'meaning', wagerType: 'points', wagerPoints: 10, wagerCards: 0, reviewMs: 3000,
    status: 'live', phase: 'question', players: { host: player('Host'), guest: player('Guest') }, questionIndex: 0, totalQuestions: 10, deadline: Date.now() + 10000, serverNow: Date.now(), winnerUid: null,
    question: { id: 'q-1', prompt: { expression: '猫', reading: 'ねこ' }, choices: [{ id: '0', meaning: 'cat' }, { id: '1', meaning: 'dog' }, { id: '2', meaning: 'bird' }, { id: '3', meaning: 'fish' }] } };
}
async function mount(playerId = 'host', onExit = vi.fn()) {
  render(<RankedBattle matchId="match" playerId={playerId} onExit={onExit} />);
  await waitFor(() => expect(Socket.instances.length).toBe(1));
  const ws = Socket.instances[0]; act(() => ws.onopen?.()); return ws;
}
beforeEach(() => { vi.clearAllMocks(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('ranked battle client synchronization', () => {
  it('sends question identity once, waits for server reveal, and resets only for a new question', async () => {
    const ws = await mount(), r = state(); act(() => ws.state(r));
    fireEvent.click(screen.getByRole('button', { name: /cat/ }));
    fireEvent.click(screen.getByRole('button', { name: /dog/ }));
    expect(ws.sent).toEqual([{ type: 'answer', questionIndex: 0, questionId: 'q-1', selectedAnswerId: '0' }]);
    expect(screen.queryByLabelText('Correct answer')).toBeNull();
    r.players.host.answered = true; r.players.host.selection = '0'; act(() => ws.state(r));
    expect((screen.getByRole('button', { name: /dog/ }) as HTMLButtonElement).disabled).toBe(true);
    r.phase = 'review'; r.answerId = '0'; r.players.host.answer = { selectedAnswerId: '0', result: 'correct', delta: 1 }; act(() => ws.state(r));
    expect(screen.getByLabelText('Correct answer')).toBeTruthy();
    r.questionIndex = 1; r.question!.id = 'q-2'; r.phase = 'question'; r.answerId = undefined; r.players.host = player('Host'); act(() => ws.state(r));
    expect((screen.getByRole('button', { name: /dog/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('restores answered state after refresh and uses the server clock instead of the local clock', async () => {
    const ws = await mount(), r = state();
    r.serverNow = Date.now() + 120000; r.deadline = r.serverNow + 10000; r.players.host.answered = true; r.players.host.selection = '1';
    act(() => ws.state(r)); expect(screen.getByText(/Answer · 10s/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /cat/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows wager consent to both players but only the host gets the start button', async () => {
    const ws = await mount('guest'), r = state(); r.status = 'lobby'; r.players.guest.ready = false;
    act(() => ws.state(r)); fireEvent.click(screen.getByRole('button', { name: 'Accept wager & ready' }));
    expect(ws.sent).toEqual([{ type: 'ready', rulesVersion: 3, tier: 'N5', reviewMs: 3000 }]);
    expect(screen.queryByRole('button', { name: 'Start round' })).toBeNull(); expect(screen.getByText(/10 ranked points/)).toBeTruthy();
  });
  it('unlocks the next answer when zero review skips both the answer acknowledgement and review frame', async () => {
    const ws = await mount(), r = state(); r.reviewMs = 0;
    act(() => ws.state(r)); fireEvent.click(screen.getByRole('button', { name: /cat/ }));
    expect(ws.sent).toHaveLength(1);
    // Last player answered: server advances directly, without an intermediate answered/review state.
    r.questionIndex = 1; r.question!.id = 'q-2'; r.players.host = player('Host');
    act(() => ws.state(r)); fireEvent.click(screen.getByRole('button', { name: /dog/ }));
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[1]).toEqual({ type: 'answer', questionIndex: 1, questionId: 'q-2', selectedAnswerId: '1' });
  });
  it('shows zero review time in the lobby and confirms that exact setting', async () => {
    const ws = await mount('guest'), r = state(); r.status = 'lobby'; r.reviewMs = 0; r.players.guest.ready = false;
    act(() => ws.state(r)); expect(screen.getByTestId('room-review-time').textContent).toContain('Off (0 seconds)');
    expect(screen.getByTestId('room-review-time').textContent).toContain('No answer-review screen');
    fireEvent.click(screen.getByRole('button', { name: 'Accept wager & ready' }));
    expect(ws.sent).toEqual([{ type: 'ready', rulesVersion: 3, tier: 'N5', reviewMs: 0 }]);
  });
  it.each([0, 3000])('plays combos 1 through 5, caps at 5, and does not replay duplicate states with %i ms review', async reviewMs => {
    const ws = await mount(), r = state(); r.reviewMs = reviewMs;
    act(() => ws.state(r)); expect(playUserSound).not.toHaveBeenCalled();
    for (let correct = 1; correct <= 6; correct++) {
      r.players.host.correct = correct; r.players.host.combo = Math.min(correct, 5);
      r.phase = reviewMs === 0 ? 'question' : 'review'; r.questionIndex = reviewMs === 0 ? correct : correct - 1;
      act(() => ws.state(r)); act(() => ws.state(r));
    }
    expect(vi.mocked(playUserSound).mock.calls.map(call => call[1])).toEqual(['quizCombo1', 'quizCombo2', 'quizCombo3', 'quizCombo4', 'quizCombo5', 'quizCombo5']);
    for (const [i, call] of vi.mocked(playUserSound).mock.calls.entries()) {
      call[2]?.(); expect(playFeedback).toHaveBeenLastCalledWith(feedbackAudio.combo[Math.min(i, 4)]);
    }
    // Advancing a reviewed question is not a new graded answer.
    r.phase = 'question'; act(() => ws.state(r)); expect(playUserSound).toHaveBeenCalledTimes(6);
  });
  it('plays incorrect feedback on mistakes, restarts at combo 1 and sounds the final zero-review answer', async () => {
    const ws = await mount(), r = state(); r.reviewMs = 0; act(() => ws.state(r));
    r.players.host.correct = 3; r.players.host.combo = 3; act(() => ws.state(r));
    r.players.host.mistakes = 1; r.players.host.combo = 0; act(() => ws.state(r));
    r.players.host.correct = 4; r.players.host.combo = 1; act(() => ws.state(r));
    r.players.host.mistakes = 2; r.players.host.combo = 0; act(() => ws.state(r));
    r.players.host.correct = 5; r.players.host.combo = 1; r.status = 'complete'; act(() => ws.state(r));
    expect(vi.mocked(playUserSound).mock.calls.map(call => call[1])).toEqual(['quizCombo3', 'quizIncorrect', 'quizCombo1', 'quizIncorrect', 'quizCombo1']);
  });
  it('does not replay history on refresh, continues the server streak, and ignores opponent-only changes', async () => {
    const ws = await mount(), r = state(); r.players.host.correct = 4; r.players.host.combo = 4;
    act(() => ws.state(r)); expect(playUserSound).not.toHaveBeenCalled();
    r.players.guest.correct = 5; r.players.guest.combo = 5; act(() => ws.state(r)); expect(playUserSound).not.toHaveBeenCalled();
    r.players.host.correct = 5; r.players.host.combo = 5; act(() => ws.state(r));
    expect(playUserSound).toHaveBeenCalledExactlyOnceWith('host', 'quizCombo5', expect.any(Function));
  });
  it('confirms solo abort, waits for saved results, and lets the user return afterward', async () => {
    const onExit = vi.fn(), ws = await mount('host', onExit), r = state(); r.mode = 'solo'; delete r.players.guest;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); act(() => ws.state(r));
    fireEvent.click(screen.getByRole('button', { name: 'Abort round' })); expect(ws.sent).toHaveLength(0);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Abort round' }));
    expect(ws.sent).toEqual([{ type: 'abort' }]); expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('already graded'));
    expect(onExit).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: 'Ending round…' }) as HTMLButtonElement).disabled).toBe(true);
    r.status = 'complete'; r.endReason = 'aborted'; r.deadline = null;
    r.results = { host: { pointsBefore: 100, pointsAfter: 99, cardsBefore: 5, cardsAfter: 4, gainedCards: [], lostCards: ['word:cat'], tier: 'N5' } };
    act(() => ws.state(r)); expect(screen.getByText('Round aborted')).toBeTruthy(); expect(screen.getByText(/No extra penalty/)).toBeTruthy();
    expect(screen.getByText('Ranked points: 100 → 99 (-1)')).toBeTruthy(); expect(playUserSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to modes' })); expect(onExit).toHaveBeenCalledOnce();
  });
  it('lets the requester keep answering or withdraw, but never accept their own surrender', async () => {
    const ws = await mount(), r = state(); vi.spyOn(window, 'confirm').mockReturnValue(true); act(() => ws.state(r));
    expect(screen.queryByRole('button', { name: 'Abort round' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request surrender' })); expect(ws.sent).toEqual([{ type: 'surrender_request' }]);
    r.surrenderUsed = 1; r.surrender = { id: 'request-1', requestedBy: 'host', status: 'pending' }; act(() => ws.state(r));
    expect(screen.getByText(/The timer continues while this request/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Accept surrender' })).toBeNull();
    expect((screen.getByRole('button', { name: /cat/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' })); expect(ws.sent.at(-1)).toEqual({ type: 'surrender_cancel', requestId: 'request-1' });
    r.surrender.status = 'withdrawn'; act(() => ws.state(r)); expect(screen.getByText(/Surrender request withdrawn/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Request surrender' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('allows the opponent to decline or explicitly accept the current request and shows a neutral result', async () => {
    const ws = await mount('guest'), r = state(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    r.surrenderUsed = 1; r.surrender = { id: 'request-1', requestedBy: 'host', status: 'pending' }; act(() => ws.state(r));
    fireEvent.click(screen.getByRole('button', { name: 'Accept surrender' })); expect(ws.sent).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Keep playing' })); expect(ws.sent.at(-1)).toEqual({ type: 'surrender_decline', requestId: 'request-1' });
    r.surrender = { id: 'request-2', requestedBy: 'host', status: 'pending' }; act(() => ws.state(r)); confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Accept surrender' })); expect(ws.sent.at(-1)).toEqual({ type: 'surrender_accept', requestId: 'request-2' });
    r.surrender.status = 'accepted'; r.endReason = 'surrender'; act(() => ws.state(r));
    expect(screen.getByText(/Ending the round and saving balances/)).toBeTruthy(); expect(screen.queryByRole('button', { name: /cat/ })).toBeNull();
    r.status = 'complete'; act(() => ws.state(r)); expect(screen.getByText('Match surrendered')).toBeTruthy();
    expect(screen.getByText(/No winner and no wager transfer/)).toBeTruthy(); expect(screen.queryByText('It’s a tie')).toBeNull();
  });
  it('offers no Leave/Exit button during a live party battle; only surrender ends it', async () => {
    const onExit = vi.fn(), ws = await mount('host', onExit), r = state(); act(() => ws.state(r));
    expect(screen.queryByRole('button', { name: /Leave page|Exit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request surrender' })).toBeTruthy();
    r.status = 'complete'; r.winnerUid = 'host'; act(() => ws.state(r));
    fireEvent.click(screen.getByRole('button', { name: 'Back to modes' })); expect(onExit).toHaveBeenCalledOnce();
  });
  it('disables consent offline and clears the busy state after a server rejection', async () => {
    const ws = await mount('guest'), r = state(); r.surrenderUsed = 1; r.surrender = { id: 'request-1', requestedBy: 'host', status: 'pending' }; act(() => ws.state(r));
    fireEvent.click(screen.getByRole('button', { name: 'Keep playing' })); expect((screen.getByRole('button', { name: 'Accept surrender' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'This surrender request is no longer pending.' }) }));
    expect((screen.getByRole('button', { name: 'Accept surrender' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => ws.onclose?.({ code: 1006 })); expect((screen.getByRole('button', { name: 'Accept surrender' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Keep playing' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows the independent 30-second surrender timer and does not pretend a question answer is consent', async () => {
    const ws = await mount('guest'), r = state(); r.surrenderUsed = 1;
    r.surrender = { id: 'request', requestedBy: 'host', status: 'pending', deadline: Date.now() + 30000 };
    act(() => ws.state(r)); expect(screen.getByText(/Respond within 30s/)).toBeTruthy();
    expect(screen.getByText(/Answering a question is not a response/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cat/ })); expect(ws.sent[0].type).toBe('answer');
    expect(screen.getByRole('button', { name: 'Keep playing' })).toBeTruthy();
  });
  it('locks surrender until Q10, then Q20, and permanently after the third cancellation', async () => {
    const ws = await mount(), r = state(); r.surrenderUsed = 1; r.questionIndex = 4; act(() => ws.state(r));
    expect(screen.getByTestId('surrender-limit').textContent).toContain('question 10');
    expect((screen.getByRole('button', { name: 'Request surrender' }) as HTMLButtonElement).disabled).toBe(true);
    r.questionIndex = 9; act(() => ws.state(r)); expect((screen.getByRole('button', { name: 'Request surrender' }) as HTMLButtonElement).disabled).toBe(false);
    r.surrenderUsed = 2; act(() => ws.state(r)); expect(screen.getByTestId('surrender-limit').textContent).toContain('question 20');
    r.questionIndex = 19; act(() => ws.state(r)); expect((screen.getByRole('button', { name: 'Request surrender' }) as HTMLButtonElement).disabled).toBe(false);
    r.surrenderUsed = 3; act(() => ws.state(r)); expect(screen.getByTestId('surrender-limit').textContent).toContain('No requests remain');
    expect((screen.getByRole('button', { name: 'Request surrender' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(['host', 'guest'])('explains personal curse scoring to %s', async uid => {
    const ws = await mount(uid), r = state(); r.question!.cursedFor = ['host']; r.question!.tier = 'N4'; act(() => ws.state(r));
    expect(screen.getByText(uid === 'host' ? /Your cursed-card repair: 0 points/ : /Opponent’s cursed card: correct earns \+2 match score/)).toBeTruthy();
    expect(screen.getByText(/Card tier: N4/)).toBeTruthy();
  });
  it('shows AFK fines and remaining curses rather than an ordinary tie or completion', async () => {
    const ws = await mount(), r = state(); r.status = 'complete'; r.endReason = 'afk';
    r.afk = { uids: ['host'], cause: 'surrender', questionNumber: 21, fine: 10 }; r.winnerUid = 'guest';
    r.results = { host: { pointsBefore: 100, pointsAfter: 80, cardsBefore: 5, cardsAfter: 5, gainedCards: [], lostCards: [], tier: 'N5', afkFine: 10, cursesAfter: 2 } };
    act(() => ws.state(r)); expect(screen.getByText('AFK loss')).toBeTruthy();
    expect(screen.getByText(/Additional AFK fine: −10 points/)).toBeTruthy(); expect(screen.getByText('Cursed cards remaining: 2')).toBeTruthy();
  });
  it('shows persisted match result and the actual wager balance change', async () => {
    const ws = await mount(), r = state(); r.status = 'complete'; r.winnerUid = 'host'; r.endReason = 'mistakes';
    r.results = { host: { pointsBefore: 100, pointsAfter: 110, cardsBefore: 5, cardsAfter: 5, gainedCards: [], lostCards: [], tier: 'N5' } };
    act(() => ws.state(r)); expect(screen.getByText('You won!')).toBeTruthy(); expect(screen.getByText('Ranked points: 100 → 110 (+10)')).toBeTruthy();
  });

  it('stops retrying and shows the server reason when the room refuses the socket permanently', async () => {
    const ws = await mount();
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'You are not a player in this match.' }) }));
    act(() => ws.onclose?.({ code: 4403, reason: 'You are not a player in this match.' }));
    expect(screen.getByRole('alert').textContent).toContain('You are not a player in this match.');
    expect(screen.getByRole('status').textContent).toContain('Could not open this match.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 1100)); expect(Socket.instances).toHaveLength(1);
  });
  it('keeps the server error visible instead of the generic interruption text while retrying', async () => {
    const ws = await mount();
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'D1_ERROR: no such column: cursed' }) }));
    act(() => ws.onerror?.()); act(() => ws.onclose?.({ code: 4409, reason: 'D1_ERROR: no such column: cursed' }));
    expect(screen.getByRole('alert').textContent).toContain('no such column: cursed');
    expect(screen.getByRole('alert').textContent).not.toContain('Connection interrupted');
    expect(screen.getByRole('status').textContent).toContain('Reconnecting to your match… (attempt 1)');
    await waitFor(() => expect(Socket.instances).toHaveLength(2), { timeout: 3000 });
  });
  it('lets the player leave while a match will not connect', async () => {
    const onExit = vi.fn(); const ws = await mount('host', onExit);
    act(() => ws.onclose?.({ code: 1006 }));
    expect(screen.getByRole('alert').textContent).toContain('Connection interrupted');
    fireEvent.click(screen.getByRole('button', { name: 'Back to modes' })); expect(onExit).toHaveBeenCalled();
  });

  it('offers a sound on/off switch in solo and party rooms, in the lobby and during play', async () => {
    for (const mode of ['solo', 'party'] as const) {
      Socket.instances = [];
      const ws = await mount(mode === 'solo' ? 'host' : 'guest'), r = state(); r.mode = mode; r.status = 'lobby';
      if (mode === 'solo') delete (r.players as Record<string, unknown>).guest;
      act(() => ws.state(r));
      expect(screen.getByRole('button', { name: 'Mute all sounds' })).toBeTruthy();
      r.status = 'live'; act(() => ws.state(r));
      expect(screen.getByRole('button', { name: 'Mute all sounds' })).toBeTruthy();
      cleanup();
    }
  });
  it('toggles the shared sound setting for this player and persists it', async () => {
    delete soundStore.host;
    const ws = await mount(), r = state(); act(() => ws.state(r));
    const button = await screen.findByRole('button', { name: 'Mute all sounds' });
    await act(async () => { fireEvent.click(button); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unmute all sounds' })).toBeTruthy());
    expect(saveSoundSettings).toHaveBeenLastCalledWith('host', expect.objectContaining({ enabled: false }));
    expect(loadSoundSettings).toHaveBeenCalledWith('host');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unmute all sounds' })); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mute all sounds' })).toBeTruthy());
    expect(saveSoundSettings).toHaveBeenLastCalledWith('host', expect.objectContaining({ enabled: true }));
  });
});
