import { useState } from 'react';
import { ArrowRight, Copy, Swords, Users, X, Zap } from 'lucide-react';
import { RULES, REVIEW_TIME, isValidReviewMs } from '../../shared/ranked';
import { cn } from '@/lib/utils';

type WagerType = 'points' | 'cards_points';

export type RankedPartySetup = {
  wagerType: WagerType;
  wagerPoints: number;
  wagerCards: number;
  reviewMs: number;
};

export function RankedPartyModal({ onClose, onCreate, onJoin, onStart, onOpenLobby, lobbyRole, roomCode, busy = false, error }: {
  onClose: () => void;
  onCreate?: (setup: RankedPartySetup) => void;
  onJoin?: (roomCode: string) => void;
  onStart?: () => void;
  onOpenLobby?: () => void;
  lobbyRole?: 'host' | 'guest';
  roomCode?: string;
  busy?: boolean;
  error?: string;
}) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [joinCode, setJoinCode] = useState('');
  const [wagerType, setWagerType] = useState<WagerType>('points');
  const [wagerPoints, setWagerPoints] = useState('10');
  const [wagerCards, setWagerCards] = useState('5');
  const [reviewSeconds, setReviewSeconds] = useState(String(RULES.reviewMs / 1000));
  const reviewMs = Number(reviewSeconds) * 1000;
  const validReview = reviewSeconds.trim() !== '' && isValidReviewMs(reviewMs);
  const submit = () => { if (!validReview) return; onCreate?.({ reviewMs, wagerType, wagerPoints: Math.max(0, Math.round(Number(wagerPoints) || 0)), wagerCards: wagerType === 'cards_points' ? Math.max(0, Math.round(Number(wagerCards) || 0)) : 0 }); };
  const copyRoom = () => { if (roomCode) void navigator.clipboard?.writeText(roomCode); };
  const join = () => onJoin?.(joinCode.trim().toUpperCase());
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-5" role="dialog" aria-modal="true" aria-labelledby="ranked-party-title">
    <section className="animate-pop max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-[1.75rem] border border-[hsl(var(--accent)/.45)] bg-card p-6 shadow-2xl md:p-8">
      <div className="flex items-start justify-between gap-4"><div><p className="mono-label flex items-center gap-2 text-[hsl(var(--accent))]"><Swords size={14} /> Ranked party</p><h2 id="ranked-party-title" className="mt-2 font-serif text-3xl">Challenge a friend.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">The match uses the lower player’s tier and keeps Casual progress separate.</p></div><button onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><X size={18} /></button></div>
      <div className="mt-6 grid grid-cols-2 gap-2"><button onClick={() => setMode('create')} className={cn('rounded-xl border py-2.5 text-sm font-bold', mode === 'create' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border')}>Create room</button><button onClick={() => setMode('join')} className={cn('rounded-xl border py-2.5 text-sm font-bold', mode === 'join' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border')}>Join room</button></div>{mode === 'join' && <label className="mt-5 block text-sm font-bold">Room code<input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="ABC12345" className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 font-mono uppercase tracking-widest" /></label>}
      <div className={cn("mt-6", mode === "join" && "hidden")}><p className="mb-3 text-sm font-bold">Wager type</p><div className="grid gap-2 sm:grid-cols-2"><button onClick={() => setWagerType('points')} aria-pressed={wagerType === 'points'} className={cn('rounded-xl border p-3 text-left text-sm font-bold', wagerType === 'points' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')}><Zap size={15} className="mb-2 text-[hsl(var(--accent))]" />Ranked points only<span className="mt-1 block text-xs font-normal text-muted-foreground">Winner gains the stake; ties keep balances unchanged.</span></button><button onClick={() => setWagerType('cards_points')} aria-pressed={wagerType === 'cards_points'} className={cn('rounded-xl border p-3 text-left text-sm font-bold', wagerType === 'cards_points' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')}><Users size={15} className="mb-2 text-[hsl(var(--accent))]" />Mastered cards + points<span className="mt-1 block text-xs font-normal text-muted-foreground">Wager cards you already own. Higher-ranked losers only lose owned missed cards (up to the wager); those cards are not transferred.</span></button></div></div>
      <div className={cn("mt-5 grid gap-3 sm:grid-cols-2", mode === "join" && "hidden")}><label className="text-xs font-bold text-muted-foreground">Ranked points<input type="number" min="1" value={wagerPoints} onChange={(event) => setWagerPoints(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-bold text-foreground" /></label>{wagerType === 'cards_points' && <label className="text-xs font-bold text-muted-foreground">Mastered cards<input type="number" min="1" value={wagerCards} onChange={(event) => setWagerCards(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-bold text-foreground" /></label>}</div>
      {mode === 'create' && !roomCode && <fieldset className="mt-5 rounded-xl border border-border p-4">
        <legend className="px-1 text-sm font-bold">Review time</legend>
        <div className="flex flex-wrap gap-2">{[0, 1, 1.5, 3, 5].map(seconds => <button key={seconds} type="button" disabled={busy} aria-pressed={validReview && reviewMs === seconds * 1000} onClick={() => setReviewSeconds(String(seconds))} className={cn('rounded-lg border px-3 py-2 text-xs font-bold', validReview && reviewMs === seconds * 1000 ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border')}>{seconds === 0 ? 'Off (0s)' : `${seconds}s`}</button>)}</div>
        <label htmlFor="party-review-seconds" className="mt-3 block text-xs font-bold text-muted-foreground">Custom review time (seconds)</label>
        <input id="party-review-seconds" type="number" min={REVIEW_TIME.minMs / 1000} max={REVIEW_TIME.maxMs / 1000} step={REVIEW_TIME.stepMs / 1000} disabled={busy} value={reviewSeconds} onChange={event => setReviewSeconds(event.target.value)} aria-invalid={!validReview} aria-describedby="party-review-help" className="mt-2 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-bold" />
        <p id="party-review-help" className="mt-2 text-xs leading-5 text-muted-foreground">0–10 seconds, in 0.5-second steps. Choose 0 to skip the answer-review screen. Both players share this setting; the answer timer stays at 10 seconds.</p>
        {!validReview && <p role="alert" className="mt-2 text-xs text-destructive">Enter 0–10 seconds in 0.5-second steps.</p>}
      </fieldset>}
      {roomCode && <div className="mt-5 rounded-xl bg-muted p-4"><p className="mono-label text-muted-foreground">{lobbyRole === 'host' ? 'Lobby created · share this room code' : 'Joined lobby · room code'}</p><button onClick={copyRoom} className="mt-2 flex items-center gap-2 font-mono text-xl font-black tracking-widest"><span>{roomCode}</span><Copy size={15} /></button><p className="mt-3 text-xs text-muted-foreground">{lobbyRole === 'host' ? 'Wait for your opponent to join, then start the battle.' : 'You are in the lobby. Wait for the host to start the battle.'}</p></div>}
      {roomCode && onOpenLobby && <button onClick={onOpenLobby} className="mt-3 flex w-full items-center justify-center rounded-xl border border-border py-2.5 text-sm font-bold hover:bg-muted">Open lobby page</button>}
      {error && <p className="mt-4 rounded-xl border border-[hsl(var(--destructive)/.4)] bg-[hsl(var(--destructive)/.08)] p-3 text-sm font-semibold text-[hsl(var(--destructive))]">{error}</p>}
      {roomCode && lobbyRole === 'host' ? <button onClick={onStart} disabled={busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] py-3.5 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40"><Swords size={16} /> {busy ? 'Starting battle…' : 'Start battle'} <ArrowRight size={16} /></button> : !roomCode && <button onClick={mode === 'create' ? submit : join} disabled={(mode === 'join' ? !joinCode.trim() : !validReview) || busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] py-3.5 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40"><Swords size={16} /> {busy ? (mode === 'create' ? 'Creating lobby…' : 'Joining lobby…') : mode === 'create' ? 'Create lobby' : 'Join lobby'} <ArrowRight size={16} /></button>}
    </section>
  </div>;
}
