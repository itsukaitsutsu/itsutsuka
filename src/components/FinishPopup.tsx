import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Flag, Star, Trophy, Volume2, VolumeX, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { useSoundSettings } from '@/components/SoundSettings';
import {
  loadSoundSettings,
  playUserFinishSound,
  type SoundMode,
} from '@/lib/soundSettings';
import { playFeedback, resultBandForScore, resultSoundForScore, type ResultBand } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';

type FinishInfo = {
  mode: SoundMode;
  score: number;
  total: number;
  /** Unique per finished test so a new finish always retriggers the card. */
  key: number;
};

type FinishPopupContextType = {
  finish: FinishInfo | null;
  showFinish: (mode: SoundMode, score: number, total: number) => void;
  hideFinish: () => void;
};

const FinishPopupContext = createContext<FinishPopupContextType | null>(null);

/**
 * Holds the global finish-card state. Mount this above the router so the
 * celebration card survives navigation — it keeps floating while the user
 * explores Cabinet, Quiz, JLPT, Friends, … until they close it.
 */
export function FinishPopupProvider({ children }: { children: React.ReactNode }) {
  const [finish, setFinish] = useState<FinishInfo | null>(null);

  const showFinish = useCallback((mode: SoundMode, score: number, total: number) => {
    setFinish({ mode, score, total, key: Date.now() + Math.random() });
  }, []);

  const hideFinish = useCallback(() => {
    setFinish(null);
  }, []);

  const value = useMemo(() => ({ finish, showFinish, hideFinish }), [finish, showFinish, hideFinish]);
  return <FinishPopupContext.Provider value={value}>{children}</FinishPopupContext.Provider>;
}

export function useFinishPopup() {
  const ctx = useContext(FinishPopupContext);
  if (!ctx) throw new Error('useFinishPopup must be used within FinishPopupProvider');
  return ctx;
}

const BAND_STYLE: Record<ResultBand, { icon: LucideIcon; title: string; message: string; badge: string }> = {
  perfect: {
    icon: Trophy,
    title: 'Perfect score!',
    message: 'Flawless — every single one correct.',
    badge: 'bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent))]',
  },
  high: {
    icon: Star,
    title: 'Well played!',
    message: 'A strong showing. Nearly all landed.',
    badge: 'bg-[hsl(var(--secondary)/.14)] text-[hsl(var(--secondary))]',
  },
  low: {
    icon: Flag,
    title: 'Round complete.',
    message: 'Every miss is a future remember.',
    badge: 'bg-muted text-muted-foreground',
  },
};

/**
 * Global end-of-test celebration card. Render once (e.g. in the app shell):
 * it floats over the bottom of whatever page is open WITHOUT blocking it —
 * clicks and scrolling pass through, so the user can read results or wander
 * to other pages while the fanfare plays. Closing the card always stops the
 * sound, even if playback was still starting up.
 */
