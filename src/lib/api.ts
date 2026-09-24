import type { RankedAccount } from '../../shared/ranked';
// Thin client for the Cloudflare Worker API.
//
// This is the ONLY file that talks to the network. It replaces
// `import { ... } from 'firebase/firestore'` everywhere else in the app.
// Firebase Auth is still used (for the ID token) — that's Option A: Google keeps
// doing login + password resets, D1 keeps the data.
//
// Additive by design: your app still works while you migrate one screen at a time.

import { auth } from '@/utils/firebase/client';

const BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
  /** 409 from PUT /api/me = someone else saved first. Refetch, re-apply, retry. */
  get isStale() {
    return this.status === 409;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const user = auth.currentUser;
  if (user) {
    try {
      // getIdToken() reuses the cached token until it is about to expire.
      headers.Authorization = `Bearer ${await user.getIdToken()}`;
    } catch {
      // Offline or token refresh failed — let the server answer 401.
    }
  }
  return headers;
}

async function call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) },
      credentials: 'same-origin',
    });
  } catch {
    // Offline, DNS failure, or the API is not running. `fetch` rejects with a raw
    // TypeError here, which would show up in the UI as "Failed to fetch".
    // Status 0 is the conventional marker for "never reached the server".
    throw new ApiError(0, 'Cannot reach the server. Check your internet connection.');
  }


  const text = await res.text();
  const body = text ? safeJson(text) : null;

  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'error' in body)
      ? String((body as { error: unknown }).error)
      : `Request failed (${res.status})`;

    // Token can expire mid-session: force a refresh once, then retry.
    if (res.status === 401 && retry && auth.currentUser) {
      await auth.currentUser.getIdToken(true).catch(() => undefined);
      return call<T>(path, init, false);
    }
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

const safeJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return null; }
};

export type MePayload = {
  lists: unknown[];
  activeId: string | null;
  customWords: unknown[];
  history: unknown[];
  shareScores: boolean;
  nickname: string;
  friendCode: string;
  version: number;
};

export type MePatch = Partial<Omit<MePayload, 'version'>> & { version?: number };

export type DiscoveryRecord = { key: string; cardId: string; seen: boolean; version: number; operation: string };

export type LeaderRow = {
  uid: string; displayName: string; totalQuizzes: number; avgPct: number; bestPct: number;
  bonusPoints: number; bestDay: number; jlptQuizzes: number; jlptAvgPct: number; updatedAt: string;
};

export type RankedLeaderRow = {
  rank: number; uid: string; displayName: string; tier: 'N5' | 'N4' | 'N3' | 'N2' | 'N1'; points: number;
  masteredInTier: number; tierTotal: number; masteredTotal: number; curses: number; matches: number; wins: number;
};
export type RankedLeaderboard = { by: 'points' | 'tier'; total: number; rows: RankedLeaderRow[]; me: RankedLeaderRow | null };

export type FriendRequest = {
  id: string; from: string; to: string; fromName: string; toName: string; code: string; createdAt: string;
};

export type Pair = {
  id: string; members: string[]; names: Record<string, string>; createdAt: string; friendBonus?: number | null;
};

