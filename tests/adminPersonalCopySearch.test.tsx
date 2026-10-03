import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPersonalWordsPanel } from '@/components/AdminPersonalWordsPanel';

const apiMocks = vi.hoisted(() => ({
  adminWords: vi.fn(), changeAdminWords: vi.fn(), adminContent: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error { isStale = false; },
}));
vi.mock('@/components/AdminPublishDecks', () => ({ AdminPublishDecks: () => null }));

beforeEach(() => {
  apiMocks.adminWords.mockResolvedValue({
    uid: 'source-user', nickname: 'Source', version: 1,
    customWords: [
      { id: 'cat', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'Custom', createdAt: '2026-01-01' },
      { id: 'dog', expression: '犬', reading: 'いぬ', meaning: 'dog', level: 'Custom', createdAt: '2026-01-01' },
    ], lists: [], groups: [],
  });
  apiMocks.adminContent.mockResolvedValue({ groups: [], batches: [], limits: { groups: 100, filesPerUpload: 10, rowsPerUpload: 5000 } });
});
afterEach(() => cleanup());

describe('personal-card copy search', () => {
  it('filters the copy picker with its own copyQuery, not the personal-card query', async () => {
    render(<AdminPersonalWordsPanel />);
    fireEvent.change(screen.getByLabelText('Target Firebase UID'), { target: { value: 'source-user' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load account' }));
    await screen.findByText('猫');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'does-not-match' } });
    await waitFor(() => expect(screen.queryByText('犬')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Choose personal content to copy' }));
    await screen.findByRole('checkbox', { name: 'Copy 猫' });
    expect(screen.getByRole('checkbox', { name: 'Copy 犬' })).not.toBeNull();

    const copySearch = screen.getAllByLabelText('Search')[0];
    fireEvent.change(copySearch, { target: { value: 'ねこ' } });
    expect(screen.getByRole('checkbox', { name: 'Copy 猫' })).not.toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Copy 犬' })).toBeNull();
  });
});
