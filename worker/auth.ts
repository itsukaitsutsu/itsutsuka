// Verifying Firebase ID tokens inside a Cloudflare Worker.
//
// The browser signs in with Firebase exactly as it does today, then sends the
// short-lived ID token as `Authorization: Bearer <token>`. We verify it against
// Google's public keys and trust `payload.sub` as the user id — the same uid that
// was your Firestore document id.
//
// This costs ~1-2 ms of CPU, which fits Workers Free's 10 ms budget. Password
// hashing would not, which is the whole reason we keep Firebase Auth.

import { createRemoteJWKSet, jwtVerify } from 'jose';

export type Env = {
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
  /**
   * Optional admin password for the /api/feedback list + resolve routes.
   * Set it in the Cloudflare dashboard (Workers & Pages → mykotoba → Settings
   * → Variables → FEEDBACK_ADMIN_TOKEN, in Production AND Preview). Never in code.
   */
  FEEDBACK_ADMIN_TOKEN?: string;
  /** Comma-separated Firebase UIDs allowed to manage other users' personal words. Server-only. */
  WORD_ADMIN_UIDS?: string;
  /** Provided automatically by Cloudflare because `assets` is set in wrangler.jsonc. */
  ASSETS: Fetcher;
  MATCH_ROOM: DurableObjectNamespace;
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const validSessionId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /SamsungBrowser\//.test(userAgent) ? 'Samsung Internet' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const platform = /Android/.test(userAgent) ? 'Android' : /iPhone|iPad|iPod/.test(userAgent) ? 'iPhone / iPad' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' : /CrOS/.test(userAgent) ? 'ChromeOS' : /Linux/.test(userAgent) ? 'Linux' : 'device';
  return `${browser} on ${platform}`;
}

function sessionIdFromRequest(request: Request): string {
  return request.headers.get('X-Device-Session') ?? new URL(request.url).searchParams.get('session') ?? '';
}

/** Current device-session id from a normal API request or ranked WebSocket handshake. */
export function deviceSessionFromRequest(request: Request): string {
  return sessionIdFromRequest(request);
}

async function requireActiveDeviceSession(request: Request, env: Env, uid: string, authTime: number): Promise<void> {
  const sessionId = sessionIdFromRequest(request);
  if (!validSessionId(sessionId)) throw new HttpError(401, 'Missing or invalid device session. Reload the app and sign in again.', 'DEVICE_SESSION_REQUIRED');

  const now = Date.now();
  const existing = await env.DB.prepare('SELECT uid, revoked_at, last_seen_at FROM device_sessions WHERE session_id = ?').bind(sessionId).first<{ uid: string; revoked_at: number | null; last_seen_at: number }>();
  if (existing && existing.uid !== uid) throw new HttpError(401, 'Invalid device session.', 'DEVICE_SESSION_INVALID');
  if (existing?.revoked_at !== null && existing?.revoked_at !== undefined) {
    throw new HttpError(403, 'This device was signed out remotely. Sign in again to continue.', 'DEVICE_SESSION_REVOKED');
  }
  if (!existing) {
    // Once a device is revoked, an old Firebase login must not be able to evade
    // revocation simply by generating a new local session id. A fresh sign-in
    // updates Firebase auth_time and permits a genuinely new session.
    const revoked = await env.DB.prepare('SELECT MAX(revoked_at) AS latest FROM device_sessions WHERE uid = ?').bind(uid).first<{ latest: number | null }>();
    if (revoked?.latest && authTime * 1000 <= revoked.latest) {
      throw new HttpError(403, 'Please sign out and sign in again to register this device.', 'DEVICE_SESSION_REAUTH_REQUIRED');
    }
    await env.DB.prepare('INSERT OR IGNORE INTO device_sessions (session_id, uid, label, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(sessionId, uid, deviceLabel((request.headers.get('User-Agent') ?? '').slice(0, 500)), now, now).run();
    const created = await env.DB.prepare('SELECT uid, revoked_at FROM device_sessions WHERE session_id = ?').bind(sessionId).first<{ uid: string; revoked_at: number | null }>();
    if (!created || created.uid !== uid || created.revoked_at !== null) throw new HttpError(403, 'This device session could not be registered. Sign in again.', 'DEVICE_SESSION_REVOKED');
    return;
  }
  // Keep last-active timestamps useful without writing on every API request.
  if (now - existing.last_seen_at >= 5 * 60_000) {
    await env.DB.prepare('UPDATE device_sessions SET last_seen_at = ? WHERE session_id = ? AND uid = ? AND revoked_at IS NULL').bind(now, sessionId, uid).run();
  }
}

// Google rotates these; jose re-fetches them when it sees an unknown key id.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

/** Returns the Firebase uid for the request, or throws HttpError(401). */
export async function uidFromRequest(request: Request, env: Env): Promise<string> {
  const header = request.headers.get('Authorization') ?? '';
  const queryToken = new URL(request.url).searchParams.get('token') ?? '';
  if (!header.startsWith('Bearer ') && !queryToken) throw new HttpError(401, 'Not signed in.');

  // WebSocket clients cannot set Authorization headers during the browser
  // handshake, so the live-room route may use a short-lived Firebase token in
  // the query string. Normal API requests should continue using the header.
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : queryToken.trim();
  if (!token) throw new HttpError(401, 'Not signed in.');

  let uid = '';
  let authTime = 0;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new HttpError(401, 'Invalid sign-in token.');
    }
    if (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time)) {
      throw new HttpError(401, 'Sign-in token is missing its authentication time. Please sign in again.');
    }
    uid = payload.sub;
    authTime = payload.auth_time;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Expired, revoked, wrong project, bad signature — all mean "sign in again".
    throw new HttpError(401, 'Your session expired. Please sign in again.');
  }

  await requireActiveDeviceSession(request, env, uid, authTime);
  return uid;
}

/** Ensures we have a `users` row for this Firebase uid (kept in sync lazily). */
export async function touchUser(env: Env, uid: string, email: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (uid, email) VALUES (?, COALESCE(?, ''))
     ON CONFLICT(uid) DO UPDATE SET email = COALESCE(NULLIF(excluded.email, ''), users.email)`,
  ).bind(uid, email).run();
}
