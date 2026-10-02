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
function navigate(path: string) { window.history.pushState({}, '', path); }
async function goto(path: string) { await act(async () => { navigate(path); }); }
function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  resetFake({
    lists: [{ id: 'default-slot', name: 'Slot 1', wordIds: [], createdAt: '2026-01-01' }],
    activeId: 'default-slot', customWords: [], history: [],
  });
  fake.uid = 'learner';
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  navigate('/');
});
afterEach(() => cleanup());

describe('manual custom cards remain accessible alongside CSV import', () => {
  it('opens the manual card form from the desktop home sidebar', async () => {
    render(<App />);
    const link = await screen.findByTestId('archive-rail-custom');
    expect(link.getAttribute('href')).toBe('/custom');
    expect(link.textContent).toContain('My words');
    fireEvent.click(link);
    await screen.findByTestId('add-form');
    expect(screen.getByTestId('add-submit').textContent).toContain('Add to drawer');
  });

  it('opens the manual card form from the mobile More menu', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('home-dock-more'));
    fireEvent.click(await screen.findByTestId('mobile-nav-my-words'));
    await screen.findByTestId('add-form');
    expect(window.location.pathname).toBe('/custom');
  });

  it('creates, reloads, edits and deletes a custom card via the Cabinet shortcut', async () => {
    navigate('/cabinet');
    let view = render(<App />);
    expect(await screen.findByTestId('button-import-csv')).toBeTruthy();
    fireEvent.click(screen.getByTestId('button-create-custom-card'));
    await screen.findByTestId('add-form');
    // Wait for account hydration before writing.
    await waitFor(() => expect(localStorage.getItem('kotoba-custom-words')).toBe('[]'));
    fill('add-expression', '私の造語');
    fill('add-reading', 'わたしのぞうご');
    fill('add-meaning', 'my invented word');
    fireEvent.change(screen.getByTestId('add-part-of-speech-en'), { target: { value: 'Noun' } });
    fireEvent.click(screen.getByTestId('add-level-N3'));
    fireEvent.click(screen.getByTestId('add-submit'));
    await waitFor(() => expect(fake.me.customWords).toHaveLength(1));
    const id = fake.me.customWords[0].id;
    expect(fake.me.customWords[0]).toMatchObject({
      expression: '私の造語', reading: 'わたしのぞうご', meaning: 'my invented word', level: 'N3',
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞',
    });
    expect(screen.getByTestId(`custom-word-${id}`).textContent).toContain('my invented word');
    expect(screen.getByTestId(`custom-word-${id}`).textContent).toContain('Noun');
    expect(screen.getByTestId(`custom-word-${id}`).textContent).toContain('名詞');

    view.unmount();
    // Confirm reload comes from the account, not only browser cache.
    localStorage.removeItem('kotoba-custom-words');
    view = render(<App />);
    expect((await screen.findByTestId(`custom-word-${id}`)).textContent).toContain('my invented word');
    fireEvent.click(screen.getByTestId(`button-edit-custom-${id}`));
    fill(`edit-${id}-meaning`, 'updated personal meaning');
    fireEvent.change(screen.getByTestId(`edit-${id}-part-of-speech-en`), { target: { value: 'Verb' } });
    fireEvent.click(screen.getByTestId(`edit-${id}-submit`));
    await waitFor(() => expect(fake.me.customWords[0]).toMatchObject({
      meaning: 'updated personal meaning', partOfSpeechEn: 'Verb', partOfSpeechJp: '動詞',
    }));

    await goto('/cabinet');
    fill('input-search', '私の造語');
    await waitFor(() => expect(screen.getByTestId('cabinet-grid').textContent).toContain('私の造語'));
    await goto('/custom');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(await screen.findByTestId(`button-delete-custom-${id}`));
    await waitFor(() => expect(fake.me.customWords).toHaveLength(0));
    expect(screen.queryByTestId(`custom-word-${id}`)).toBeNull();
  });
});
