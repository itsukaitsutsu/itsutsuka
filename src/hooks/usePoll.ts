import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The closest simple equivalent of Firestore's `onSnapshot`.
 *
 * D1 has no push, so we re-run `fetcher` on an interval — but only while the tab
 * is visible, plus immediately when the user comes back to the tab or reconnects.
 * Errors keep the last good data on screen instead of blanking the UI.
 *
 * Usage:
 *   const error = usePoll((since) => api.discovery(since), onRecords, 20_000);
 */
export function usePoll<T>(
  fetcher: (since: number) => Promise<T>,
  onData: (data: T) => void,
  intervalMs = 20_000,
  enabled = true,
) {
  const [error, setError] = useState<unknown>(null);
  const since = useRef(0);
  const running = useRef(false);
  const alive = useRef(true);

  // Keep the latest callbacks without re-creating the interval every render.
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  fetcherRef.current = fetcher;
  onDataRef.current = onData;

  const tick = useCallback(async () => {
    if (!enabled || running.current || document.visibilityState !== 'visible') return;
    running.current = true;
    try {
      const data = await fetcherRef.current(since.current);
      if (alive.current) {
        onDataRef.current(data);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(err);   // keep showing the last good data
    } finally {
      running.current = false;
    }
  }, [enabled]);

  /** Call this after you save something, so the next poll sees your own change. */
  const bumpSince = useCallback((value: number) => { since.current = Math.max(since.current, value); }, []);

  useEffect(() => {
    alive.current = true;
    void tick();
    const id = window.setInterval(tick, intervalMs);
    const wake = () => void tick();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      alive.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [tick, intervalMs]);

  return { error, refresh: tick, bumpSince };
}
