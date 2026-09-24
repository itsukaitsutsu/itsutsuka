import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Trophy, Users, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { SoundSettings } from './SoundSettings';
import { RankedPartyModal } from './RankedPartyModal';
import type { RankedAccount } from '../../shared/ranked';
import { isValidReviewMs, RULES, TIERS } from '../../shared/ranked';
import { vocabulary } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';

export function RankedSetup({ initialCount = 10 }: { initialCount?: number }) {
  const [, navigate] = useLocation();
  const [account, setAccount] = useState<RankedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  // Keep the raw text so the field can be cleared while typing; clamp only on blur/submit.
  const [countText, setCountText] = useState(String(initialCount));
 const [soloReviewSeconds, setSoloReviewSeconds] = useState(
    String(RULES.reviewMs / 1000)
  );

  const soloReviewMs = Number(soloReviewSeconds) * 1000;
  const validSoloReview =
    soloReviewSeconds.trim() !== '' && isValidReviewMs(soloReviewMs);
  const [legacy, setLegacy] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    api.rankedAccount().then(async ({ account: saved }) => {
      if (!active) return;
      if (saved) { setAccount(saved); return; }
      let old: unknown = null;
      try { old = JSON.parse(localStorage.getItem('kotoba-ranked-v1') || 'null'); } catch { /* invalid cache */ }
      if (old) setLegacy(old);
      else { const initialized = await api.initializeRanked(); if (active) setAccount(initialized.account); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const initialize = async (importOld: boolean) => {
    setBusy(true); setError('');
    try { const result = await api.initializeRanked(importOld ? legacy : {}); setAccount(result.account); setLegacy(null); if (importOld) localStorage.removeItem('kotoba-ranked-v1'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const total = account ? vocabulary.filter(w => w.level === account.tier).length : 0;
  const mastered = account ? account.mastered[account.tier].length : 0;
  const clampCount = (value: string) => Math.max(1, Math.min(Math.max(1, total), Math.floor(Number(value)) || 1));
  const count = clampCount(countText);
  const countValid = countText.trim() !== '' && Number.isInteger(Number(countText)) && Number(countText) >= 1 && Number(countText) <= total;
  const commitCount = () => setCountText(String(count));
  const start = async () => {
        if (!validSoloReview) return;
    setBusy(true); setError('');
    try { const match = await api.createSoloRanked(count, soloReviewMs); navigate(`/ranked/room/${match.matchId}`); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <><section data-testid="ranked-setup" className="rounded-[1.75rem] border border-[hsl(var(--accent)/.45)] bg-card p-6 md:p-8">
    <p className="mono-label flex items-center gap-2 text-[hsl(var(--accent))]"><Trophy size={16} /> Competitive deck</p>
    <h2 className="mt-2 font-serif text-3xl">Ranked</h2>
    <p className="mt-2 text-sm text-muted-foreground">Your points and mastery now follow your account across devices. Casual progress stays separate.</p>
    {loading && <p className="mt-6" role="status">Loading ranked account…</p>}
    {legacy && !account ? <div className="mt-6 rounded-xl bg-muted p-4"><h3 className="font-bold">Move your old ranked progress?</h3><p className="mt-2 text-sm">This browser has legacy progress. Import it only if it belongs to you. This is a one-time import; positive points are capped at the number of valid mastered cards.</p><div className="mt-4 flex gap-3"><button disabled={busy} onClick={() => initialize(true)} className="rounded-xl border px-4 py-2">Import my progress</button><button disabled={busy} onClick={() => initialize(false)} className="rounded-xl border px-4 py-2">Start fresh</button></div></div> : null}
    {account && <>
      <div className="mt-6 flex justify-between rounded-2xl bg-muted p-5"><div><p className="mono-label">Current tier</p><p className="mt-2 font-serif text-4xl">{account.tier}</p></div><div className="text-right"><p className="mono-label">Ranked points</p><p className="mt-2 font-serif text-4xl">{account.points.toLocaleString()}</p></div></div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-muted"><div className="h-full bg-[hsl(var(--accent))]" style={{ width: `${Math.min(100, mastered / Math.max(1, total) * 100)}%` }} /></div>
      <p className="mt-2 text-xs text-muted-foreground">{mastered} / {total} mastered · first-time solo mastery earns points</p>
      {!!Object.values(account.cursed ?? {}).flat().length && <p className="mt-4 rounded-xl border p-4 text-sm">Cursed cards to repair: {Object.values(account.cursed ?? {}).flat().length}. They come first in your next solo or shared party round. Correct repairs restore mastery without points; misses still count toward four mistakes.</p>}
      <div className="mt-5 grid grid-cols-5 gap-2">{TIERS.map(tier => <span key={tier} className={cn('rounded-lg border p-2 text-center text-xs font-bold', tier === account.tier && 'border-[hsl(var(--accent))] text-[hsl(var(--accent))]')}>{tier}</span>)}</div>
      {account.activeMatch ? <div className="mt-6"><p className="text-sm">You have a live ranked round. Its timer continues while disconnected.</p><button onClick={() => navigate(`/ranked/room/${account.activeMatch}`)} className="mt-3 rounded-xl border px-5 py-3 font-bold">Resume live round</button></div> : <>
        <label className="mt-6 block text-sm font-bold">Cards in this round<input aria-label="Cards in this round" type="number" inputMode="numeric" min="1" max={total} step="1" value={countText} onChange={e => setCountText(e.target.value)} onBlur={commitCount} onKeyDown={e => { if (e.key === 'Enter') commitCount(); }} aria-invalid={!countValid} className={cn('ml-3 w-24 rounded-lg border bg-background p-2', !countValid && 'border-destructive')} /></label>
        {!countValid && <p role="status" className="mt-2 text-xs text-destructive">Enter a whole number from 1 to {total}. It will be adjusted to {count} when you leave the field.</p>}
                <div className="mt-5 rounded-xl border border-border p-4">
          <label
            htmlFor="solo-review-seconds"
            className="block text-sm font-bold"
          >
            Solo review time (seconds)
          </label>

          <input
            id="solo-review-seconds"
            type="number"
            min="0"
            max="10"
            step="0.5"
            value={soloReviewSeconds}
            onChange={e => setSoloReviewSeconds(e.target.value)}
            disabled={busy}
            aria-invalid={!validSoloReview}
            aria-describedby="solo-review-help"
            className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-bold"
          />

          <p
            id="solo-review-help"
            className="mt-2 text-xs text-muted-foreground"
          >
            Choose 0–10 seconds, in 0.5-second steps.
            Set 0 to skip the answer-review screen.
            The answer timer stays at 10 seconds.
          </p>

          {!validSoloReview && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              Enter 0–10 seconds in 0.5-second steps.
            </p>
          )}
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2"><button onClick={start} disabled={busy || !validSoloReview} className="flex items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 font-bold text-[hsl(var(--primary-foreground))]"><Zap size={16} /> {busy ? 'Creating…' : 'Start ranked round'}</button><button onClick={() => setPartyOpen(true)} className="flex items-center justify-center gap-2 rounded-xl border px-4 py-3 font-bold"><Users size={16} /> Invite party</button></div>
      </>}
      <div className="mt-5 flex items-center justify-between rounded-xl bg-muted p-4"><span className="mono-label">Sounds</span><SoundSettings mode="quiz" /></div>
      <p className="mt-5 text-xs leading-6 text-muted-foreground">10 seconds per question · +4 correct, −2 wrong, −1 timeout · 4 mistakes ends the whole round. Solo: only new mastery earns +4; wrong answers remove that mastery and one other mastered card. Party: scores decide the wager. AFK adds a 5-point fine (10 after Q20). Higher-ranked losers must repair missed cursed cards; correct repairs restore mastery without points.</p>
    </>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error} <button className="underline" onClick={() => window.location.reload()}>Reload</button></p>}
  </section>{partyOpen && <RankedPartyModal onClose={() => setPartyOpen(false)} busy={busy} error={error}
    onCreate={async setup => { setBusy(true); setError(''); try { const match = await api.createRankedMatch({ wagerType: setup.wagerType, wagerPoints: setup.wagerPoints, wagerCards: setup.wagerCards, reviewMs: setup.reviewMs, count }); navigate(`/ranked/room/${match.matchId}`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}
    onJoin={async code => { setBusy(true); setError(''); try { const match = await api.joinRankedMatch(code); navigate(`/ranked/room/${match.matchId}`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} />}</>;
}
// Old bookmarked solo URLs now go through the same account-backed flow, never a local balance writer.
export function RankedActive({ count }: { count: number }) {
  return <div className="mx-auto max-w-[900px] px-5 py-10"><RankedSetup initialCount={count} /></div>;
}
