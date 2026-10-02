import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const { fake, resetFake } = await import('./helpers/fakeApi');

function navigate(path: string) { window.history.pushState({}, '', path); }

describe('part-of-speech deck selection', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    const customWords = [{
      id: 'custom-noun', expression: '私語', reading: 'しご', meaning: 'a made-up word', level: 'Custom',
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', createdAt: '2026-01-01',
    }];
    localStorage.setItem('kotoba-custom-words', JSON.stringify(customWords));
    resetFake({ lists: [{ id: 'saved', name: 'Saved', wordIds: [], createdAt: '2026-01-01' }], activeId: 'saved', customWords, history: [] });
    fake.uid = 'learner';
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    navigate('/quiz');
  });
  afterEach(() => cleanup());

  it('filters a level deck by POS and carries that filter into the actual quiz cards', async () => {
    render(<App />);
    await screen.findByTestId('quiz-setup');
    fireEvent.click(screen.getByTestId('quiz-level-N3'));
    fireEvent.click(screen.getByTestId('quiz-pos-Particle'));

    await waitFor(() => expect(screen.getByText(/2 cards available · Particle only/)).toBeTruthy());
    expect(screen.getByTestId('quiz-pos-Particle').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('button-start-quiz'));

    const quizCard = await screen.findByTestId('quiz-card');
    expect(quizCard.textContent).toContain('Particle');
    expect(quizCard.textContent).toContain('助詞');
    expect(new URLSearchParams(window.location.search).get('partOfSpeech')).toBe('Particle');
  });

  it('lets My words use the same bilingual POS filter', async () => {
    render(<App />);
    await screen.findByTestId('quiz-setup');
    fireEvent.click(screen.getByTestId('quiz-level-my-words'));
    fireEvent.click(screen.getByTestId('quiz-pos-Noun'));

    await waitFor(() => expect(screen.getByText(/1 card available · Noun only/)).toBeTruthy());
    fireEvent.click(screen.getByTestId('button-start-quiz'));
    const quizCard = await screen.findByTestId('quiz-card');
    expect(quizCard.textContent).toContain('Noun');
    expect(quizCard.textContent).toContain('名詞');
  });
});
