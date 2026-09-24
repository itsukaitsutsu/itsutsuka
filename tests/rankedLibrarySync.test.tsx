import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CardProgressProvider, useCardProgress } from '../src/components/CardProgress';
import { RankedBattle } from '../src/components/RankedBattle';
import { wordProgressKey } from '../src/lib/cardProgress';
import { loadSeenKeys } from '../src/lib/cardProgress';
import { fake, resetFake, setDiscovery } from './helpers/fakeApi';
import type { BattleState } from '../shared/ranked';

vi.mock('@/utils/firebase/client', () => ({ auth: { currentUser: { getIdToken: async () => 'token' } } }));
vi.mock('@/lib/api', async () => {
  const helper = await import('./helpers/fakeApi');
  return { ...helper, api: { ...helper.api, rankedMatch: async () => ({}), startRankedMatch: vi.fn().mockResolvedValue({}) }, ApiError: class ApiError extends Error {} };
});
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return { useAuth: () => ({ user: fake.uid ? { uid: fake.uid } : null }) };
});
vi.mock('@/lib/soundSettings', () => ({
  playUserSound: vi.fn(), SOUND_SETTINGS_CHANGED: 'kotoba-sound-settings-changed',
  loadSoundSettings: vi.fn(async () => ({ enabled: false, finishEnabled: false, assets: {} })),
  saveSoundSettings: vi.fn(),
}));
vi.mock('@/lib/vocabulary', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/vocabulary')>(), playFeedback: vi.fn() }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason?: string }) => void;
  onerror?: () => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send() {}
  close() {}
  state(room: BattleState) { this.onmessage?.({ data: JSON.stringify({ type: 'state', room }) }); }
}

const NEKO = { expression: '猫', reading: 'ねこ' };
const player = (nickname: string) => ({ nickname, score: 0, correct: 0, mistakes: 0, combo: 0, answered: false, ready: true, connected: true });
function state(expression: string, reading: string, id: string): BattleState {
  return { rulesVersion: 3, matchId: 'match', roomCode: 'ABC12345', hostUid: 'alice', mode: 'solo', tier: 'N5', wagerType: 'points', wagerPoints: 0, wagerCards: 0, reviewMs: 3000,
    status: 'live', phase: 'question', players: { alice: player('Alice') }, questionIndex: 0, totalQuestions: 10, deadline: Date.now() + 10000, serverNow: Date.now(), winnerUid: null,
    question: { id, expression, reading, choices: [{ id: '0', meaning: 'cat' }, { id: '1', meaning: 'dog' }, { id: '2', meaning: 'bird' }, { id: '3', meaning: 'fish' }] } };
}

function Seen() {
  const { seen } = useCardProgress();
  return <span data-testid="seen-count">{seen.size}</span>;
}

beforeEach(() => {
  localStorage.clear();
  resetFake();
  fake.uid = 'alice';
  Socket.instances = [];
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('WebSocket', Socket as unknown as typeof WebSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount(expression = NEKO.expression, reading = NEKO.reading, id = 'q-1') {
  render(<CardProgressProvider><Seen /><RankedBattle matchId="match" playerId="alice" onExit={vi.fn()} /></CardProgressProvider>);
  await waitFor(() => expect(Socket.instances.length).toBe(1));
  const ws = Socket.instances[0];
  act(() => ws.onopen?.());
  setDiscovery([]);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  act(() => ws.state(state(expression, reading, id)));
  return ws;
}

it('records a ranked question card as Seen in the card library', async () => {
  await mount();
  const key = wordProgressKey(NEKO);
  await waitFor(() => expect(loadSeenKeys('alice').has(key)).toBe(true));
  expect(screen.getByTestId('seen-count').textContent).toBe('1');
});

it('records each new ranked card once, without re-marking the same card', async () => {
  const ws = await mount();
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(1));
  const pushesAfterFirst = fake.counts.pushDiscovery ?? 0;

  // Same card shown again (e.g. a re-render or resumed state) must not re-mark.
  act(() => ws.state(state(NEKO.expression, NEKO.reading, 'q-1')));
  await act(async () => {});
  expect(fake.counts.pushDiscovery ?? 0).toBe(pushesAfterFirst);
  expect(loadSeenKeys('alice').size).toBe(1);

  // A different ranked card is added to the library.
  act(() => ws.state(state('犬', 'いぬ', 'q-2')));
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(2));
  expect(loadSeenKeys('alice').has(wordProgressKey({ expression: '犬', reading: 'いぬ' }))).toBe(true);
});

it('keeps the library one-way: seen cards never become ranked mastery', async () => {
  await mount();
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(1));
  // The discovery API is the only thing written. No ranked account/mastery call
  // is made from the library sync, so casual or ranked "Seen" cannot change rank.
  expect(fake.counts.pushDiscovery ?? 0).toBeGreaterThan(0);
  expect(fake.counts.initializeRanked ?? 0).toBe(0);
  expect(fake.counts.rankedAccount ?? 0).toBe(0);
});
