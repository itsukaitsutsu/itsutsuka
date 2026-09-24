import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RankedLeaderboard as Board } from '@/lib/api';
const rankedLeaderboard = vi.fn<(by: 'points' | 'tier') => Promise<Board>>();
vi.mock('@/lib/api', () => ({ api: { rankedLeaderboard: (by: 'points' | 'tier') => rankedLeaderboard(by) } }));
import { RankedLeaderboard } from '@/components/RankedLeaderboard';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const row = (rank: number, uid: string, tier: Board['rows'][0]['tier'], points: number) => ({ rank, uid, displayName: uid.toUpperCase(), tier, points, masteredInTier: 5, tierTotal: 100, masteredTotal: 5, curses: 0, matches: 4, wins: 3 });
describe('ranked leaderboard', () => {
  it('renders Top Global rows with tier, points, progress and duel record', async () => {
    rankedLeaderboard.mockResolvedValue({ by: 'points', total: 2, rows: [row(1, 'aki', 'N5', 500), row(2, 'ben', 'N2', 40)], me: row(2, 'ben', 'N2', 40) });
    render(<RankedLeaderboard by="points" currentUid="ben" />);
    await waitFor(() => expect(screen.getByTestId('ranked-row-1')).toBeTruthy());
    expect(rankedLeaderboard).toHaveBeenCalledWith('points');
    expect(screen.getByTestId('ranked-row-1').textContent).toContain('🥇');
    expect(screen.getByTestId('ranked-row-2').textContent).toContain('(you)');
    expect(screen.getByTestId('ranked-row-1').textContent).toContain('5/100');
    expect(screen.getByTestId('ranked-row-1').textContent).toContain('3–1 · 75%');
    expect(screen.getByText(/you are #2/)).toBeTruthy();
  });
  it('appends the caller below the top list when they are outside it', async () => {
    rankedLeaderboard.mockResolvedValue({ by: 'tier', total: 80, rows: [row(1, 'aki', 'N1', 10)], me: row(77, 'me', 'N5', 1) });
    render(<RankedLeaderboard by="tier" currentUid="me" />);
    await waitFor(() => expect(screen.getByTestId('ranked-row-77')).toBeTruthy());
    expect(screen.getByText(/79 more players/)).toBeTruthy();
    expect(rankedLeaderboard).toHaveBeenCalledWith('tier');
  });
  it('explains how to get listed when the board is empty', async () => {
    rankedLeaderboard.mockResolvedValue({ by: 'points', total: 0, rows: [], me: null });
    render(<RankedLeaderboard by="points" />);
    await waitFor(() => expect(screen.getByText(/No ranked players with a nickname yet/)).toBeTruthy());
  });
});
