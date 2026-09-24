import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyMastered } from '../shared/ranked';
vi.mock('wouter', () => ({ useLocation: () => ['/quiz', vi.fn()] }));
// RankedSetup syncs ranked mastery into the card library, which reaches auth.
vi.mock('@/utils/firebase/client', () => ({ auth: { currentUser: null } }));
vi.mock('@/auth/useAuth', () => ({ useAuth: () => ({ user: { uid: 'alice' } }) }));
vi.mock('@/components/SoundSettings', () => ({ SoundSettings: () => null }));
vi.mock('@/components/RankedPartyModal', () => ({ RankedPartyModal: () => null }));
const createSoloRanked = vi.fn().mockResolvedValue({ matchId: 'm1' });
vi.mock('@/lib/api', () => ({ api: {
  rankedAccount: async () => ({ account: { points: 0, tier: 'N5', mastered: emptyMastered(), version: 0, activeMatch: null, cursed: emptyMastered() } }),
  initializeRanked: vi.fn(), createSoloRanked: (...args: unknown[]) => createSoloRanked(...args),
} }));
import { RankedSetup } from '@/components/RankedMode';
afterEach(cleanup);
const field = () => screen.getByLabelText('Cards in this round') as HTMLInputElement;
describe('cards-in-this-round input', () => {
  it('can be cleared and retyped without snapping back to 1', async () => {
    render(<RankedSetup />); await waitFor(() => field());
    fireEvent.change(field(), { target: { value: '' } }); expect(field().value).toBe('');
    expect(screen.getByRole('status').textContent).toMatch(/whole number from 1 to/);
    fireEvent.change(field(), { target: { value: '2' } }); fireEvent.change(field(), { target: { value: '25' } });
    expect(field().value).toBe('25'); expect(screen.queryByRole('status')).toBeNull();
  });
  it('clamps only when leaving the field and sends the clamped value', async () => {
    render(<RankedSetup />); await waitFor(() => field());
    const max = Number(field().max);
    fireEvent.change(field(), { target: { value: '0' } }); expect(field().value).toBe('0');
    fireEvent.blur(field()); expect(field().value).toBe('1');
    fireEvent.change(field(), { target: { value: String(max + 500) } }); fireEvent.blur(field()); expect(field().value).toBe(String(max));
    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Start solo|Start round|Start/ }));
    await waitFor(() => expect(createSoloRanked).toHaveBeenCalled());
    expect(createSoloRanked.mock.calls.at(-1)![0]).toBe(1);
  });
});
