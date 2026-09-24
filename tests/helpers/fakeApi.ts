// In-memory stand-in for the Cloudflare Worker API.
//
// Tests mock '@/lib/api' with this module, so the app talks to a fake server
// instead of Firestore. It mirrors the real Worker's rules:
//   * version-guarded writes (stale version -> 409)
//   * discovery upserts where the newest version wins
//   * unique nicknames and invite codes (409 on collision)
//   * friend requests / pairs

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
  get isStale() { return this.status === 409; }
}

export type DiscoveryRow = { key: string; cardId: string; seen: boolean; version: number; operation: string };
export type MeRow = {
  lists: any[]; activeId: string | null; customWords: any[]; history: any[];
  shareScores: boolean; nickname: string; friendCode: string; version: number;
};

const clone = <T,>(value: T): T => (value === undefined || value === null ? value : JSON.parse(JSON.stringify(value)));
const nowIso = () => new Date().toISOString();

export type Fake = {
  uid: string | null;
  me: MeRow;
  discovery: Map<string, DiscoveryRow>;
  leaderboard: Map<string, any>;
  nicknames: Map<string, string>;
  invites: Map<string, { from: string; nickname: string }>;
  friendRequests: Map<string, any>;
  pairs: Map<string, any>;
  counts: Record<string, number>;
  writes: any[];
  errors: Record<string, Error | null>;
  afterRead: (() => void) | null;
  holdDiscovery: boolean;
  held: ((value: any) => void) | null;
};

export const fake: Fake = {
  uid: 'alice',
  me: { lists: [], activeId: null, customWords: [], history: [], shareScores: false, nickname: '', friendCode: '', version: 0 },
  discovery: new Map(),
  leaderboard: new Map(),
  nicknames: new Map(),
  invites: new Map(),
  friendRequests: new Map(),
  pairs: new Map(),
  counts: {},
  writes: [],
  errors: {},
  afterRead: null,
  holdDiscovery: false,
  held: null,
};

export function resetFake(me: Partial<MeRow> = {}) {
  fake.me = { lists: [], activeId: null, customWords: [], history: [], shareScores: false, nickname: '', friendCode: '', version: 0, ...clone(me) };
  fake.discovery = new Map();
  fake.leaderboard = new Map();
  fake.nicknames = new Map();
  fake.invites = new Map();
  fake.friendRequests = new Map();
  fake.pairs = new Map();
  fake.counts = {};
  fake.writes = [];
  fake.errors = {};
  fake.afterRead = null;
  fake.holdDiscovery = false;
  fake.held = null;
}

/** Replace the "server" discovery rows. Seen defaults to true (as a remote row would be). */
export function setDiscovery(keys: string[]) {
  fake.discovery = new Map(keys.map((key) => [key, { key, cardId: `id:${key}`, seen: true, version: 1, operation: 'remote' }]));
}

/** Let a held `discovery` poll resolve. */
export function releaseDiscovery() {
  const held = fake.held;
  fake.held = null;
  fake.holdDiscovery = false;
  held?.({ records: [...fake.discovery.values()].map(clone), syncedAt: Date.now() });
}

const bump = (name: string) => { fake.counts[name] = (fake.counts[name] ?? 0) + 1; };
const fail = (name: string) => { const err = fake.errors[name]; if (err) throw err; };

