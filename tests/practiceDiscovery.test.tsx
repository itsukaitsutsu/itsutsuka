// App-level practice discovery: opening a card in the real quiz must reach the
// API and come back as "Seen before" on the next visit. The per-component
// mechanics (retry, hydration, account switch) live in CardProgress.test.tsx.
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import App from '@/App';

vi.mock('@/lib/api', () => import('./helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return {
    useAuth: () => ({ user: fake.uid ? { uid: fake.uid, email: 'learner@example.com' } : null, loading: false, logout: vi.fn() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/utils/firebase/client', () => ({ auth: {}, db: {} }));

const { fake, resetFake, ApiError } = await import('./helpers/fakeApi');
const { eventually } = await import('./helpers/eventually');

// A one-word deck: the quiz shuffles, so any larger deck would make the
// "come back later" test flaky (it could serve a different, unseen word).
const customWords = [
  { id: 'custom-1', expression: '命綱', reading: 'いのちづな', meaning: 'lifeline', level: 'N5', createdAt: '2026-01-01' },
];

function navigate(path: string) { window.history.pushState({}, '', path); }

describe('practice discovery', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('kotoba-custom-words', JSON.stringify(customWords));
    resetFake({ lists: [], activeId: null, customWords, history: [] });
    fake.uid = 'learner';
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    navigate('/quiz?run=1&decks=MY_WORDS&count=1&type=reading&seed=1');
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('records the opened card once and pushes it to the API', async () => {
    render(<App />);
    await screen.findByTestId('quiz-card');
    // The badge stays 'Checking progress…' until the cloud answers (max 4s grace).
    await eventually(() => expect(screen.getByTestId('card-discovery-badge').textContent).toContain('New to you'), { timeout: 6000 });

    await eventually(() => expect(fake.counts.pushDiscovery).toBeGreaterThanOrEqual(1));
    await eventually(() => expect(fake.discovery.size).toBe(1));
    // Which word is served first is shuffled, so assert on whatever was stored.
    const [row] = [...fake.discovery.values()];
    expect(row.key.startsWith('word:')).toBe(true);
    expect(row.seen).toBe(true);
    expect(row.cardId).toBeTruthy(); // stable per-card id
    // Re-rendering the same card must not produce a second record.
    fireEvent.click(screen.getByTestId('quiz-card'));
    await eventually(() => expect(fake.counts.pushDiscovery).toBeGreaterThanOrEqual(1));
    expect(fake.discovery.size).toBe(1);
  });

  it('round-trips the open so a later visit shows the card as Seen before', async () => {
    render(<App />);
    await screen.findByTestId('quiz-card');
    await eventually(() => expect(screen.getByTestId('card-discovery-badge').textContent).toContain('New to you'), { timeout: 6000 });
    await eventually(() => expect(fake.discovery.size).toBe(1));

    cleanup(); render(<App />);
    await screen.findByTestId('quiz-card');
    await eventually(() => expect(screen.getByTestId('card-discovery-badge').textContent).toContain('Seen before'), { timeout: 6000 });
    expect(fake.discovery.size).toBe(1);
  });

  it('keeps the badge optimistic while offline and syncs once the connection returns', async () => {
    fake.errors.pushDiscovery = new ApiError(0, 'Cannot reach the server. Check your internet connection.');
    render(<App />);
    await screen.findByTestId('quiz-card');
    await eventually(() => expect(screen.getByTestId('card-discovery-badge').textContent).toContain('New to you'), { timeout: 6000 });
    await eventually(() => expect(fake.counts.pushDiscovery).toBe(1));
    expect(fake.discovery.size).toBe(0);           // nothing reached the server
    expect(screen.getByTestId('card-discovery-badge').textContent).toContain('New to you'); // still optimistic locally

    fake.errors.pushDiscovery = null;
    fireEvent(window, new Event('online'));
    await eventually(() => expect(fake.discovery.size).toBe(1));
    expect(fake.counts.pushDiscovery).toBe(2);     // exactly one retry, no hot loop
    expect(screen.getByTestId('card-discovery-badge').textContent).toContain('New to you');
  });
});
