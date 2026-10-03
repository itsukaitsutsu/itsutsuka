import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminContentLibraryPanel } from '@/components/AdminContentLibraryPanel';

const apiMocks = vi.hoisted(() => ({
  currentUid: vi.fn(), adminContent: vi.fn(), adminContentCards: vi.fn(), adminContentEvents: vi.fn(),
  adminSharedDecks: vi.fn(), deleteAdminContentCards: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMocks }));

beforeEach(() => {
  apiMocks.currentUid.mockReturnValue('admin');
  apiMocks.adminContent.mockResolvedValue({ groups: [], batches: [], limits: { groups: 100, filesPerUpload: 10, rowsPerUpload: 5000 } });
  apiMocks.adminContentCards.mockResolvedValue({ cards: [
    { id: 'card-1', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', batchIds: ['batch-1'], groupIds: [] },
    { id: 'card-2', expression: '犬', reading: 'いぬ', meaning: 'dog', level: 'N5', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', batchIds: ['batch-1'], groupIds: [] },
  ], truncated: false });
  apiMocks.adminContentEvents.mockResolvedValue({ events: [] });
  apiMocks.adminSharedDecks.mockResolvedValue({ decks: [] });
  apiMocks.deleteAdminContentCards.mockResolvedValue({ ok: true, eventId: 'event-1', deleted: 1, removedReferences: 1 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('admin content card selection', () => {
  it('checks and unchecks rows by dragging from the first checkbox', async () => {
    render(<AdminContentLibraryPanel />);
    const first = await screen.findByRole('checkbox', { name: 'Select 猫' }) as HTMLInputElement;
    const second = screen.getByRole('checkbox', { name: 'Select 犬' }) as HTMLInputElement;

    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(second.closest('tr')!);
    expect([first.checked, second.checked]).toEqual([true, true]);
    await act(async () => {
      fireEvent.mouseUp(window);
      await new Promise(resolve => setTimeout(resolve, 1));
    });

    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(second.closest('tr')!);
    expect([first.checked, second.checked]).toEqual([false, false]);
    await act(async () => {
      fireEvent.mouseUp(window);
      await new Promise(resolve => setTimeout(resolve, 1));
    });
  });

  it('deletes selected cards from the whole admin catalog after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminContentLibraryPanel />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Select 猫' });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected from catalog (1)' }));
    await waitFor(() => expect(apiMocks.deleteAdminContentCards).toHaveBeenCalledWith(['card-1']));
    expect(window.confirm).toHaveBeenCalled();
  });
});
