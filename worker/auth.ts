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
  /** Provided automatically by Cloudflare because `assets` is set in wrangler.jsonc. */
  ASSETS: Fetcher;
  MATCH_ROOM: DurableObjectNamespace;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
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

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new HttpError(401, 'Invalid sign-in token.');
    }
    return payload.sub;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Expired, revoked, wrong project, bad signature — all mean "sign in again".
    throw new HttpError(401, 'Your session expired. Please sign in again.');
  }
}

/** Ensures we have a `users` row for this Firebase uid (kept in sync lazily). */
export async function touchUser(env: Env, uid: string, email: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (uid, email) VALUES (?, COALESCE(?, ''))
     ON CONFLICT(uid) DO UPDATE SET email = COALESCE(NULLIF(excluded.email, ''), users.email)`,
  ).bind(uid, email).run();
}
