// Identity is independent of shuffle order, CSV row numbers, deck and quiz direction.
// Expression + reading also deduplicates a saved/custom copy of a built-in word.
export function wordProgressKey(word: { expression: string; reading: string }): string {
  const normalize = (value: string) => value.normalize('NFKC').trim();
  return `word:${JSON.stringify([normalize(word.expression), normalize(word.reading)])}`;
}

// JLPT questions are not individual vocabulary words. Keep their bank IDs separate.
export function jlptProgressKey(question: { id: string }): string {
  return `jlpt:${question.id}`;
}

export function sanitizeSeenKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === 'string' &&
      (key.startsWith('word:') || key.startsWith('jlpt:')) && key.length <= 10000))]
    : [];
}

export function summarizeDiscovery(keys: Iterable<string>, seen: ReadonlySet<string>) {
  const unique = new Set(keys);
  const opened = [...unique].filter((key) => seen.has(key)).length;
  return { total: unique.size, seen: opened, remaining: unique.size - opened,
    percent: unique.size ? Math.round(opened / unique.size * 100) : 0 };
}

export const progressCacheKey = (uid: string) => `kotoba:${uid}:card-discovery-v1`;

export function loadSeenKeys(uid: string): Set<string> {
  return seenFromDiscovery(loadDiscovery(uid));
}

export function saveSeenKeys(uid: string, seen: ReadonlySet<string>): boolean {
  try { localStorage.setItem(progressCacheKey(uid), JSON.stringify([...seen].sort())); return true; }
  catch { return false; }
}

// Fixed-length document IDs avoid Firestore's slash/length limits for Japanese text.
export async function discoveryDocumentId(key: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type DiscoveryFilter = 'all' | 'seen' | 'new';
export function parseDiscoveryFilter(value: string | null): DiscoveryFilter {
  return value === 'seen' || value === 'new' ? value : 'all';
}
export function filterDiscovered<T>(items: T[], keyOf: (item: NoInfer<T>) => string, seen: ReadonlySet<string>, filter: DiscoveryFilter): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if ((filter === 'all' || seen.has(key) === (filter === 'seen')) && !unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

// Resets must be records, not document deletions: a tombstone prevents a stale
// offline cache from re-uploading the old Seen flag. Legacy records have v0.
export type DiscoveryRecord = { key: string; seen: boolean; version: number; operation: string };
export const discoveryStateKey = (uid: string) => `kotoba:${uid}:card-discovery-v2`;
export function parseDiscoveryRecord(raw: unknown): DiscoveryRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (sanitizeSeenKeys([item.key]).length !== 1) return null;
  const key = item.key as string;
  if (!('seen' in item) && !('version' in item) && !('operation' in item)) return { key, seen: true, version: 0, operation: '' };
  if (typeof item.seen !== 'boolean' || !Number.isSafeInteger(item.version) || (item.version as number) < 0 ||
    typeof item.operation !== 'string' || item.operation.length > 100) return null;
  return { key, seen: item.seen, version: item.version as number, operation: item.operation };
}
export function compareDiscovery(a: DiscoveryRecord, b: DiscoveryRecord): number {
  return a.version - b.version || (a.operation > b.operation ? 1 : a.operation < b.operation ? -1 : 0);
}
export function mergeDiscovery(local: ReadonlyMap<string, DiscoveryRecord>, incoming: Iterable<DiscoveryRecord>) {
  const next = new Map(local);
  for (const item of incoming) {
    const old = next.get(item.key);
    if (!old || compareDiscovery(item, old) > 0) next.set(item.key, item);
  }
  return next;
}
export function loadDiscovery(uid: string): Map<string, DiscoveryRecord> {
  try {
    const stored = localStorage.getItem(discoveryStateKey(uid));
    if (stored !== null) {
      const raw: unknown = JSON.parse(stored);
      if (Array.isArray(raw)) return new Map(raw.flatMap((value) => {
        const item = parseDiscoveryRecord(value);
        return item ? [[item.key, item] as const] : [];
      }));
    }
  } catch { /* Fall back to the v1 cache if the new cache is unreadable. */ }
  try {
    const keys = sanitizeSeenKeys(JSON.parse(localStorage.getItem(progressCacheKey(uid)) || '[]'));
    return new Map(keys.map((key) => [key, { key, seen: true, version: 0, operation: '' }]));
  } catch { return new Map(); }
}
export function saveDiscovery(uid: string, records: ReadonlyMap<string, DiscoveryRecord>): boolean {
  try {
    localStorage.setItem(discoveryStateKey(uid), JSON.stringify([...records.values()].sort((a, b) => a.key < b.key ? -1 : 1)));
    return true;
  } catch { return false; }
}
export function seenFromDiscovery(records: ReadonlyMap<string, DiscoveryRecord>): Set<string> {
  return new Set([...records.values()].filter((item) => item.seen).map((item) => item.key));
}
