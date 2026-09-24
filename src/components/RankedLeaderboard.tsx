import { useEffect, useState } from 'react';
import { Crown, Medal, Swords } from 'lucide-react';
import { api, type RankedLeaderboard as Board, type RankedLeaderRow } from '@/lib/api';
import { cn } from '@/lib/utils';

export type RankedBoardKind = 'points' | 'tier';
const medal = (rank: number) => rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);
const TIER_STYLE: Record<RankedLeaderRow['tier'], string> = {
  N1: 'border-[hsl(var(--accent))] text-[hsl(var(--accent))]', N2: 'border-[hsl(var(--secondary))] text-[hsl(var(--secondary))]',
  N3: 'border-border', N4: 'border-border text-muted-foreground', N5: 'border-border text-muted-foreground',
};
const winRate = (r: RankedLeaderRow) => r.matches ? `${Math.round(r.wins / r.matches * 100)}%` : '—';

/** Ranked-only boards. `points` = Top Global (ranked points); `tier` = Top Rank (tier, then closest to promotion). */
export function RankedLeaderboard({ by, currentUid }: { by: RankedBoardKind; currentUid?: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setBoard(null); setError('');
    api.rankedLeaderboard(by).then(b => { if (active) setBoard(b); }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [by]);

  const Row = ({ r, highlight }: { r: RankedLeaderRow; highlight?: boolean }) =>
    <tr className={cn('border-t border-border', (highlight || r.uid === currentUid) && 'bg-[hsl(var(--accent)/.10)] font-bold')} data-testid={`ranked-row-${r.rank}`}>
      <td className="p-3 font-mono text-muted-foreground">{by === 'tier' && r.rank <= 3 ? <Crown size={16} className="inline text-[hsl(var(--accent))]" aria-label={`Rank ${r.rank}`} /> : medal(r.rank)}</td>
      <td className="p-3">{r.displayName}{r.uid === currentUid && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}</td>
      <td className="p-3"><span className={cn('rounded-lg border px-2 py-0.5 text-xs font-bold', TIER_STYLE[r.tier])}>{r.tier}</span></td>
      <td className="p-3 text-right"><span className="inline-flex items-center gap-1.5 font-bold"><Medal size={14} className="text-[hsl(var(--accent))]" />{r.points.toLocaleString()}</span></td>
      <td className="p-3 text-right"><span title={`${r.masteredInTier} of ${r.tierTotal} ${r.tier} cards mastered`}>{r.masteredInTier}/{r.tierTotal}</span><span className="ml-1 text-xs text-muted-foreground">({r.tierTotal ? Math.floor(r.masteredInTier / r.tierTotal * 100) : 0}%)</span></td>
      <td className="p-3 text-right text-muted-foreground">{r.masteredTotal.toLocaleString()}</td>
      <td className="p-3 text-right text-muted-foreground">{r.matches ? <span title={`${r.wins} wins / ${r.matches} duels`}>{r.wins}–{r.matches - r.wins} · {winRate(r)}</span> : '—'}</td>
    </tr>;

  return <section className="mt-4 overflow-hidden rounded-[1.75rem] border border-border bg-card" data-testid={`ranked-leaderboard-${by}`}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-bold"><Swords size={15} className="text-[hsl(var(--accent))]" />{by === 'points' ? 'Top Global · ranked points' : 'Top Rank · highest tier'}</p>
      <p className="text-xs text-muted-foreground">{by === 'points' ? 'Sorted by ranked points. Ties: higher tier, then more mastered cards.' : 'Sorted by tier (N1 highest). Ties: closest to promotion, then points.'}</p>
    </div>
    {board === null && !error && <p className="p-8 text-center text-sm text-muted-foreground" role="status">Loading…</p>}
    {error && <p className="p-8 text-center text-sm text-destructive" role="alert">{error}</p>}
    {board && board.rows.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No ranked players with a nickname yet. Set a nickname above and play a ranked round to appear here.</p>}
    {board && board.rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead className="bg-muted text-left"><tr>
        <th className="mono-label p-3">#</th><th className="mono-label p-3">Player</th><th className="mono-label p-3">Tier</th>
        <th className="mono-label p-3 text-right">Ranked pts</th><th className="mono-label p-3 text-right">Tier progress</th>
        <th className="mono-label p-3 text-right">Mastered</th><th className="mono-label p-3 text-right">Duels W–L</th>
      </tr></thead>
      <tbody>
        {board.rows.map(r => <Row key={r.uid} r={r} />)}
        {board.me && !board.rows.some(r => r.uid === board.me!.uid) && <>
          <tr className="border-t border-border"><td colSpan={7} className="p-2 text-center text-xs text-muted-foreground">… {board.total - board.rows.length} more players …</td></tr>
          <Row r={board.me} highlight />
        </>}
      </tbody>
    </table></div>}
    {board && <p className="border-t border-border bg-muted/40 px-4 py-2.5 text-[11px] text-muted-foreground">{board.total} ranked {board.total === 1 ? 'player' : 'players'} · top {Math.min(50, board.total)} shown{board.me ? ` · you are #${board.me.rank}` : ' · set a nickname to be listed'}. Only ranked mode counts; casual study never affects this board.</p>}
  </section>;
}
