// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import bank from '../worker/rankedBank.json';

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const admin = 'admin-content-owner';
const sourceUid = 'personal-owner';
const recipient = 'content-recipient';
const baseWord = bank.find(word => word.level === 'N5')!;
const request = (method: string, path: string, uid?: string, body?: unknown) => mf.dispatchFetch(`http://example.com/api/${path}`, {
  method,
  headers: { ...(uid ? { Authorization: `Bearer ${uid}` } : {}), 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeAll(async () => {
  const compiled = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], plugins: [{ name: 'mock-admin-auth', setup(builder) {
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
  mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-05-03',
    bindings: { WORD_ADMIN_UIDS: admin }, d1Databases: ['DB'], durableObjects: { MATCH_ROOM: { className: 'MatchRoom', useSQLite: true } } });
  db = await mf.getD1Database('DB');
  for (const file of ['0001_init.sql', '0009_published_decks.sql', '0010_published_deck_snapshots.sql', '0011_admin_card_groups.sql', '0012_admin_content_library.sql']) {
    await db.exec(readFileSync(`migrations/${file}`, 'utf8').replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  }
  const personalCards = [
    { id: 'mine-1', expression: '製造', reading: 'せいぞう', meaning: 'personal meaning', level: 'Custom', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', createdAt: '2026-01-01' },
    { id: 'mine-2', expression: '製造', reading: 'せいぞう', meaning: 'duplicate personal identity', level: 'Custom', createdAt: '2026-01-02' },
    { id: 'mine-base-copy', expression: baseWord.expression, reading: baseWord.reading, meaning: 'built-in saved as custom without POS', level: 'Custom', createdAt: '2026-01-03' },
  ];
  const lists = [{ id: 'save-slot-1', name: 'Personal save slot', createdAt: '2026-01-01', wordIds: ['mine-1', 'mine-base-copy'] }];
  const groups = [{ id: 'personal-group-1', name: 'My SSW group', createdAt: '2026-01-01', wordIds: ['mine-1', baseWord.id] }];
  await db.prepare(`INSERT INTO user_data (uid, lists, custom_words, card_groups, history, nickname, version, updated_at)
    VALUES (?, ?, ?, ?, '[]', 'Source', 7, ?)`).bind(sourceUid, JSON.stringify(lists), JSON.stringify(personalCards), JSON.stringify(groups), new Date().toISOString()).run();
}, 30000);

afterAll(async () => { await mf?.dispose(); });

describe('admin-owned content catalog and personal-source synchronization', () => {
  it('enforces admin-only access, keeps CSV files separate, reuses matching cards, and preserves frozen publications', async () => {
    expect((await request('GET', 'admin/content')).status).toBe(401);
    expect((await request('GET', 'admin/content', sourceUid)).status).toBe(403);
    expect((await request('POST', 'admin/content/import-csv', sourceUid, { files: [] })).status).toBe(403);

    const createdGroup = await request('POST', 'admin/content/groups', admin, { name: 'SSW Manufacture' });
    expect(createdGroup.status).toBe(201);
    const groupId = (await createdGroup.json() as { id: string }).id;
    const imported = await request('POST', 'admin/content/import-csv', admin, { groupId, files: [
      { name: '3R basics.csv', rows: [
        { expression: '製造', reading: 'せいぞう', meaning: 'manufacturing', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' },
        { expression: '工程', reading: 'こうてい', meaning: 'process' },
      ] },
      { name: '5S activities.csv', rows: [
        { expression: '製造', reading: 'せいぞう', meaning: 'manufacturing work' },
        { expression: '確認', reading: 'かくにん', meaning: 'confirmation' },
      ] },
    ] });
    expect(imported.status).toBe(201);
    const batches = (await imported.json() as { batches: Array<{ id: string; name: string; cardCount: number }> }).batches;
    expect(batches).toMatchObject([
      { name: '3R basics.csv', cardCount: 2 },
      { name: '5S activities.csv', cardCount: 2 },
    ]);
    const groupCatalog = await (await request('GET', 'admin/content', admin)).json() as { groups: Array<{ id: string; name: string; batchCount: number; cardCount: number }>; batches: Array<{ id: string; groupId: string }> };
    expect(groupCatalog.groups).toContainEqual(expect.objectContaining({ id: groupId, name: 'SSW Manufacture', batchCount: 2, cardCount: 3 }));
    expect(groupCatalog.batches.filter(batch => batch.groupId === groupId)).toHaveLength(2);
    const firstBatch = await (await request('GET', `admin/content/cards?batchId=${batches[0].id}`, admin)).json() as { cards: Array<{ expression: string; batchIds: string[] }> };
    expect(firstBatch.cards).toHaveLength(2);
    const groupCards = await (await request('GET', `admin/content/cards?groupId=${groupId}`, admin)).json() as { cards: Array<{ expression: string; batchIds: string[] }> };
    expect(groupCards.cards).toHaveLength(3);
    expect(groupCards.cards.find(card => card.expression === '製造')?.batchIds).toHaveLength(2);

    const sourceBefore = await db.prepare('SELECT lists, custom_words, card_groups, version FROM user_data WHERE uid=?').bind(sourceUid).first<{ lists: string; custom_words: string; card_groups: string; version: number }>();
    const copied = await request('POST', 'admin/content/personal-copy', admin, {
      sourceUid, sourceKind: 'group', sourceId: 'personal-group-1', sourceAll: true, selectedSourceIds: [],
      name: 'Copied personal SSW group', groupId,
    });
    expect(copied.status).toBe(201);
    const copiedBatch = (await copied.json() as { batch: { id: string; kind: string; cardCount: number; groupId: string } }).batch;
    expect(copiedBatch).toMatchObject({ kind: 'personal', cardCount: 2, groupId }); // duplicate personal identity is reused
    const afterCopy = await db.prepare('SELECT lists, custom_words, card_groups, version FROM user_data WHERE uid=?').bind(sourceUid).first<{ lists: string; custom_words: string; card_groups: string; version: number }>();
    expect(afterCopy).toEqual(sourceBefore); // the source account is read-only to the catalog copy route

    const slotCopy = await request('POST', 'admin/content/personal-copy', admin, {
      sourceUid, sourceKind: 'list', sourceId: 'save-slot-1', sourceAll: true, selectedSourceIds: [], name: 'Copied save slot',
    });
    expect(slotCopy.status).toBe(201);
    const slotBatch = (await slotCopy.json() as { batch: { id: string; cardCount: number } }).batch;
    expect(slotBatch.cardCount).toBe(2);
    const slotCards = await (await request('GET', `admin/content/cards?batchId=${slotBatch.id}`, admin)).json() as { cards: Array<{ expression: string; reading: string; level: string; partOfSpeechEn?: string; partOfSpeechJp?: string }> };
    expect(slotCards.cards.find(card => card.expression === baseWord.expression)).toMatchObject({
      reading: baseWord.reading, level: baseWord.level, partOfSpeechEn: baseWord.partOfSpeechEn, partOfSpeechJp: baseWord.partOfSpeechJp,
    }); // POS and level are recovered from the canonical word identity, not assumed absent

    const nextPersonalCards = [
      { id: 'mine-2', expression: '製造', reading: 'せいぞう', meaning: 'updated personal meaning', level: 'Custom', createdAt: '2026-01-02' },
      { id: 'mine-3', expression: '追加', reading: 'ついか', meaning: 'added word', level: 'Custom', createdAt: '2026-02-01' },
    ];
    const nextPersonalGroup = [{ id: 'personal-group-1', name: 'My SSW group', createdAt: '2026-01-01', wordIds: ['mine-2', 'mine-3'] }];
    await db.prepare('UPDATE user_data SET custom_words=?,card_groups=?,version=version+1 WHERE uid=?')
      .bind(JSON.stringify(nextPersonalCards), JSON.stringify(nextPersonalGroup), sourceUid).run();
    const synchronized = await request('POST', `admin/content/batches/${copiedBatch.id}/sync`, admin, {});
    expect(synchronized.status).toBe(200);
    expect(await synchronized.json()).toMatchObject({ added: 2, updated: 0, removed: 2, sourceMissing: false });
    const syncEvents = await (await request('GET', 'admin/content/events?limit=10', admin)).json() as { events: Array<{ id: string; action: string; batch_id: string }> };
    const syncEvent = syncEvents.events.find(event => event.action === 'personal_sync' && event.batch_id === copiedBatch.id)!;
    const syncDetails = await (await request('GET', `admin/content/events/${syncEvent.id}`, admin)).json() as { cards: Array<{ change_type: string; expression: string }> };
    expect(syncDetails.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ change_type: 'added', expression: '追加' }),
      expect.objectContaining({ change_type: 'added', expression: '製造' }),
      expect.objectContaining({ change_type: 'removed', expression: '製造' }),
      expect.objectContaining({ change_type: 'removed', expression: baseWord.expression }),
    ]));
    const personalAfterSync = await db.prepare('SELECT custom_words, card_groups FROM user_data WHERE uid=?').bind(sourceUid).first<{ custom_words: string; card_groups: string }>();
    expect(JSON.parse(personalAfterSync!.custom_words)).toEqual(nextPersonalCards);
    expect(JSON.parse(personalAfterSync!.card_groups)).toEqual(nextPersonalGroup);
    const manufactureInCsv = await (await request('GET', `admin/content/cards?batchId=${batches[0].id}`, admin)).json() as { cards: Array<{ expression: string }> };
    expect(manufactureInCsv.cards.some(card => card.expression === '製造')).toBe(true); // source removal only affected the personal-copy batch

    const publication = await request('POST', `admin/content/groups/${groupId}/publish`, admin, { visibility: 'selected', recipientUids: [recipient] });
    expect(publication.status).toBe(201);
    const publicationId = (await publication.json() as { id: string }).id;
    expect(await db.prepare('SELECT uid FROM user_data WHERE uid=?').bind(admin).first()).toBeNull(); // no personal save slot created for publication
    const publishedCards = await (await request('GET', `decks/${publicationId}`, recipient)).json() as { name: string; cards: Array<{ expression: string }> };
    expect(publishedCards.name).toBe('SSW Manufacture');
    expect(publishedCards.cards.map(card => card.expression).sort()).toEqual(['確認', '工程', '製造', '追加'].sort());
    expect((await request('GET', `decks/${publicationId}`, 'unauthorized-viewer')).status).toBe(404);

    const deleted = await request('DELETE', `admin/content/batches/${copiedBatch.id}`, admin);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: 2 });
    // Deleting the personal-copy batch deliberately removes shared cards from every admin batch.
    const csvAfterDelete = await (await request('GET', `admin/content/cards?batchId=${batches[0].id}`, admin)).json() as { cards: Array<{ expression: string }> };
    expect(csvAfterDelete.cards.some(card => card.expression === '製造')).toBe(false);
    const snapshotAfterDelete = await (await request('GET', `decks/${publicationId}`, recipient)).json() as { cards: Array<{ expression: string }> };
    expect(snapshotAfterDelete.cards.map(card => card.expression).sort()).toEqual(['確認', '工程', '製造', '追加'].sort());
    expect((await request('DELETE', `admin/decks/${publicationId}`, sourceUid)).status).toBe(403);
    expect((await request('DELETE', `admin/decks/${publicationId}`, admin)).status).toBe(200);

    const history = await (await request('GET', 'admin/content/events?limit=50', admin)).json() as { events: Array<{ action: string }> };
    expect(history.events.some(event => event.action === 'personal_copy')).toBe(true);
    expect(history.events.some(event => event.action === 'personal_sync')).toBe(true);
    expect(history.events.some(event => event.action === 'batch_deleted')).toBe(true);
    // Personal source survives the destructive admin-catalog batch deletion.
    const sourceStillThere = await db.prepare('SELECT custom_words FROM user_data WHERE uid=?').bind(sourceUid).first<{ custom_words: string }>();
    expect(JSON.parse(sourceStillThere!.custom_words)).toEqual(nextPersonalCards);
  });

  it('releases source-linked cards on manual sync if the personal account row no longer exists', async () => {
    const copied = await request('POST', 'admin/content/personal-copy', admin, {
      sourceUid, sourceKind: 'my_words', sourceAll: true, selectedSourceIds: [], name: 'Copy before account removal',
    });
    expect(copied.status).toBe(201);
    const batchId = (await copied.json() as { batch: { id: string; cardCount: number } }).batch.id;
    await db.prepare('DELETE FROM user_data WHERE uid=?').bind(sourceUid).run();
    const response = await request('POST', `admin/content/batches/${batchId}/sync`, admin, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ added: 0, updated: 0, removed: 2, sourceMissing: true });
    const catalogBatch = await (await request('GET', 'admin/content', admin)).json() as { batches: Array<{ id: string; cardCount: number }> };
    expect(catalogBatch.batches.find(batch => batch.id === batchId)?.cardCount).toBe(0);
  });
});
