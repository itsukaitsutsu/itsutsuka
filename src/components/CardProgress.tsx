import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { api } from '@/lib/api';
import { usePoll } from '@/hooks/usePoll';
import {
  compareDiscovery, discoveryDocumentId, discoveryStateKey, loadDiscovery, mergeDiscovery,
  parseDiscoveryRecord, saveDiscovery, seenFromDiscovery, summarizeDiscovery,
  type DiscoveryFilter, type DiscoveryRecord,
} from '@/lib/cardProgress';

type DiscoveryContext = {
  seen: ReadonlySet<string>;
  ready: boolean;
  status: string;
  markOpened: (key: string) => boolean;
  markAsNew: (key: string) => void;
};
const Context = createContext<DiscoveryContext | null>(null);

export function CardProgressProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return <AccountProgress key={user?.uid ?? 'signed-out'} uid={user?.uid ?? null}>{children}</AccountProgress>;
}

function AccountProgress({ uid, children }: { uid: string | null; children: ReactNode }) {
  const [records, setRecords] = useState(() => uid ? loadDiscovery(uid) : new Map<string, DiscoveryRecord>());
  const recordsRef = useRef(records);
  const seen = useMemo(() => seenFromDiscovery(records), [records]);
  const [ready, setReady] = useState(!uid);
  const [status, setStatus] = useState('Loading discovery progress…');
  const flushRef = useRef<() => void>(() => {});
  const cacheAvailable = useRef(true);

  // Server-confirmed state, failures and the sync cursor live in refs: the sync
  // loop reads them outside of render.
  const remote = useRef(new Map<string, DiscoveryRecord>());
  const failed = useRef(new Set<string>());
  const syncing = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const publish = useCallback((next: Map<string, DiscoveryRecord>) => {
    recordsRef.current = next;
    if (uid) cacheAvailable.current = saveDiscovery(uid, next);
    setRecords(next);
  }, [uid]);

  const needsSync = useCallback((item: DiscoveryRecord) => {
    const confirmed = remote.current.get(item.key);
    return !confirmed || compareDiscovery(item, confirmed) > 0;
  }, []);

  const updateStatus = useCallback(() => {
    if (!alive.current) return;
    const pending = [...recordsRef.current.values()].some(needsSync);
    setStatus(failed.current.size
      ? 'Cloud sync unavailable. Changes are kept on this device when storage is available; reconnect or reload to retry.'
      : !cacheAvailable.current
        ? (pending ? 'Browser storage unavailable. Keep this page open until cloud sync completes.' : 'Cloud synced · browser cache unavailable')
        : pending ? 'Saved on this device · waiting for cloud sync'
        : 'Discovery progress synced across devices');
  }, [needsSync]);

  /**
   * Push local changes to D1. The old Firestore runTransaction() is gone: the
   * Worker does "insert only if newer" in one atomic statement and answers with
   * whatever actually won, which is exactly what the transaction returned.
   */
  const flush = useCallback(() => {
    if (!alive.current || !uid || syncing.current) return;
    const pending = [...recordsRef.current.values()].filter(needsSync);
    if (pending.length === 0) { updateStatus(); return; }

    syncing.current = true;
    const batch = pending.slice(0, 200);

    Promise.all(batch.map(async (item) => ({ ...item, cardId: await discoveryDocumentId(item.key) })))
      .then((items) => api.pushDiscovery(items.map(({ key, cardId, seen: isSeen, version, operation }) =>
        ({ key, cardId, seen: isSeen, version, operation }))))
      .then(({ settled }) => {
        if (!alive.current) return;
        for (const item of settled) {
          const old = remote.current.get(item.key);
          if (!old || compareDiscovery(item, old) >= 0) remote.current.set(item.key, item);
          failed.current.delete(item.key);
        }
        publish(mergeDiscovery(recordsRef.current, settled));
      })
      .catch(() => { if (alive.current) for (const item of batch) failed.current.add(item.key); })
      .finally(() => {
        syncing.current = false;
        if (!alive.current) return;
        updateStatus();
        // Only go again if something NEWER appeared while we were writing (e.g. a
        // reset). Never immediately retry an item that just failed — that would
        // spin in a tight loop while the network is down. Retries are driven by
        // the 30s interval and the 'online' event instead.
        const newerPending = [...recordsRef.current.values()]
          .some((item) => needsSync(item) && !failed.current.has(item.key));
        if (newerPending) flush();
      });
  }, [needsSync, publish, updateStatus, uid]);

  useEffect(() => { flushRef.current = flush; }, [flush]);

  // Firestore's onSnapshot() is gone: D1 has no push, so we ask "what changed
  // since version X?" — an unchanged account costs zero rows.
  const { bumpSince } = usePoll(
    (cursor) => api.discovery(cursor),
    (data) => {
      if (!alive.current) return;
      const incoming: DiscoveryRecord[] = [];
      for (const raw of data.records) {
        const item = parseDiscoveryRecord(raw);
        if (!item) continue;
        incoming.push(item);
        const old = remote.current.get(item.key);
        if (!old || compareDiscovery(item, old) >= 0) remote.current.set(item.key, item);
        failed.current.delete(item.key);
      }
      publish(mergeDiscovery(recordsRef.current, incoming));
      setReady(true);
      failed.current.delete('listener');
      // Rewind 1s so two records sharing a timestamp are never skipped.
      if (incoming.length) bumpSince(Math.max(...incoming.map((item) => item.version)) - 1000);
      flushRef.current();
    },
    20_000,
    !!uid,
  );

  // Never leave the UI on "loading" if the first request is slow or fails.
  useEffect(() => {
    if (!uid) return;
    const timer = window.setTimeout(() => setReady(true), 4000);
    return () => window.clearTimeout(timer);
  }, [uid]);

  // Another tab on this device changed something.
  useEffect(() => {
    if (!uid) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== discoveryStateKey(uid)) return;
      publish(mergeDiscovery(recordsRef.current, loadDiscovery(uid).values()));
      flushRef.current();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [uid, publish]);

  // Retry failed writes, and flush as soon as we are back online.
  useEffect(() => {
    if (!uid) return;
    const retry = window.setInterval(() => flushRef.current(), 30_000);
    const onOnline = () => flushRef.current();
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener('online', onOnline);
    };
  }, [uid]);

  const change = useCallback((key: string, nextSeen: boolean) => {
    if (!uid) return false;
    // Include changes from another tab that might not yet have emitted storage.
    const latest = mergeDiscovery(recordsRef.current, loadDiscovery(uid).values());
    const old = latest.get(key);
    if ((old?.seen ?? false) === nextSeen) return false;
    const item: DiscoveryRecord = {
      key, seen: nextSeen,
      version: Math.max(Date.now(), (old?.version ?? 0) + 1),
      operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    latest.set(key, item);
    publish(latest);
    flushRef.current();
    return true;
  }, [uid, publish]);

  const markOpened = useCallback((key: string) => change(key, true), [change]);
  const markAsNew = useCallback((key: string) => { change(key, false); }, [change]);
  return <Context.Provider value={{ seen, ready, status, markOpened, markAsNew }}>{children}</Context.Provider>;
}

