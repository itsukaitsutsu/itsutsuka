import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CardProgressProvider, useCardProgress, useRankedLibrarySync } from '../src/components/CardProgress';
import { loadSeenKeys, wordProgressKey } from '../src/lib/cardProgress';
import { fake, resetFake, setDiscovery } from './helpers/fakeApi';

vi.mock('@/lib/api', () => import('./helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return { useAuth: () => ({ user: fake.uid ? { uid: fake.uid } : null }) };
});

const NEKO = { expression: '猫', reading: 'ねこ' };
const INU = { expression: '犬', reading: 'いぬ' };
const key = wordProgressKey;

function Harness({ mastered }: { mastered: Record<string, string[]> | null }) {
  useRankedLibrarySync(mastered);
  const { seen } = useCardProgress();
  return <span data-testid="seen-count">{seen.size}</span>;
}
const tree = (mastered: Record<string, string[]> | null) =>
  <CardProgressProvider><Harness mastered={mastered} /></CardProgressProvider>;

beforeEach(() => {
  localStorage.clear();
  resetFake();
  fake.uid = 'alice';
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function settle() {
  setDiscovery([]);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
}

it('puts cards from an already-finished ranked tier into the card library as Seen', async () => {
  // A player who completed N5 before the library sync existed.
  const finishedN5 = { N5: [key(NEKO), key(INU)], N4: [], N3: [], N2: [], N1: [] };
  render(tree(finishedN5));
  await settle();

  await waitFor(() => expect(screen.getByTestId('seen-count').textContent).toBe('2'));
  const stored = loadSeenKeys('alice');
  expect(stored.has(key(NEKO))).toBe(true);
  expect(stored.has(key(INU))).toBe(true);
});

it('backfills mastery from every tier, not only the current one', async () => {
  render(tree({ N5: [key(NEKO)], N4: [key(INU)], N3: [], N2: [], N1: [] }));
  await settle();
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(2));
});

it('writes once and does not repeat the backfill on re-render', async () => {
  const mastered = { N5: [key(NEKO), key(INU)], N4: [], N3: [], N2: [], N1: [] };
  const view = render(tree(mastered));
  await settle();
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(2));
  const pushes = fake.counts.pushDiscovery ?? 0;

  view.rerender(tree({ ...mastered }));
  await act(async () => {});
  expect(fake.counts.pushDiscovery ?? 0).toBe(pushes);
  expect(loadSeenKeys('alice').size).toBe(2);
});

it('never turns a library Seen card into ranked progress', async () => {
  render(tree({ N5: [key(NEKO)], N4: [], N3: [], N2: [], N1: [] }));
  await settle();
  await waitFor(() => expect(loadSeenKeys('alice').size).toBe(1));
  // Only discovery is written. No ranked account call is made by the sync.
  expect(fake.counts.rankedAccount ?? 0).toBe(0);
  expect(fake.counts.initializeRanked ?? 0).toBe(0);
});
