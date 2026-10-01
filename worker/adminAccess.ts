import { HttpError, uidFromRequest, type Env } from './auth';

/** Explicit, server-only Firebase UID allowlist. Never trust a client role flag. */
export function isWordAdmin(uid: string, env: Env): boolean {
  return !!uid && (env.WORD_ADMIN_UIDS ?? '').split(',').some(entry => entry.trim() === uid);
}

export async function uidFromHeader(request: Request, env: Env): Promise<string> {
  // uidFromRequest also supports query-string tokens for WebSocket handshakes.
  // Admin endpoints must NEVER accept credentials in a URL or log/referrer.
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in.');
  return uidFromRequest(request, env);
}

export const wordAdminUid = uidFromHeader;

export async function requireWordAdmin(request: Request, env: Env): Promise<string> {
  const uid = await uidFromHeader(request, env);
  if (!isWordAdmin(uid, env)) throw new HttpError(403, 'Admin access required.');
  return uid;
}
