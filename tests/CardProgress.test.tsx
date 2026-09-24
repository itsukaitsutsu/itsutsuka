import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CardProgressProvider, DiscoverySummary, OpenedCardBadge, useCardProgress } from '../src/components/CardProgress';
import { loadSeenKeys, saveSeenKeys } from '../src/lib/cardProgress';
import { fake, releaseDiscovery, resetFake, setDiscovery } from './helpers/fakeApi';

vi.mock('@/lib/api', () => import('./helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return { useAuth: () => ({ user: fake.uid ? { uid: fake.uid } : null }) };
});

/** Push rows into the fake server and let the next poll pick them up. */
async function emit(keys: string[] = []) {
  setDiscovery(keys);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
}

function Harness({ card = 'word:cat', show = true }: { card?: string; show?: boolean }) {
  const { seen, status, markOpened } = useCardProgress();
  return <>
    {show && <OpenedCardBadge key={card} cardKey={card} />}
    <DiscoverySummary keys={['word:cat', 'word:dog']} title="Words" />
    <span data-testid="total">{seen.size}</span><p>{status}</p>
    <button onClick={() => { markOpened('word:cat'); markOpened('word:cat'); }}>Repeat</button>
  </>;
}
const tree = (card = 'word:cat', show = true) => <StrictMode><CardProgressProvider><Harness card={card} show={show} /></CardProgressProvider></StrictMode>;
const badge = () => screen.getByTestId('card-discovery-badge').textContent ?? '';
const pushes = () => fake.counts.pushDiscovery ?? 0;

beforeEach(() => {
  localStorage.clear();
  resetFake();
  fake.uid = 'alice';
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('records only the displayed card once in StrictMode and preserves its New badge after saving', async () => {
  const view = render(tree());
  await emit();

  expect(badge()).toContain('New to you');
  expect(screen.getByTestId('total').textContent).toBe('1');
  await waitFor(() => expect(pushes()).toBe(1));      // the mount write
  expect(badge()).toContain('New to you');
  expect(loadSeenKeys('alice')).toEqual(new Set(['word:cat']));

  fireEvent.click(screen.getByText('Repeat'));        // marking twice changes nothing
  await act(async () => {});
  expect(pushes()).toBe(1);

  view.rerender(tree('word:dog'));
  await waitFor(() => expect(pushes()).toBe(2));
  expect(screen.getByTestId('total').textContent).toBe('2');

  view.rerender(tree('word:cat'));
  expect(badge()).toContain('Seen before');
  expect(pushes()).toBe(2);
});

it('does not mark unopened cards from summaries and merges remote discoveries without overwriting local opens', async () => {
  render(tree('word:cat', false));
  await emit(['jlpt:Q1']);

  expect(screen.getByTestId('total').textContent).toBe('1');
  expect(pushes()).toBe(0);

  fireEvent.click(screen.getByText('Repeat'));
  await waitFor(() => expect(pushes()).toBe(1));

  await emit(['jlpt:Q1', 'word:dog']);
  expect(loadSeenKeys('alice')).toEqual(new Set(['jlpt:Q1', 'word:cat', 'word:dog']));
});

it('restores abandoned-session progress on reload and retries cached unsynced cards', async () => {
  saveSeenKeys('alice', new Set(['word:cat']));
  render(tree());
  await emit();

  expect(badge()).toContain('Seen before');
  await waitFor(() => expect(fake.writes.some((w) => w.discovery?.[0]?.key === 'word:cat')).toBe(true));
});

it('does not rewrite already-synced remote cards', async () => {
  render(tree());
  await emit(['word:cat']);

  expect(badge()).toContain('Seen before');
  await act(async () => {});
  expect(pushes()).toBe(0);
});

it('isolates account switches and clears state on logout', async () => {
  const view = render(tree());
  await emit(['word:cat']);
  expect(badge()).toContain('Seen before');
  expect(loadSeenKeys('alice')).toEqual(new Set(['word:cat']));

  fake.uid = 'bob';
  view.rerender(tree());
  await emit();
  expect(badge()).toContain('New to you');
  expect(loadSeenKeys('bob')).toEqual(new Set(['word:cat']));   // bob's own card
  expect(loadSeenKeys('alice')).toEqual(new Set(['word:cat'])); // alice untouched

  fake.uid = null;
  view.rerender(tree('word:cat', false));
  await act(async () => {});
  expect(screen.getByTestId('total').textContent).toBe('0');
});

it('keeps local progress after sync failures and retries writes on reconnection', async () => {
  fake.errors.pushDiscovery = new Error('permission-denied');
  render(tree());
  await emit();

  await waitFor(() => expect(screen.getByText(/Cloud sync unavailable/)).toBeTruthy());
  expect(loadSeenKeys('alice').has('word:cat')).toBe(true);

  fake.errors.pushDiscovery = null;
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(pushes()).toBe(2));
});

it('waits for cloud hydration rather than classifying an empty initial cache as New', async () => {
  fake.holdDiscovery = true;
  render(tree());
  await act(async () => {});

  expect(badge()).toContain('Checking progress');
  expect(loadSeenKeys('alice').size).toBe(0);

  setDiscovery(['word:cat']);
  releaseDiscovery();
  await act(async () => {});
  expect(badge()).toContain('Seen before');
});

it('allows offline practice after the hydration grace period', async () => {
  vi.useFakeTimers();
  try {
    fake.holdDiscovery = true;
    render(tree());
    await act(async () => {});

    act(() => vi.advanceTimersByTime(4000));
    expect(badge()).toContain('New to you');
    expect(loadSeenKeys('alice').has('word:cat')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