export const api = {
  async rankedAccount() { return { account: { points: 0, tier: 'N5', mastered: { N5: [], N4: [], N3: [], N2: [], N1: [] }, version: 0, activeMatch: null } }; },
  async me(): Promise<MeRow> {
    bump('me'); fail('me');
    fake.afterRead?.();
    return clone(fake.me);
  },

  async saveMe(patch: any) {
    bump('saveMe'); fail('saveMe');
    if (patch.version != null && patch.version !== fake.me.version) {
      throw new ApiError(409, 'This data changed on another device. Reloading…');
    }
    fake.writes.push(clone(patch));
    for (const key of ['lists', 'customWords', 'history']) {
      if (patch[key] !== undefined) (fake.me as any)[key] = clone(patch[key]);
    }
    for (const key of ['activeId', 'shareScores', 'nickname', 'friendCode']) {
      if (patch[key] !== undefined) (fake.me as any)[key] = patch[key];
    }
    fake.me.version += 1;
    return { ok: true as const, version: fake.me.version };
  },

  async discovery(since: number) {
    bump('discovery'); fail('discovery');
    // One microtask so a test can seed rows synchronously after render() and
    // still have them visible to the in-flight request — mirrors real latency.
    await Promise.resolve();
    if (fake.holdDiscovery) return new Promise((resolve) => { fake.held = resolve; });
    return { records: [...fake.discovery.values()].filter((row) => row.version > since).map(clone), syncedAt: Date.now() };
  },

  async pushDiscovery(records: DiscoveryRow[]) {
    bump('pushDiscovery'); fail('pushDiscovery');
    fake.writes.push({ discovery: clone(records) });
    const settled: DiscoveryRow[] = [];
    for (const incoming of records) {
      const existing = fake.discovery.get(incoming.key);
      const wins = !existing
        || incoming.version > existing.version
        || (incoming.version === existing.version && incoming.operation > existing.operation);
      if (wins) {
        const row: DiscoveryRow = { key: incoming.key, cardId: incoming.cardId, seen: incoming.seen, version: incoming.version, operation: incoming.operation };
        fake.discovery.set(row.key, row);
        settled.push(row);
      } else {
        settled.push(existing);     // the real Worker answers with the winner
      }
    }
    return { settled: settled.map(clone) };
  },

  async leaderboard(_sort = 'bonusPoints') {
    bump('leaderboard');
    return [...fake.leaderboard.values()].map(clone);
  },

  async rankedLeaderboard(by: 'points' | 'tier' = 'points') {
    bump('rankedLeaderboard');
    return { by, total: 0, rows: [], me: null };
  },

  async publish(publish: boolean, displayName: string, stats: Record<string, number> = {}) {
    bump('publish');
    const uid = fake.uid ?? '';
    if (!publish) { fake.leaderboard.delete(uid); return { ok: true as const, published: false }; }
    fake.leaderboard.set(uid, { uid, displayName, ...stats, updatedAt: nowIso() });
    return { ok: true as const, published: true };
  },

  async claimNickname(name: string, previous?: string) {
    bump('claimNickname');
    const key = String(name).trim().toLowerCase();
    if (fake.nicknames.has(key) && fake.nicknames.get(key) !== fake.uid) {
      throw new ApiError(409, `"${name}" is already taken. Try another.`);
    }
    fake.nicknames.set(key, fake.uid ?? '');
    if (previous) {
      const prevKey = previous.trim().toLowerCase();
      if (fake.nicknames.get(prevKey) === fake.uid) fake.nicknames.delete(prevKey);
    }
    return { ok: true as const, name: key };
  },

  async lookupInvite(code: string) {
    bump('lookupInvite');
    const invite = fake.invites.get(String(code).toUpperCase());
    if (!invite) throw new ApiError(404, 'Code not found. Ask your friend to double-check it.');
    return clone(invite);
  },

  async createInvite(code: string, nickname: string) {
    bump('createInvite');
    const key = String(code).toUpperCase();
    if (fake.invites.has(key)) throw new ApiError(409, 'That code already exists. Please try again.');
    fake.invites.set(key, { from: fake.uid ?? '', nickname });
    return { ok: true as const, code: key };
  },

  async friendRequests() {
    bump('friendRequests');
    return [...fake.friendRequests.values()].map((row) => clone({ ...row, members: [row.from, row.to].sort() }));
  },

  async sendFriendRequest(to: string, code: string) {
    bump('sendFriendRequest');
    const me = fake.uid ?? '';
    const id = [me, to].sort().join('_');
    if (fake.pairs.has(id)) throw new ApiError(409, 'You are already friends.');
    const pending = fake.friendRequests.get(id);
    if (pending) {
      if (pending.from === me) throw new ApiError(409, 'You already sent them an invitation — waiting for them to confirm.');
      fake.pairs.set(id, { id, members: [me, to].sort(), names: {}, createdAt: nowIso() });
      fake.friendRequests.delete(id);
      return { ok: true as const, autoAccepted: true };
    }
    fake.friendRequests.set(id, { id, from: me, to, fromName: '', toName: '', code, createdAt: nowIso() });
    return { ok: true as const };
  },

  async deleteFriendRequest(id: string) {
    bump('deleteFriendRequest');
    fake.friendRequests.delete(id);
    return { ok: true as const };
  },

  async pairs(_withBonus = true) {
    bump('pairs');
    return [...fake.pairs.values()].map((pair) => {
      const other = (pair.members as string[]).find((m: string) => m !== fake.uid);
      return clone({ ...pair, friendBonus: other ? (fake.leaderboard.get(other)?.bonusPoints ?? null) : null });
    });
  },

  async confirmPair(requestId: string, names: Record<string, string> = {}) {
    bump('confirmPair');
    const request = fake.friendRequests.get(requestId);
    if (!request) throw new ApiError(404, 'No such invitation.');
    if (request.to !== fake.uid) throw new ApiError(403, 'Only the person who was invited can confirm.');
    fake.pairs.set(requestId, { id: requestId, members: [request.from, request.to].sort(), names, createdAt: nowIso() });
    fake.friendRequests.delete(requestId);
    return { ok: true as const, id: requestId };
  },

  async deletePair(id: string) {
    bump('deletePair');
    fake.pairs.delete(id);
    fake.friendRequests.delete(id);
    return { ok: true as const };
  },
};
