// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import bank from '../worker/rankedBank.json';

let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const word = bank.find(item => item.level === 'N5')!;
const source = 'owner', allowed = 'student-one', outsider = 'student-two', admin = 'admin';
const request = (method: string, path: string, uid?: string, body?: object) => mf.dispatchFetch(`http://example.com/api/${path}`, {
  method, headers: { ...(uid ? { Authorization: `Bearer ${uid}` } : {}), 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const lists = (name = 'SSW_Manufacture_1', ids = ['mine-1', word.id]) => [{ id: 'ssw-1', name, wordIds: ids, createdAt: '2026-01-01' }];
const personal = (meaning = 'factory work') => [{
  id: 'mine-1', expression: '製造', reading: 'せいぞう', meaning, level: 'N4',
  partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', createdAt: '2026-01-01',
}];
beforeAll(async () => {
  const compiled = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], plugins: [{ name: 'mock-jwt-only', setup(builder) {
    builder.onLoad({ filter: /worker[\\/]auth\.ts$/ }, () => ({ contents: `
      export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
      export async function uidFromRequest(request) {
        const h = request.headers.get('Authorization');
        if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in.');
        return h.slice(7);
      }
      export function deviceSessionFromRequest() { return ''; }
    `, loader: 'js' }));
  } }] });
  mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-03',
    bindings: { WORD_ADMIN_UIDS: admin }, d1Databases: ['DB'], durableObjects: { MATCH_ROOM: { className: 'MatchRoom', useSQLite: true } } });
  db = await mf.getD1Database('DB');
  for (const file of ['0001_init.sql', '0009_published_decks.sql']) await db.exec(readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  await db.prepare("INSERT INTO user_data (uid, lists, custom_words, history, updated_at) VALUES (?, ?, ?, '[]', ?)")
    .bind(source, JSON.stringify(lists()), JSON.stringify(personal()), new Date().toISOString()).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('published decks ACL and live source updates', () => {
  let deckId = '';
  it('requires verified login for shared decks and admin for publication', async () => {
    expect((await request('GET', 'decks')).status).toBe(401);
    expect((await request('GET', 'admin/decks/sources/owner', outsider)).status).toBe(403);
    expect((await request('POST', 'admin/decks', outsider, { sourceUid: source, listId: 'ssw-1', visibility: 'public', recipientUids: [] })).status).toBe(403);
    expect((await request('GET', 'admin/decks', outsider)).status).toBe(403);
    expect(await (await request('GET', 'admin/decks/sources/owner', admin)).json()).toEqual({ lists: [{ id: 'ssw-1', name: 'SSW_Manufacture_1', cardCount: 2 }] });
  });
  it('publishes to selected recipients only and hides the deck even from guessed URLs', async () => {
    const input = { sourceUid: source, listId: 'ssw-1', visibility: 'selected', recipientUids: [allowed] };
    expect((await request('POST', 'admin/decks', admin, { ...input, recipientUids: [] })).status).toBe(400);
    expect((await request('POST', 'admin/decks', admin, { ...input, visibility: 'public' })).status).toBe(400);
    expect((await request('POST', 'admin/decks', admin, { ...input, listId: 'nope' })).status).toBe(404);
    const published = await request('POST', 'admin/decks', admin, input);
    expect(published.status).toBe(201);
    deckId = (await published.json() as { id: string }).id;
    expect((await request('POST', 'admin/decks', admin, input)).status).toBe(409);
    const ownList = await (await request('GET', 'decks', allowed)).json() as { decks: Array<{ id: string; name: string; cardCount: number }> };
    expect(ownList.decks).toMatchObject([{ id: deckId, name: 'SSW_Manufacture_1', cardCount: 2 }]);
    expect(JSON.stringify(ownList)).not.toContain(source);
    expect(await (await request('GET', 'decks', outsider)).json()).toEqual({ decks: [], hasMore: false });
    expect((await request('GET', `decks/${deckId}`, outsider)).status).toBe(404);
    expect((await request('GET', `decks/${deckId}`, admin)).status).toBe(404);
    const detail = await (await request('GET', `decks/${deckId}`, allowed)).json() as { cards: Array<{ id: string; meaning: string; partOfSpeechEn?: string; partOfSpeechJp?: string }> };
    // A personal CSV copy of 製造 says N4, but the canonical original is N3.
    // The published view derives levels instead of trusting an import default.
    expect(detail.cards).toMatchObject([
      { id: 'mine-1', meaning: 'factory work', level: 'N3', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' },
      { id: word.id, level: 'N5', partOfSpeechEn: expect.any(String), partOfSpeechJp: expect.any(String) },
    ]);
  });
  it('mirrors source list rename, additions/removals and card edits without republishing', async () => {
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ? WHERE uid = ?')
      .bind(JSON.stringify(lists('Manufacturing practice', ['mine-1'])), JSON.stringify(personal('production')), source).run();
    const detail = await (await request('GET', `decks/${deckId}`, allowed)).json() as { name: string; cardCount: number; cards: Array<{ meaning: string }> };
    expect(detail).toMatchObject({ name: 'Manufacturing practice', cardCount: 1, cards: [{ meaning: 'production', level: 'N3' }] });
    const summary = await (await request('GET', 'decks', allowed)).json() as { decks: Array<{ name: string; cardCount: number }> };
    expect(summary.decks[0]).toMatchObject({ name: 'Manufacturing practice', cardCount: 1 });
    expect(await db.prepare('SELECT uid FROM user_data WHERE uid = ?').bind(allowed).first()).toBeNull(); // no 10-slot consumption
  });
  it('uses N1–N5 from original expression + reading and Custom for unmatched imported cards', async () => {
    const n1 = bank.find(item => item.level === 'N1')!;
    const unmatched = { id: 'imported-unmatched', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'invented word', level: 'N5' };
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ? WHERE uid = ?')
      .bind(JSON.stringify(lists('Manufacturing practice', ['mine-1', n1.id, unmatched.id])), JSON.stringify([...personal('production'), unmatched]), source).run();
    const detail = await (await request('GET', `decks/${deckId}`, allowed)).json() as { cards: Array<{ id: string; level: string }> };
    expect(detail.cards).toMatchObject([
      { id: 'mine-1', level: 'N3' },
      { id: n1.id, level: 'N1' },
      { id: unmatched.id, level: 'Custom' },
    ]);
    const stored = await db.prepare('SELECT custom_words FROM user_data WHERE uid = ?').bind(source).first<{ custom_words: string }>();
    expect(JSON.parse(stored!.custom_words)[1].level).toBe('N5'); // source data stays untouched
  });
  it('can change recipients or publish publicly, then unpublish immediately', async () => {
    expect((await request('PATCH', `admin/decks/${deckId}`, outsider, { visibility: 'public', recipientUids: [] })).status).toBe(403);
    expect((await request('PATCH', `admin/decks/${deckId}`, admin, { visibility: 'public', recipientUids: [] })).status).toBe(200);
    expect((await request('GET', `decks/${deckId}`, outsider)).status).toBe(200);
    expect((await request('PATCH', `admin/decks/${deckId}`, admin, { visibility: 'selected', recipientUids: [outsider] })).status).toBe(200);
    expect((await request('GET', `decks/${deckId}`, allowed)).status).toBe(404);
    expect((await request('GET', `decks/${deckId}`, outsider)).status).toBe(200);
    expect((await request('DELETE', `admin/decks/${deckId}`, admin)).status).toBe(200);
    expect((await request('GET', `decks/${deckId}`, outsider)).status).toBe(404);
  });
  it('does not expose a publication when its source list is removed', async () => {
    const published = await request('POST', 'admin/decks', admin, { sourceUid: source, listId: 'ssw-1', visibility: 'public', recipientUids: [] });
    expect(published.status).toBe(201);
    const id = (await published.json() as { id: string }).id;
    await db.prepare('UPDATE user_data SET lists = ? WHERE uid = ?').bind('[]', source).run();
    expect((await request('GET', `decks/${id}`, outsider)).status).toBe(404);
    expect(await (await request('GET', 'decks', outsider)).json()).toEqual({ decks: [], hasMore: false });
    expect((await request('DELETE', `admin/decks/${id}`, admin)).status).toBe(200);
  });
});
