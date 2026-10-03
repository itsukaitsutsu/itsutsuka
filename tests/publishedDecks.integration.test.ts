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
  for (const file of ['0001_init.sql', '0009_published_decks.sql', '0010_published_deck_snapshots.sql', '0011_admin_card_groups.sql']) await db.exec(readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  await db.prepare("INSERT INTO user_data (uid, lists, custom_words, history, updated_at) VALUES (?, ?, ?, '[]', ?)")
    .bind(source, JSON.stringify(lists()), JSON.stringify(personal()), new Date().toISOString()).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('published decks ACL and independent snapshots', () => {
  let deckId = '';
  it('requires verified login for shared decks and admin for publication', async () => {
    expect((await request('GET', 'decks')).status).toBe(401);
    expect((await request('GET', 'admin/decks/sources/owner', outsider)).status).toBe(403);
    expect((await request('POST', 'admin/decks', outsider, { sourceUid: source, listId: 'ssw-1', visibility: 'public', recipientUids: [] })).status).toBe(403);
    expect((await request('GET', 'admin/decks', outsider)).status).toBe(403);
    expect(await (await request('GET', 'admin/decks/sources/owner', admin)).json()).toEqual({ lists: [{ id: 'ssw-1', name: 'SSW_Manufacture_1', cardCount: 2 }], groups: [] });
  });
  it('publishes to selected recipients only and hides the deck even from guessed URLs', async () => {
    const input = { sourceUid: source, listId: 'ssw-1', visibility: 'selected', recipientUids: [allowed] };
    expect((await request('POST', 'admin/decks', admin, { ...input, recipientUids: [] })).status).toBe(400);
    expect((await request('POST', 'admin/decks', admin, { ...input, visibility: 'public' })).status).toBe(400);
    expect((await request('POST', 'admin/decks', admin, { ...input, listId: 'nope' })).status).toBe(404);
    const published = await request('POST', 'admin/decks', admin, input);
    expect(published.status).toBe(201);
    deckId = (await published.json() as { id: string }).id;
    const sourceLists = await db.prepare('SELECT lists FROM user_data WHERE uid = ?').bind(source).first<{ lists: string }>();
    expect(JSON.parse(sourceLists!.lists)).toHaveLength(1); // publication is separate from the owner's saved slots
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
  it('keeps the published copy unchanged when the owner edits the source list or cards', async () => {
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ? WHERE uid = ?')
      .bind(JSON.stringify(lists('Manufacturing practice', ['mine-1'])), JSON.stringify(personal('production')), source).run();
    const detail = await (await request('GET', `decks/${deckId}`, allowed)).json() as { name: string; cardCount: number; cards: Array<{ id: string; meaning: string; level: string }> };
    expect(detail).toMatchObject({ name: 'SSW_Manufacture_1', cardCount: 2, cards: [
      { id: 'mine-1', meaning: 'factory work', level: 'N3' }, { id: word.id, level: 'N5' },
    ] });
    const summary = await (await request('GET', 'decks', allowed)).json() as { decks: Array<{ name: string; cardCount: number }> };
    expect(summary.decks[0]).toMatchObject({ name: 'SSW_Manufacture_1', cardCount: 2 });
    expect(await db.prepare('SELECT uid FROM user_data WHERE uid = ?').bind(allowed).first()).toBeNull(); // no personal-slot consumption
  });
  it('does not lose the published copy when the owner removes cards or edits custom words', async () => {
    const n1 = bank.find(item => item.level === 'N1')!;
    const unmatched = { id: 'imported-unmatched', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'invented word', level: 'N5' };
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ? WHERE uid = ?')
      .bind(JSON.stringify(lists('Manufacturing practice', ['mine-1', n1.id, unmatched.id])), JSON.stringify([...personal('production'), unmatched]), source).run();
    const detail = await (await request('GET', `decks/${deckId}`, allowed)).json() as { name: string; cards: Array<{ id: string; meaning: string; level: string }> };
    expect(detail).toMatchObject({ name: 'SSW_Manufacture_1', cards: [
      { id: 'mine-1', meaning: 'factory work', level: 'N3' }, { id: word.id, level: 'N5' },
    ] });
    expect(detail.cards.some(card => card.id === n1.id || card.id === unmatched.id)).toBe(false);
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
    expect((await request('DELETE', `admin/decks/${deckId}`, outsider)).status).toBe(403);
    expect((await request('DELETE', `admin/decks/${deckId}`, admin)).status).toBe(200);
    expect((await request('GET', `decks/${deckId}`, outsider)).status).toBe(404);
  });
  it('backfills canonical POS for older personal copies missing their original metadata', async () => {
    // The card's canonical POS exists in the original bank, but an earlier
    // import left the custom copy without those fields.
    const personalWithoutPos = { id: 'mine-1', expression: '製造', reading: 'せいぞう', meaning: 'production', level: 'N4', createdAt: '2026-01-01' };
    const unmatched = { id: 'imported-unmatched', expression: '私の新造語', reading: 'わたしのしんぞうご', meaning: 'invented word', level: 'Custom' };
    await db.prepare('UPDATE user_data SET custom_words = ? WHERE uid = ?')
      .bind(JSON.stringify([personalWithoutPos, unmatched]), source).run();
    const timestamp = new Date().toISOString();
    await db.prepare(`INSERT INTO published_decks (id, source_uid, source_list_id, visibility, recipient_uids, created_by, created_at, updated_at, snapshot_json)
      VALUES (?, ?, ?, 'public', '[]', ?, ?, ?, NULL)`)
      .bind('legacy-published', source, 'ssw-1', admin, timestamp, timestamp).run();
    const response = await request('GET', 'decks/legacy-published', outsider);
    expect(response.status).toBe(200);
    const detail = await response.json() as { name: string; cardCount: number; cards: Array<{ id: string; partOfSpeechEn?: string; partOfSpeechJp?: string }> };
    expect(detail).toMatchObject({ name: 'Manufacturing practice', cardCount: 3 });
    expect(detail.cards.find(card => card.id === 'mine-1')).toMatchObject({ partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' });
    const stored = await db.prepare('SELECT snapshot_json FROM published_decks WHERE id = ?').bind('legacy-published').first<{ snapshot_json: string }>();
    expect(JSON.parse(stored!.snapshot_json).cards).toHaveLength(3);
    expect((await request('DELETE', 'admin/decks/legacy-published', admin)).status).toBe(200);
  });

  it('keeps the published copy after the owner deletes the original save slot; only admin can remove it', async () => {
    const published = await request('POST', 'admin/decks', admin, { sourceUid: source, listId: 'ssw-1', visibility: 'public', recipientUids: [] });
    expect(published.status).toBe(201);
    const id = (await published.json() as { id: string }).id;
    // Simulate an older immutable snapshot created before POS recovery existed.
    const saved = await db.prepare('SELECT snapshot_json FROM published_decks WHERE id = ?').bind(id).first<{ snapshot_json: string }>();
    const snapshot = JSON.parse(saved!.snapshot_json) as { cards: Array<Record<string, unknown>> };
    const personalCopy = snapshot.cards.find(card => card.id === 'mine-1')!;
    delete personalCopy.partOfSpeechEn; delete personalCopy.partOfSpeechJp;
    await db.prepare('UPDATE published_decks SET snapshot_json = ? WHERE id = ?').bind(JSON.stringify(snapshot), id).run();
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ? WHERE uid = ?').bind('[]', '[]', source).run();

    const list = await (await request('GET', 'decks', outsider)).json() as { decks: Array<{ id: string; name: string; cardCount: number }>; hasMore: boolean };
    expect(list).toMatchObject({ hasMore: false, decks: [{ id, name: 'Manufacturing practice', cardCount: 3 }] });
    const detail = await (await request('GET', `decks/${id}`, outsider)).json() as { name: string; cards: Array<{ id: string; partOfSpeechEn?: string; partOfSpeechJp?: string }> };
    expect(detail.name).toBe('Manufacturing practice');
    expect(detail.cards.map(card => card.id)).toEqual(['mine-1', bank.find(item => item.level === 'N1')!.id, 'imported-unmatched']);
    expect(detail.cards[0]).toMatchObject({ partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' });
    const adminList = await (await request('GET', `admin/decks?sourceUid=${source}`, admin)).json() as { decks: Array<{ name: string; cardCount: number }> };
    expect(adminList.decks[0]).toMatchObject({ name: 'Manufacturing practice', cardCount: 3 });
    expect(JSON.parse((await db.prepare('SELECT lists FROM user_data WHERE uid = ?').bind(source).first<{ lists: string }>())!.lists)).toEqual([]); // slot is free

    expect((await request('DELETE', `admin/decks/${id}`, source)).status).toBe(403);
    expect((await request('DELETE', `admin/decks/${id}`, admin)).status).toBe(200);
    expect((await request('GET', `decks/${id}`, outsider)).status).toBe(404);
  });
  it('publishes only a dedicated card group and keeps its snapshot after the group is deleted', async () => {
    const groupId = 'group-batch';
    const batchCard = { id: 'batch-card', expression: 'BatchOnly', reading: 'ばっちおんりー', meaning: 'batch-only card', level: 'Custom', createdAt: '2026-01-01' };
    const group = { id: groupId, name: 'CSV Batch A', createdAt: '2026-01-01', wordIds: [batchCard.id] };
    await db.prepare('UPDATE user_data SET lists = ?, custom_words = ?, card_groups = ? WHERE uid = ?')
      .bind('[]', JSON.stringify([batchCard]), JSON.stringify([group]), source).run();
    expect(await (await request('GET', 'admin/decks/sources/owner', admin)).json()).toEqual({
      lists: [], groups: [{ id: `group:${groupId}`, name: 'CSV Batch A', cardCount: 1 }],
    });

    const published = await request('POST', 'admin/decks', admin, {
      sourceUid: source, listId: `group:${groupId}`, visibility: 'public', recipientUids: [],
    });
    expect(published.status).toBe(201);
    const id = (await published.json() as { id: string }).id;
    const detail = await (await request('GET', `decks/${id}`, outsider)).json() as { name: string; cards: Array<{ id: string; expression: string }> };
    expect(detail).toMatchObject({ name: 'CSV Batch A', id, cardCount: 1, visibility: 'public', cards: [{ id: batchCard.id, expression: batchCard.expression, meaning: batchCard.meaning, level: 'Custom', tags: [] }] });
    expect(JSON.parse((await db.prepare('SELECT lists FROM user_data WHERE uid = ?').bind(source).first<{ lists: string }>())!.lists)).toEqual([]);

    await db.prepare('UPDATE user_data SET card_groups = ?, custom_words = ? WHERE uid = ?').bind('[]', '[]', source).run();
    const afterSourceDelete = await (await request('GET', `decks/${id}`, outsider)).json() as { name: string; cards: Array<{ id: string }> };
    expect(afterSourceDelete).toMatchObject({ name: 'CSV Batch A', cards: [{ id: batchCard.id }] });
    expect((await request('DELETE', `admin/decks/${id}`, source)).status).toBe(403);
    expect((await request('DELETE', `admin/decks/${id}`, admin)).status).toBe(200);
  });
});
