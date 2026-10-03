import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { fake, resetFake } = await import('./helpers/fakeApi');

function navigate(path: string) { window.history.pushState({}, '', path); }

describe('casual quiz retry navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetFake();
    fake.uid = 'learner';
    sessionStorage.setItem('kotoba-last-result', JSON.stringify({
      score: 1,
      total: 1,
      answers: [{
        word: { id: 'cat', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', tags: [] },
        choice: 'cat',
        correct: true,
      }],
      level: 'N5',
      finishedAt: '2026-10-02T00:00:00.000Z',
    }));
    navigate('/results');
  });

  afterEach(() => cleanup());

  it('returns to the Casual setup instead of the Ranked/Casual chooser', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('button-retry-quiz'));

    expect(await screen.findByTestId('quiz-setup')).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe('/quiz?setup=casual');
  });
});