export function useCardProgress() {
  const value = useContext(Context);
  if (!value) throw new Error('useCardProgress requires CardProgressProvider');
  return value;
}

// Mount ONLY for the currently displayed practice prompt, keyed by its identity.
// Keep the first-open badge stable while answering, even after the save re-renders.
export function OpenedCardBadge({ cardKey }: { cardKey: string }) {
  const { ready, markOpened } = useCardProgress();
  const captured = useRef<boolean | null>(null);
  const [isNew, setIsNew] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ready || captured.current !== null) return;
    captured.current = markOpened(cardKey);
    setIsNew(captured.current);
  }, [ready, cardKey, markOpened]);
  return <span data-testid="card-discovery-badge" className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-[hsl(var(--secondary))]" aria-live="polite">
    {isNew ? <Sparkles size={13} /> : <Check size={13} />}
    {isNew === null ? 'Checking progress…' : isNew ? 'New to you' : 'Seen before'}
  </span>;
}

export function DiscoverySummary({ keys, title }: { keys: string[]; title: string }) {
  const { seen, ready } = useCardProgress();
  const summary = summarizeDiscovery(keys, seen);
  return <div className="rounded-2xl border border-border bg-card p-4 text-left" data-testid="discovery-summary">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">{title}</h3><span className="text-xs font-bold text-[hsl(var(--secondary))]">{ready ? `${summary.percent}% explored` : 'Loading…'}</span></div>
    <div className="my-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${title} explored`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}><div className="h-full rounded-full bg-[hsl(var(--secondary))] transition-[width]" style={{ width: `${summary.percent}%` }} /></div>
    <p className="text-xs text-muted-foreground">{ready ? <><strong className="text-foreground">{summary.seen.toLocaleString()} seen</strong> · {summary.remaining.toLocaleString()} new · {summary.total.toLocaleString()} unique cards</> : 'Loading your seen and new cards…'}</p>
  </div>;
}

export function DiscoveryFilterControl({ value, onChange, disabled = false }: {
  value: DiscoveryFilter; onChange: (value: DiscoveryFilter) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="space-y-2" data-testid="discovery-filter">
    <legend className="mb-2 text-sm font-bold">Which cards?</legend>
    <div className="grid grid-cols-3 gap-2">{(['all', 'seen', 'new'] as const).map((option) =>
      <button type="button" key={option} aria-pressed={value === option} onClick={() => onChange(option)}
        data-testid={`discovery-filter-${option}`} className={`rounded-xl border px-3 py-2.5 text-sm font-bold disabled:opacity-50 ${value === option ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted'}`}>
        {option === 'all' ? 'All cards' : option === 'seen' ? 'Seen only' : 'New only'}
      </button>)}</div>
  </fieldset>;
}
