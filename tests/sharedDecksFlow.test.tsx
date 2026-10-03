// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminPublishDecks } from '@/components/AdminPublishDecks';

const state = vi.hoisted(() => ({
  publications: [] as Array<Record<string, any>>,
  lists: [{ id: 'ssw', name: 'SSW_Manufacture_1', cardCount: 1 }],
}));
vi.mock('@/lib/api', () => ({
  api: {
    adminDeckSources: async () => ({ lists: state.lists }),
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
beforeEach(() => { state.publications = []; state.lists = [{ id: 'ssw', name: 'SSW_Manufacture_1', cardCount: 1 }]; vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('admin publication controls', () => {
  it('publishes a private source list for selected UIDs, changes its audience and unpublishes it', async () => {
    render(<AdminPublishDecks sourceUid="owner" sourceVersion={1} />);
    const button = await screen.findByRole('button', { name: 'Publish deck' });
    expect(screen.getByText(/Publishing creates a separate copy/)).toBeTruthy();
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

  it('shows an orphaned published copy and keeps its admin removal control available', async () => {
    state.lists = [];
    state.publications = [{ id: 'orphan', name: 'Archived deck', cardCount: 2, sourceUid: 'owner',
      sourceListId: 'ssw', visibility: 'public', recipientUids: [], updatedAt: 'today' }];
    render(<AdminPublishDecks sourceUid="owner" sourceVersion={2} />);
    expect(await screen.findByText(/Original save slot removed; published copy remains available/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit audience' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Unpublish' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(state.publications).toHaveLength(0));
  });
});
