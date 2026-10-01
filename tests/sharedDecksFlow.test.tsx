// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminPublishDecks } from '@/components/AdminPublishDecks';

const state = vi.hoisted(() => ({ publications: [] as Array<Record<string, any>> }));
vi.mock('@/lib/api', () => ({
  api: {
    adminDeckSources: async () => ({ lists: [{ id: 'ssw', name: 'SSW_Manufacture_1', cardCount: 1 }] }),
    adminSharedDecks: async () => ({ decks: state.publications }),
    publishDeck: async (input: any) => {
      const id = 'published-1';
      state.publications = [{ id, name: 'SSW_Manufacture_1', cardCount: 1, sourceUid: input.sourceUid,
        sourceListId: input.listId, visibility: input.visibility, recipientUids: input.recipientUids, updatedAt: 'today' }];
      return { id, ok: true };
    },
    updatePublishedDeck: async (id: string, input: any) => { state.publications = state.publications.map(deck => deck.id === id ? { ...deck, ...input } : deck); return { ok: true }; },
    unpublishDeck: async () => { state.publications = []; return { ok: true }; },
  },
}));
beforeEach(() => { state.publications = []; vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('admin publication controls', () => {
  it('publishes a private source list for selected UIDs, changes its audience and unpublishes it', async () => {
    render(<AdminPublishDecks sourceUid="owner" sourceVersion={1} />);
    const button = await screen.findByRole('button', { name: 'Publish deck' });
    fireEvent.change(screen.getByLabelText(/Recipient Firebase UIDs/), { target: { value: 'student-one' } });
    fireEvent.click(button);
    await waitFor(() => expect(state.publications[0]).toMatchObject({ sourceUid: 'owner', sourceListId: 'ssw', visibility: 'selected', recipientUids: ['student-one'] }));
    expect(screen.getByText(/Recipients can find its cards in Cabinet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Who can see it?'), { target: { value: 'public' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }));
    await waitFor(() => expect(state.publications[0]).toMatchObject({ visibility: 'public', recipientUids: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(state.publications).toHaveLength(0));
  });
});
