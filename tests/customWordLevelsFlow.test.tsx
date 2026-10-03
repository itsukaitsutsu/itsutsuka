import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { CUSTOM_LEVELS } from '@/lib/customWords';

vi.mock('@/lib/api', () => import('./helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return {
    useAuth: () => ({ user: fake.uid ? { uid: fake.uid, email: 'learner@example.com' } : null, loading: false, logout: vi.fn() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/utils/firebase/client', () => ({ auth: {}, db: {} }));
// Exercise the shooter's deck selection without requiring a GPU in jsdom.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class { constructor() { throw new Error('No GPU in tests'); } } };
});
const { fake, resetFake } = await import('./helpers/fakeApi');
const navigate = (path: string) => window.history.pushState({}, '', path);
async function goto(path: string) { await act(async () => navigate(path)); }
function fill(id: string, value: string) { fireEvent.change(screen.getByTestId(id), { target: { value } }); }

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  resetFake({ lists: [{ id: 'slot-1', name: 'Slot 1', wordIds: [], createdAt: '2026-01-01' }], activeId: 'slot-1', customWords: [], history: [] });
  fake.uid = 'learner';
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => cleanup());

describe('personal-word level choices', () => {
  it('defaults new My words to Custom, supports later edits and persists after reload', async () => {
    navigate('/custom'); let view = render(<App />);
    await screen.findByTestId('add-form');
    await waitFor(() => expect(localStorage.getItem('kotoba-custom-words')).toBe('[]'));
    expect(screen.getByTestId('add-level-Custom').getAttribute('aria-pressed')).toBe('true');
    for (const level of CUSTOM_LEVELS) expect(screen.getByTestId(`add-level-${level}`)).toBeTruthy();
    fill('add-expression', '私の新造語'); fill('add-reading', 'わたしのしんぞうご'); fill('add-meaning', 'my new word');
    fireEvent.click(screen.getByTestId('add-submit'));
    expect(screen.getByTestId('add-level-Custom').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(fake.me.customWords).toHaveLength(1));
    const id = fake.me.customWords[0].id;
    expect(fake.me.customWords[0].level).toBe('Custom');
    expect(screen.getByTestId(`custom-word-${id}`).textContent).toContain('Custom');

    fireEvent.click(screen.getByTestId(`button-edit-custom-${id}`));
    fireEvent.click(screen.getByTestId(`edit-${id}-level-N4`));
    fireEvent.click(screen.getByTestId(`edit-${id}-submit`));
    await waitFor(() => expect(fake.me.customWords[0].level).toBe('N4'));
    view.unmount(); localStorage.removeItem('kotoba-custom-words'); view = render(<App />);
    expect((await screen.findByTestId(`custom-word-${id}`)).textContent).toContain('N4');
    fireEvent.click(screen.getByTestId(`button-edit-custom-${id}`));
    fireEvent.click(screen.getByTestId(`edit-${id}-level-Custom`));
    fireEvent.click(screen.getByTestId(`edit-${id}-submit`));
    await waitFor(() => expect(fake.me.customWords[0].level).toBe('Custom'));
    view.unmount(); localStorage.removeItem('kotoba-custom-words'); render(<App />);
    expect((await screen.findByTestId(`custom-word-${id}`)).textContent).toContain('Custom');

    await goto('/cabinet');
    fireEvent.click(screen.getByTestId('filter-Custom'));
    expect((await screen.findByTestId('cabinet-grid')).textContent).toContain('私の新造語');
    await goto('/review');
    expect(screen.getByRole('option', { name: 'Custom' })).toBeTruthy();
    await goto('/quiz?decks=MY_WORDS');
    await waitFor(() => expect((screen.getByTestId('button-start-quiz') as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(['Custom', 'N3'])('keeps the import selector and saves the chosen %s drawer', async (choice) => {
    navigate('/cabinet'); render(<App />);
    fireEvent.click(await screen.findByTestId('button-import-csv'));
    const text = 'expression,reading,meaning\n私の新造語,わたしのしんぞうご,my new word';
    const file = new File([text], 'custom.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
    fireEvent.change(screen.getByTestId('input-bulk-csv'), { target: { files: [file] } });
    const select = await screen.findByTestId('select-import-level') as HTMLSelectElement;
    expect(select.value).toBe('Custom');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(CUSTOM_LEVELS);
    fireEvent.change(select, { target: { value: choice } });
    fireEvent.click(screen.getByTestId('button-confirm-csv-import'));
    await screen.findByTestId('bulk-import-success');
    expect(fake.me.customWords[0]).toMatchObject({ level: choice, meaning: 'my new word' });
    fireEvent.click(screen.getByText('Go to My words'));
    const id = fake.me.customWords[0].id;
    fireEvent.click(await screen.findByTestId(`button-edit-custom-${id}`));
    fireEvent.click(screen.getByTestId(`edit-${id}-level-N2`));
    fireEvent.click(screen.getByTestId(`edit-${id}-submit`));
    await waitFor(() => expect(fake.me.customWords[0].level).toBe('N2'));
  });
  it('includes Custom in quiz setup and starts a round from that level', async () => {
    resetFake({ customWords: [
      { id: 'custom-level-card', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'my new word', level: 'Custom', createdAt: '2026-01-01' },
      { id: 'n4-personal-card', expression: '別の造語', reading: 'べつのぞうご', meaning: 'another word', level: 'N4', createdAt: '2026-01-01' },
    ] });
    navigate('/custom'); render(<App />);
    await screen.findByTestId('custom-word-custom-level-card');
    await waitFor(() => expect(localStorage.getItem('kotoba-custom-words')).toContain('custom-level-card'));
    await goto('/quiz?setup=casual&decks=Custom');
    fireEvent.click(await screen.findByTestId('quiz-drawers-trigger'));
    for (const level of CUSTOM_LEVELS) expect(screen.getByTestId(`quiz-level-${level}`)).toBeTruthy();
    expect(screen.getByTestId('quiz-level-Custom').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect((screen.getByTestId('button-start-quiz') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('button-start-quiz'));
    expect((await screen.findByTestId('quiz-card')).textContent).toContain('私の新造語');
    expect(screen.getByTestId('quiz-card').textContent).toContain('Custom');
  });

  it('passes the selected Custom level through to the shooter round', async () => {
    resetFake({ customWords: [{ id: 'custom-level-card', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'my new word', level: 'Custom', createdAt: '2026-01-01' }] });
    navigate('/custom'); render(<App />);
    await screen.findByTestId('custom-word-custom-level-card');
    await waitFor(() => expect(localStorage.getItem('kotoba-custom-words')).toContain('custom-level-card'));
    await goto('/quiz?setup=casual&decks=Custom');
    await waitFor(() => expect((screen.getByTestId('button-start-aim-shooter') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('button-start-aim-shooter'));
    expect((await screen.findByTestId('aim-shooter-mode')).textContent).toContain('MISSION / Custom');
    expect(screen.queryByText('No cards for this shooter round.')).toBeNull();
  });

  it('keeps Custom available in library practice links and the progress breakdown', async () => {
    resetFake({ customWords: [{ id: 'custom-level-card', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'my new word', level: 'Custom', createdAt: '2026-01-01' }] });
    navigate('/review'); render(<App />);
    const levelSelect = await screen.findByRole('combobox', { name: 'Level' });
    expect(within(levelSelect).getAllByRole('option').slice(1).map(option => option.textContent)).toEqual(CUSTOM_LEVELS);
    fireEvent.change(levelSelect, { target: { value: 'Custom' } });
    expect(screen.getByTestId('review-practice-link').getAttribute('href')).toContain('decks=Custom');
    await goto('/progress');
    expect(await screen.findByText('Custom vocabulary')).toBeTruthy();
  });

});