export function GlobalFinishPopup() {
  const { finish, hideFinish } = useFinishPopup();
  const { user } = useAuth();
  const owner = user?.uid ?? 'anonymous';
  const { settings, update } = useSoundSettings(owner);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Playback generation: starting, replaying, or stopping bumps this, so an
  // audio element created by an older, superseded attempt can never take over
  // and become audible after the card was closed.
  const playIdRef = useRef(0);

  // --- Draggable position ---------------------------------------------------
  // `pos` is null while docked (bottom-center); after the first drag it
  // becomes explicit viewport coordinates. It lives in this always-mounted
  // component, so the card keeps its spot while the user browses pages.
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    w: number;
    h: number;
    moved: boolean;
  } | null>(null);

  const clampPos = (x: number, y: number, w: number, h: number) => ({
    x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8)),
  });

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect.left,
      baseY: rect.top,
      w: rect.width,
      h: rect.height,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Capture unavailable — dragging still works while over the handle. */
    }
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    // Small threshold so an ordinary tap on the handle doesn't jump the card.
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const p = clampPos(drag.baseX + dx, drag.baseY + dy, drag.w, drag.h);
    setPos({ x: p.x, y: p.y, w: drag.w });
  };

  const endHandleDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
  };

  const band = finish ? resultBandForScore(finish.score, finish.total) : 'low';
  const percent = finish && finish.total > 0 ? Math.round((finish.score / finish.total) * 100) : 0;
  const style = BAND_STYLE[band];
  const BandIcon = style.icon;
  const finishOn = settings.finishEnabled !== false;

  const stopAudio = () => {
    // Invalidate first: any playback still awaiting its settings/audio can no
    // longer slip through after this point.
    playIdRef.current += 1;
    try {
      audioRef.current?.pause();
    } catch {
      /* Already stopped or unavailable. */
    }
    audioRef.current = null;
  };

  const playFanfare = (info: FinishInfo) => {
    stopAudio();
    const id = playIdRef.current;
    const track = (audio: HTMLAudioElement) => {
      if (id !== playIdRef.current) {
        // Superseded (card closed or replayed) before the audio was ready:
        // silence it. play() is invoked right after this callback, so pause
        // on a later tick too — after it has taken effect — as well as now.
        try {
          audio.pause();
        } catch {
          /* Never started — nothing to silence. */
        }
        window.setTimeout(() => {
          try {
            audio.pause();
          } catch {
            /* Gone already. */
          }
        }, 0);
        return;
      }
      audioRef.current = audio;
    };
    void playUserFinishSound(
      owner,
      info.mode,
      info.score,
      info.total,
      () => playFeedback(resultSoundForScore(info.score, info.total), track),
      track,
    );
  };

  // Play once shortly after a new finish lands — the beat lets the entrance
  // animation finish first. The timer (not the audio) is what the cleanup
  // cancels, which keeps this StrictMode-safe: in dev React mounts, cleans
  // up, then remounts, so the first timer is discarded and only the second
  // one fires — exactly one fanfare, never cut off mid-start.
  useEffect(() => {
    if (!finish) return;
    const timer = window.setTimeout(() => playFanfare(finish), 350);
    return () => window.clearTimeout(timer);
    // Each finished test carries a fresh `finish` object; replay/close flows
    // never recreate it, so this fires exactly once per finished test.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish]);

  // Keep a floating card on-screen across rotation / window resize.
  useEffect(() => {
    if (!pos) return;
    const onResize = () => {
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const p = clampPos(rect.left, rect.top, rect.width, rect.height);
      setPos({ x: p.x, y: p.y, w: rect.width });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null]);

  const close = () => {
    stopAudio();
    hideFinish();
  };

  // Escape dismisses the floating card (it is not a modal, so there is no
  // built-in dialog handling for this).
  useEffect(() => {
    if (!finish) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish]);

  const replay = () => {
    if (finish) playFanfare(finish);
  };

  // Turning the sound back on replays the fanfare immediately: instant proof
  // it works, and a real tap — so the browser always allows it to play.
  const toggleFinish = async () => {
    const current = await loadSoundSettings(owner);
    const next = !(current.finishEnabled !== false);
    await update({ ...current, finishEnabled: next });
    if (next && current.enabled !== false && finish) playFanfare(finish);
    else stopAudio();
  };

  if (!finish) return null;

  return <div
    className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    role="dialog"
    aria-modal="false"
    aria-label="Test finished"
    data-testid="finish-popup"
  >
    <div
      ref={cardRef}
      style={pos ? { position: 'fixed', left: pos.x, top: pos.y, width: pos.w } : undefined}
      className="animate-rise pointer-events-auto w-full max-w-sm select-none rounded-[1.5rem] border border-border bg-card p-4 pt-2 shadow-[var(--shadow-md)]"
    >
      <div
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endHandleDrag}
        onPointerCancel={endHandleDrag}
        onDoubleClick={() => setPos(null)}
        title="Drag to move · double-click to dock"
        className="flex cursor-grab justify-center pb-2 active:cursor-grabbing [touch-action:none]"
        data-testid="finish-popup-handle"
      >
        <span className="h-1.5 w-10 rounded-full bg-border" />
      </div>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={replay}
          title="Replay finish sound"
          aria-label="Replay finish sound"
          className={cn('grid size-14 shrink-0 place-items-center rounded-2xl transition-transform hover:scale-105 active:scale-95', style.badge)}
          data-testid="button-replay-finish-sound"
        >
          <BandIcon size={26} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="truncate font-serif text-2xl tracking-[-.02em]">{style.title}</p>
            <p className="shrink-0 font-serif text-2xl">{percent}<span className="ml-0.5 font-mono text-sm">%</span></p>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {finish.score} of {finish.total} correct · {finish.mode === 'quiz' ? 'Round complete' : 'Practice complete'}
          </p>
          <p className="mt-0.5 text-xs font-semibold">{style.message}</p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close and stop the sound"
          title="Close and stop the sound"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
          data-testid="button-close-finish-popup"
        >
          <X size={16} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void toggleFinish()}
        aria-pressed={finishOn}
        className={cn(
          'mt-3 flex w-full items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-bold',
          finishOn ? 'border-border text-muted-foreground hover:bg-muted' : 'border-[hsl(var(--accent)/.5)] bg-[hsl(var(--accent)/.1)] text-[hsl(var(--accent))]',
        )}
        data-testid="toggle-finish-sounds-popup"
      >
        {finishOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        Finish sound: {finishOn ? 'On' : 'Off'}
      </button>
    </div>
  </div>;
}
