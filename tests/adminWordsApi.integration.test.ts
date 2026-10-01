// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const req = (method: string, path: string, who?: string, data?: unknown) => mf.dispatchFetch(`http://example.com/api/${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
beforeAll(async () => {
  const compiled = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], plugins: [{ name: 'mock-firebase-only', setup(builder) {
    builder.onLoad({ filter: /worker[\\/]auth\.ts$/ }, () => ({ contents: `
      export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
      export async function uidFromRequest(request) {
        const header = request.headers.get('Authorization');
        if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in.');
        return header.slice(7);
      }
      export function deviceSessionFromRequest() { return ''; }
    `, loader: 'js' }));
  } }] });
  mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-03', bindings: { WORD_ADMIN_UIDS: ' admin, another-admin ' }, d1Databases: ['DB'], durableObjects: { MATCH_ROOM: { className: 'MatchRoom', useSQLite: true } } });
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('migrations/0001_init.sql', 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  await db.prepare(`INSERT INTO user_data (uid, lists, custom_words, history, version, updated_at) VALUES (?, ?, ?, ?, 4, ?)`).bind('learner', JSON.stringify([{ id: 'slot', name: 'Saved', createdAt: '2026-01-01', wordIds: ['old'] }]), JSON.stringify([{ id: 'old', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', createdAt: '2026-01-01' }]), JSON.stringify([{ score: 1 }]), new Date().toISOString()).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });
describe('word admin API authorization and atomic writes', () => {
  it('denies unauthenticated and non-admin read/write, including forged admin fields', async () => {
    expect((await req('GET', 'admin/users/learner/words')).status).toBe(401);
    expect((await req('GET', 'admin/users/learner/words', 'learner')).status).toBe(403);
    expect((await req('PATCH', 'admin/users/learner/words', 'learner', { version: 4, isAdmin: true, deleteIds: ['old'] })).status).toBe(403);
    expect(await (await req('GET', 'admin/status', 'learner')).json()).toEqual({ isAdmin: false });
    expect(await (await req('GET', 'admin/status', 'admin')).json()).toEqual({ isAdmin: true });
  });
  it('allows only an allowlisted UID, rejects stale writes and preserves unrelated fields', async () => {
    const before: any = await (await req('GET', 'admin/users/learner/words', 'admin')).json();
    expect(before).toMatchObject({ uid: 'learner', version: 4 });
    expect((await req('PATCH', 'admin/users/learner/words', 'admin', { version: 3, deleteIds: ['old'] })).status).toBe(409);
    const saved = await req('PATCH', 'admin/users/learner/words', 'another-admin', { version: 4, deleteIds: ['old'], entries: [{ expression: '鳥', reading: 'とり', meaning: 'bird' }], listId: 'slot', history: [] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 5, created: 1, deleted: 1 });
    const row: any = await db.prepare('SELECT custom_words, lists, history, version FROM user_data WHERE uid = ?').bind('learner').first();
    expect(JSON.parse(row.custom_words)).toMatchObject([{ expression: '鳥', meaning: 'bird' }]);
    expect(JSON.parse(row.lists)[0].wordIds).toHaveLength(1);
    expect(JSON.parse(row.history)).toEqual([{ score: 1 }]);
    expect(row.version).toBe(5);
    expect((await req('PATCH', 'admin/users/learner/words', 'admin', { version: 4, deleteIds: [JSON.parse(row.custom_words)[0].id] })).status).toBe(409);
    expect((await req('GET', 'admin/users/nonexistent/words', 'admin')).status).toBe(404);
  });
});
