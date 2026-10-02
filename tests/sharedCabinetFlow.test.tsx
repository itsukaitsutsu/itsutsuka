import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const navigate = (path: string) => window.history.pushState({}, '', path);
async function goto(path: string) { await act(async () => navigate(path)); }

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear(); sessionStorage.clear();
  resetFake({ lists: [{ id: 'slot-1', name: 'My slot', wordIds: [], createdAt: '2026-01-01' }], activeId: 'slot-1' });
  fake.uid = 'learner';
  fake.sharedDecks = [{ id: 'published-1', name: 'SSW_Manufacture_1', cardCount: 1, visibility: 'selected', updatedAt: 'today',
    cards: [{
      id: 'owner-only-card', expression: '特殊製造語', reading: 'とくしゅせいぞうご', meaning: 'factory work', level: 'N4', tags: [],
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞',
    }] }];
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('published cards in existing study flows', () => {
  it('filters Cabinet cards by part of speech and keeps the POS badge visible', async () => {
    navigate('/cabinet'); render(<App />);
    fireEvent.change(await screen.findByTestId('input-search'), { target: { value: '高等学校' } });
    await waitFor(() => {
      const grid = screen.getByTestId('cabinet-grid');
      expect(grid.textContent).toContain('Noun');
      expect(grid.textContent).toContain('名詞');
    });
    const posFilter = screen.getByTestId('select-cabinet-pos');
    fireEvent.keyDown(posFilter, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Adjective' }));
    expect(await screen.findByText('Nothing in this drawer.')).toBeTruthy();
    fireEvent.keyDown(posFilter, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Noun' }));
    await waitFor(() => expect(screen.getByTestId('cabinet-grid').textContent).toContain('高校; 高等学校'));
  });

  it('shows a separate published slot without consuming any of 10 personal slots', async () => {
    fake.me.lists = Array.from({ length: 10 }, (_, i) => ({ id: `slot-${i}`, name: `Slot ${i}`, wordIds: [], createdAt: '2026-01-01' }));
    fake.me.activeId = 'slot-0';
    navigate('/cabinet'); render(<App />);
    fireEvent.change(await screen.findByTestId('input-search'), { target: { value: '特殊製造語' } });
    await waitFor(() => expect(screen.queryByTestId('shared-word-card-published-1-owner-only-card')).toBeNull());
    fireEvent.click(screen.getByTestId('button-save-slot-menu'));
    expect((await screen.findByTestId('published-slot-group')).textContent).toContain('Published by admin');
    expect(screen.getByTestId('menu-save-slots').textContent).toContain('10/10');
    fireEvent.click(screen.getByTestId('button-select-published-published-1'));
    const card = await screen.findByTestId('shared-word-card-published-1-owner-only-card');
    expect(card.textContent).toContain('SSW_Manufacture_1');
    expect(card.textContent).toContain('factory work');
    expect(card.textContent).toContain('Noun');
    expect(card.textContent).toContain('名詞');
    expect(card.textContent).toContain('read-only');
    expect(card.querySelector('button')).toBeNull();
    fireEvent.click(screen.getByTestId('button-save-slot-menu'));
    fireEvent.click(screen.getByTestId('button-select-slot-slot-0'));
    expect(screen.queryByTestId('shared-word-card-published-1-owner-only-card')).toBeNull();
    fireEvent.click(screen.getByTestId('button-save-slot-menu'));
    fireEvent.click(screen.getByTestId('button-select-published-published-1'));
    expect(fake.me.lists).toHaveLength(10);
    expect(screen.getByTestId('button-cabinet-practice').getAttribute('href')).toContain('sharedDeck=published-1');
    fake.sharedDecks[0].cards[0].meaning = 'production';
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByTestId('shared-word-card-published-1-owner-only-card').textContent).toContain('production'));
    fake.sharedDecks = [];
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByTestId('shared-word-card-published-1-owner-only-card')).toBeNull());
    expect(fake.me.lists).toHaveLength(10);
  });
  it('reviews and plays an authorized published deck in the existing casual quiz', async () => {
    navigate('/review'); render(<App />);
    fireEvent.click(await screen.findByTestId('discovery-filter-all'));
    await waitFor(() => expect(screen.getAllByTestId('review-card-row').every(row => !row.textContent?.includes('特殊製造語'))).toBe(true));
    await goto('/review?sharedDeck=published-1');
    expect(await screen.findByText('SSW_Manufacture_1')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('review-card-row').some(row =>
      row.textContent?.includes('特殊製造語') && row.textContent.includes('Noun') && row.textContent.includes('名詞'),
    )).toBe(true));
    await goto('/quiz?setup=casual');
    fireEvent.click(await screen.findByTestId('quiz-shared-published-1'));
    await waitFor(() => expect((screen.getByTestId('button-start-quiz') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('button-start-quiz'));
    const quizCard = await screen.findByTestId('quiz-card');
    expect(quizCard.textContent).toContain('特殊製造語');
    expect(quizCard.textContent).toContain('Noun');
    expect(quizCard.textContent).toContain('名詞');
    expect(fake.me.lists).toHaveLength(1);
  });
  it('opens the published slot directly in quiz setup from Cabinet', async () => {
    navigate('/cabinet'); render(<App />);
    fireEvent.click(await screen.findByTestId('button-save-slot-menu'));
    fireEvent.click(await screen.findByTestId('button-select-published-published-1'));
    fireEvent.click(screen.getByTestId('button-cabinet-practice'));
    expect((await screen.findByTestId('quiz-shared-published-1')).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('button-start-quiz'));
    expect((await screen.findByTestId('quiz-card')).textContent).toContain('特殊製造語');
  });
  it('does not start a guessed or revoked shared deck URL', async () => {
    navigate('/quiz?run=1&sharedDeck=not-visible&count=1'); render(<App />);
    expect(await screen.findByText('This shared deck is no longer available to you.')).toBeTruthy();
    expect(screen.queryByTestId('quiz-card')).toBeNull();
  });
});