export const api = {
  // ── userData/{uid} ─────────────────────────────────────────────────────────
  me: () => call<MePayload>('/me'),

  /** Merge-patch. Pass `version` to enable optimistic locking (409 if stale). */
  saveMe: (patch: MePatch) =>
    call<{ ok: true; version: number }>('/me', { method: 'PUT', body: JSON.stringify(patch) }),

  // ── cardDiscovery ──────────────────────────────────────────────────────────
  discovery: (since: number) =>
    call<{ records: DiscoveryRecord[]; syncedAt: number }>(`/discovery?since=${since}`),

  pushDiscovery: (records: DiscoveryRecord[]) =>
    call<{ settled: DiscoveryRecord[] }>('/discovery', { method: 'POST', body: JSON.stringify({ records }) }),

  // ── leaderboard ────────────────────────────────────────────────────────────
  leaderboard: (sort: 'bonusPoints' | 'avgPct' | 'totalQuizzes' = 'bonusPoints') =>
    call<LeaderRow[]>(`/leaderboard?sort=${sort}`),

  rankedLeaderboard: (by: 'points' | 'tier') =>
    call<RankedLeaderboard>(`/ranked/leaderboard?by=${by}`),

  publish: (publish: boolean, displayName: string, stats: Record<string, number> = {}) =>
    call<{ ok: true; published: boolean }>('/leaderboard', {
      method: 'PUT',
      body: JSON.stringify({ publish, displayName, stats }),
    }),

  // ── Ranked Party matches ───────────────────────────────────────────────────
  rankedAccount: () => call<{ account: RankedAccount | null }>('/ranked/account'),
  initializeRanked: (legacy: unknown = {}) => call<{ account: RankedAccount }>('/ranked/account', { method: 'POST', body: JSON.stringify(legacy) }),
  resetRanked: () => call<{ ok: true }>('/ranked/account/reset', { method: 'POST' }),
    createSoloRanked: (count: number, reviewMs?: number) =>
    call<{ matchId: string }>('/ranked/matches', {
      method: 'POST',
      body: JSON.stringify({ mode: 'solo', count, reviewMs }),
    }),
  createRankedMatch: (payload: { count?: number; reviewMs?: number; wagerType: 'points' | 'cards_points'; wagerPoints: number; wagerCards?: number }) =>
    call<{ ok: true; matchId: string; roomCode: string; tier: string; wagerType: string; wagerPoints: number; wagerCards: number; reviewMs: number }>('/ranked/matches', { method: 'POST', body: JSON.stringify(payload) }),

  joinRankedMatch: (idOrCode: string) =>
    call<{ ok: true; matchId: string; roomCode: string; tier: string }>(`/ranked/matches/${encodeURIComponent(idOrCode)}/join`, { method: 'POST' }),

  rankedMatch: (idOrCode: string) =>
    call<{ match: Record<string, unknown>; players: Array<Record<string, unknown>> }>(`/ranked/matches/${encodeURIComponent(idOrCode)}`),

  startRankedMatch: (idOrCode: string) =>
    call<{ ok: true; status: string }>(`/ranked/matches/${encodeURIComponent(idOrCode)}/start`, { method: 'POST' }),

  // ── nicknames / invites ────────────────────────────────────────────────────
  claimNickname: (name: string, previous?: string) =>
    call<{ ok: true; name: string }>('/nickname', { method: 'POST', body: JSON.stringify({ name, previous }) }),

  lookupInvite: (code: string) =>
    call<{ from: string; nickname: string }>(`/invites/${encodeURIComponent(code.toUpperCase())}`),

  createInvite: (code: string, nickname: string) =>
    call<{ ok: true; code: string }>('/invites', { method: 'POST', body: JSON.stringify({ code, nickname }) }),

  // ── friends ────────────────────────────────────────────────────────────────
  friendRequests: () => call<FriendRequest[]>('/friend-requests'),

  sendFriendRequest: (to: string, code: string) =>
    call<{ ok: true; autoAccepted?: boolean }>('/friend-requests', {
      method: 'POST', body: JSON.stringify({ to, code }),
    }),

  deleteFriendRequest: (id: string) => call<{ ok: true }>(`/friend-requests/${id}`, { method: 'DELETE' }),

  pairs: (withBonus = true) => call<Pair[]>(`/pairs${withBonus ? '?withBonus=1' : ''}`),

  confirmPair: (requestId: string, names: Record<string, string> = {}) =>
    call<{ ok: true; id: string }>('/pairs', { method: 'POST', body: JSON.stringify({ requestId, names }) }),

  deletePair: (id: string) => call<{ ok: true }>(`/pairs/${id}`, { method: 'DELETE' }),
};

/** Turns API failures into the plain-English messages your UI already shows. */
export function explainApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return 'Network problem — check your connection and try again.';
  return err instanceof Error ? err.message : 'Something went wrong.';
}
