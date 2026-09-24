import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { vocabulary } from '@/lib/vocabulary';
import { loadSeenKeys, saveSeenKeys, wordProgressKey } from '@/lib/cardProgress';
import App from '@/App';
import sample from './fixtures/new_bulk_test.csv?raw';

vi.mock('@/lib/api', () => import('../tests/helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('../tests/helpers/fakeApi');
  return {
    useAuth: () => ({ user: fake.uid ? { uid: fake.uid, email: 'learner@example.com' } : null, loading: false, logout: vi.fn() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/utils/firebase/client', () => ({ auth: {}, db: {} }));

const { fake, resetFake, ApiError } = await import('../tests/helpers/fakeApi');

function navigate(path: string) { window.history.pushState({}, '', path); }
/** Navigate after render: wouter reacts to the patched pushState, but React needs a flush. */
async function goto(path: string) { await act(async () => { navigate(path); }); }
function csvFile(text: string, name = 'new_bulk_test.csv') {
  const file = new File([text], name, { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}
async function upload(text = sample) {
  fireEvent.click(await screen.findByTestId('button-import-csv'));
  fireEvent.change(screen.getByTestId('input-bulk-csv'), { target: { files: [csvFile(text)] } });
  await screen.findByTestId('bulk-import-counts');
}

describe('bulk import flow', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    resetFake({
      lists: [{ id: 'default-slot', name: 'Slot 1', wordIds: [], createdAt: '2026-01-01' }],
      activeId: 'default-slot', customWords: [], history: [],
    });
    fake.uid = 'learner';
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('imports the provided CSV into a new active Cabinet slot, adds only 命綱, preserves Seen progress and survives reload', async () => {
    const known = vocabulary.find((word) => word.expression === '作法' && word.reading === 'さほう')!;
    saveSeenKeys('learner', new Set([wordProgressKey(known)]));
    navigate('/'); const view = render(<App />);
    await upload();
    expect(screen.getByTestId('bulk-import-counts').textContent).toContain('772');
    expect(screen.getByTestId('bulk-import-counts').textContent).toContain('773');
    expect(screen.getByTestId('bulk-import-seen-summary').textContent).toContain('1 already Seen · 772 New');
    expect(fake.me.lists).toHaveLength(1); // Preview never writes.
    expect(fake.me.customWords).toHaveLength(0);
    fireEvent.click(screen.getByTestId('button-confirm-csv-import'));
    await screen.findByTestId('bulk-import-success');
    expect(fake.me.lists).toHaveLength(2);
    const imported = fake.me.lists.find((list: any) => list.id === fake.me.activeId);
    expect(imported.name).toBe('new_bulk_test');
    expect(imported.wordIds).toHaveLength(773);
    expect(fake.me.customWords).toHaveLength(1);
    expect(fake.me.customWords[0]).toMatchObject({ expression: '命綱', reading: 'いのちづな', meaning: '' });
    expect(imported.wordIds).toContain(fake.me.customWords[0].id);
    expect(loadSeenKeys('learner')).toEqual(new Set([wordProgressKey(known)]));
    fireEvent.click(screen.getByRole('button', { name: 'View imported slot' }));
    expect(screen.getByTestId('button-save-slot-menu').textContent).toContain('new_bulk_test');
    await screen.findByTestId('cabinet-grid');
    expect(screen.getByTestId('text-cabinet-page').textContent).toContain('773');
    view.unmount(); render(<App />);
    await waitFor(() => expect(screen.getByTestId('button-save-slot-menu').textContent).toContain('new_bulk_test'));
    await goto('/custom');
    expect((await screen.findByTestId(`custom-word-${fake.me.customWords[0].id}`)).textContent).toContain('Meaning not added yet');
  });

  it('does not save on cancel or network failure, then retries the same import safely', async () => {
    navigate('/'); render(<App />);
    await upload('expression,reading\n命綱,いのちづな');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(fake.me.customWords).toHaveLength(0);
    expect(fake.me.lists).toHaveLength(1);

    await upload('expression,reading\n命綱,いのちづな');
    fake.errors.saveMe = new ApiError(0, 'Cannot reach the server. Check your internet connection.');
    fireEvent.click(screen.getByTestId('button-confirm-csv-import'));
    await screen.findByText(/Import needs an online connection/);
    expect(fake.me.customWords).toHaveLength(0);
    expect(fake.me.lists).toHaveLength(1);

    fake.errors.saveMe = null;
    fireEvent.click(screen.getByTestId('button-confirm-csv-import'));
    await screen.findByTestId('bulk-import-success');
    expect(fake.me.customWords).toHaveLength(1);
    expect(fake.me.lists).toHaveLength(2);
  });

  it('shows malformed CSV errors and blocks imports when all slots are occupied', async () => {
    resetFake({
      lists: Array.from({ length: 10 }, (_, index) => ({ id: `slot-${index}`, name: `Slot ${index}`, wordIds: [], createdAt: '2026-01-01' })),
      activeId: 'slot-0', customWords: [], history: [],
    });
    navigate('/'); render(<App />);
    fireEvent.click(await screen.findByTestId('button-import-csv'));
    fireEvent.change(screen.getByTestId('input-bulk-csv'), { target: { files: [csvFile('wrong,headers\n猫,ねこ')] } });
    await screen.findByTestId('bulk-import-error');
    expect((screen.getByTestId('button-confirm-csv-import') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('input-bulk-csv'), { target: { files: [csvFile('expression,reading\n猫,ねこ')] } });
    await screen.findByTestId('bulk-import-counts');
    expect(screen.getByText(/All 10 save slots are in use/)).toBeTruthy();
    expect((screen.getByTestId('button-confirm-csv-import') as HTMLButtonElement).disabled).toBe(true);
    expect(fake.me.lists).toHaveLength(10);
  });

  it('keeps reading-only imports available for review but excludes them from meaning quizzes', async () => {
    resetFake({
      lists: [{ id: 'default-slot', name: 'Slot 1', wordIds: [], createdAt: '2026-01-01' }],
      activeId: 'default-slot',
      customWords: [{ id: 'reading-only', expression: '命綱', reading: 'いのちづな', meaning: '', level: 'N5', createdAt: '2026-01-01' }],
      history: [],
    });
    navigate('/'); render(<App />);
    await waitFor(() => expect(localStorage.getItem('kotoba-custom-words')).toContain('reading-only'));
    await goto('/quiz?decks=MY_WORDS');
    await screen.findByText(/1 cards need a meaning before quizzes/);
    expect((screen.getByTestId('button-start-quiz') as HTMLButtonElement).disabled).toBe(true);
    await goto('/quiz?run=1&decks=MY_WORDS&count=1');
    await screen.findByText(/cards with meanings available/);
    expect(screen.queryByTestId('quiz-card')).toBeNull();
    expect(loadSeenKeys('learner').size).toBe(0);
  });
});
