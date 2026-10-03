import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminWordsPage from '@/pages/AdminWordsPage';

const apiMocks = vi.hoisted(() => ({
  currentUid: vi.fn(),
  wordAdminStatus: vi.fn(),
  adminContent: vi.fn(),
  adminContentCards: vi.fn(),
  adminContentEvents: vi.fn(),
  adminSharedDecks: vi.fn(),
  adminWords: vi.fn(),
  changeAdminWords: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error { isStale = false; },
}));
vi.mock('@/components/AdminPublishDecks', () => ({ AdminPublishDecks: () => null }));

const customWords = [
  { id: 'one', expression: 'す', reading: 'す', meaning: 'do', level: 'Custom', createdAt: '2026-01-01' },
  { id: 'two', expression: 'ず', reading: 'ず', meaning: 'zu', level: 'Custom', createdAt: '2026-01-01' },
  { id: 'three', expression: 'せ', reading: 'せ', meaning: 'se', level: 'Custom', createdAt: '2026-01-01' },
];

async function loadAdminCards() {
  render(<AdminWordsPage />);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Personal cards' }), { button: 0 });
  await screen.findByLabelText('Target Firebase UID');
  fireEvent.change(screen.getByLabelText('Target Firebase UID'), { target: { value: 'learner' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load account' }));
  return Promise.all([
    screen.findByRole('checkbox', { name: 'Select す' }),
    screen.findByRole('checkbox', { name: 'Select ず' }),
    screen.findByRole('checkbox', { name: 'Select せ' }),
  ]).then(inputs => inputs as HTMLInputElement[]);
}

beforeEach(() => {
  apiMocks.currentUid.mockReturnValue('admin');
  apiMocks.wordAdminStatus.mockResolvedValue({ isAdmin: true });
  apiMocks.adminContent.mockResolvedValue({ groups: [], batches: [], limits: { groups: 100, filesPerUpload: 10, rowsPerUpload: 5000 } });
  apiMocks.adminContentCards.mockResolvedValue({ cards: [], truncated: false });
  apiMocks.adminContentEvents.mockResolvedValue({ events: [] });
  apiMocks.adminSharedDecks.mockResolvedValue({ decks: [] });
  apiMocks.adminWords.mockResolvedValue({
    uid: 'learner', nickname: 'Learner', version: 1, customWords, lists: [],
  });
});
afterEach(() => cleanup());

describe('admin card drag selection', () => {
  it('checks and unchecks cards dragged across from a checkbox', async () => {
    const [first, second, third] = await loadAdminCards();

    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(second.closest('tr')!);
    fireEvent.mouseEnter(third.closest('tr')!);
    expect([first.checked, second.checked, third.checked]).toEqual([true, true, true]);

    await act(async () => {
      fireEvent.mouseUp(window);
      await new Promise(resolve => setTimeout(resolve, 1));
    });

    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(second.closest('tr')!);
    fireEvent.mouseEnter(third.closest('tr')!);
    expect([first.checked, second.checked, third.checked]).toEqual([false, false, false]);
  });

  it('keeps a regular click working when the user is not dragging', async () => {
    const [first] = await loadAdminCards();
    fireEvent.click(first);
    expect(first.checked).toBe(true);
    fireEvent.click(first);
    expect(first.checked).toBe(false);
  });
});
