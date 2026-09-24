import { beforeEach, expect, it, vi } from 'vitest';
import { commitBulkImport } from '../src/lib/bulkImportStore';
import { parseWordImport } from '../src/lib/bulkWordImport';
import type { Word } from '../src/lib/vocabulary';
import { ApiError, api, fake, resetFake } from './helpers/fakeApi';

// Talk to the in-memory fake instead of the real Worker.
vi.mock('@/lib/api', () => import('./helpers/fakeApi'));

const original: Word = { id: 'cat', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', tags: [] };
const request = { rows: parseWordImport('expression,reading\n猫,ねこ\n命綱,いのちづな').rows, name: 'My CSV', defaultLevel: 'N3' as const, importId: 'transaction-test-0001' };

beforeEach(() => {
  resetFake({ lists: [], customWords: [], nickname: 'Keep me', history: [{ score: 1, total: 2 }] });
});

it('commits slot, active selection and custom entries in one write, leaving profile fields alone', async () => {
  const result = await commitBulkImport('alice', request, [original]);

  expect(fake.writes).toHaveLength(1);
  expect(Object.keys(fake.writes[0]).sort()).toEqual(['activeId', 'customWords', 'lists', 'version']);
  expect(fake.me.activeId).toBe(result.list.id);
  expect(fake.me.lists[0].wordIds).toContain(fake.me.customWords[0].id);
  // Profile fields must survive the merge-patch.
  expect(fake.me.nickname).toBe('Keep me');
  expect(fake.me.history).toEqual([{ score: 1, total: 2 }]);
});

it('failure leaves no orphan custom words, empty new slot or active-slot change', async () => {
  fake.errors.saveMe = new Error('Offline');
  const before = JSON.parse(JSON.stringify(fake.me));

  await expect(commitBulkImport('alice', request, [original])).rejects.toThrow('Offline');

  expect(fake.me).toEqual(before);
  expect(fake.writes).toHaveLength(0);
});

it('retrying after a lost success response uses the same list and custom IDs', async () => {
  const first = await commitBulkImport('alice', request, [original]);
  const second = await commitBulkImport('alice', request, [original]);

  expect(first.list.id).toBe(second.list.id);
  expect(fake.me.lists).toHaveLength(1);
  expect(fake.me.customWords).toHaveLength(1);
});

it('re-matches against latest cloud data rather than stale preview/local arrays', async () => {
  resetFake({
    lists: [],
    customWords: [{ id: 'added-on-another-device', expression: '命綱', reading: 'いのちづな', meaning: 'Keep this', level: 'N1', createdAt: '2026-01-01' }],
    history: [],
  });

  const result = await commitBulkImport('alice', request, [original]);

  expect(result.createdCount).toBe(0);
  expect(result.reusedCount).toBe(1);
  expect(result.list.wordIds).toEqual(['cat', 'added-on-another-device']);
  expect(result.customWords[0].meaning).toBe('Keep this');
});

it('re-checks the slot limit on the server and aborts if the account changes', async () => {
  resetFake({
    lists: Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: 'Slot', wordIds: [], createdAt: '2026-01-01' })),
    customWords: [], history: [],
  });
  await expect(commitBulkImport('alice', request, [original])).rejects.toThrow('10 save slots');
  expect(fake.writes).toHaveLength(0);

  resetFake({ lists: [], customWords: [], history: [] });
  let owner = true;
  fake.afterRead = () => { owner = false; };
  await expect(commitBulkImport('alice', request, [original], () => owner)).rejects.toThrow('Account changed');
  expect(fake.writes).toHaveLength(0);
});

it('retries with fresh data when another device saved in between (409)', async () => {
  // D1 has no read-then-write transaction, so the guarantee now comes from
  // optimistic locking: 409 -> refetch -> recompute -> write again.
  const saveSpy = vi.spyOn(api, 'saveMe').mockRejectedValueOnce(new ApiError(409, 'stale'));

  const result = await commitBulkImport('alice', request, [original]);

  expect(saveSpy).toHaveBeenCalledTimes(2);
  expect(fake.me.lists).toHaveLength(1);
  expect(fake.me.customWords).toHaveLength(1);
  expect(fake.me.version).toBe(1);
  expect(result.list.id).toBe(fake.me.activeId);
  saveSpy.mockRestore();
});
