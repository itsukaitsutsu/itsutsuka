// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { prepareAdminWordChange } from '../worker/adminWords';

const words = [
  { id: 'card-1', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', createdAt: '2026-01-01' },
  { id: 'card-2', expression: '犬', reading: 'いぬ', meaning: 'dog', level: 'N5', createdAt: '2026-01-01' },
];
const lists = [{ id: 'slot', name: 'Saved', createdAt: '2026-01-01', wordIds: ['card-1', 'card-2', 'built-in'] }];

describe('admin personal card changes', () => {
  it('adds and upserts meanings by exact expression+reading without changing levels or IDs', () => {
    const result = prepareAdminWordChange(words, lists, { version: 2, entries: [
      { expression: '猫', reading: 'ねこ', meaning: 'kitty' },
      { expression: '鳥', reading: 'とり', meaning: 'bird' },
    ], listId: 'slot' });
    expect(result).toMatchObject({ created: 1, updated: 1, deleted: 0 });
    expect(result.customWords[0]).toMatchObject({ id: 'card-1', meaning: 'kitty', level: 'N5' });
    expect(result.customWords[2]).toMatchObject({ expression: '鳥', level: 'Custom' });
    expect(result.lists[0].wordIds).toContain(result.customWords[2].id);
    expect(words[0].meaning).toBe('cat');
    expect(lists[0].wordIds).toEqual(['card-1', 'card-2', 'built-in']);
  });
  it('deletes selected personal cards and clears only their saved-list references', () => {
    const result = prepareAdminWordChange(words, lists, { version: 1, deleteIds: ['card-1'] });
    expect(result.customWords.map(word => word.id)).toEqual(['card-2']);
    expect(result.lists[0].wordIds).toEqual(['card-2', 'built-in']);
  });
  it('bulk edits levels and meanings while preserving IDs and save slots', () => {
    const result = prepareAdminWordChange(words, lists, { version: 1, entries: [
      { id: 'card-1', expression: '猫', reading: 'ねこ', level: 'N2', meaning: 'feline' },
      { id: 'card-2', expression: '犬', reading: 'いぬ', level: 'Custom' },
    ] });
    expect(result.updated).toBe(2);
    expect(result.customWords.map(word => [word.id, word.level, word.meaning])).toEqual([['card-1', 'N2', 'feline'], ['card-2', 'Custom', 'dog']]);
    expect(result.lists[0].wordIds).toEqual(lists[0].wordIds);
  });
  it('syncs bilingual POS changes onto an existing personal card', () => {
    const result = prepareAdminWordChange(words, lists, { version: 1, entries: [{
      id: 'card-1', expression: '猫', reading: 'ねこ', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞',
    }] });
    expect(result.customWords[0]).toMatchObject({ id: 'card-1', partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' });
    expect(words[0]).not.toHaveProperty('partOfSpeechEn');
  });
  it('changes an expression only when editing by stable card ID', () => {
    const result = prepareAdminWordChange(words, lists, { version: 1, entries: [{ id: 'card-1', expression: 'ねこ', reading: 'ネコ', meaning: '', level: 'Custom' }] });
    expect(result.customWords[0]).toMatchObject({ id: 'card-1', expression: 'ねこ', reading: 'ネコ', meaning: '', level: 'Custom' });
  });
  it('assigns imported and matching cards to a dedicated group without changing other memberships', () => {
    const groups = [
      { id: 'group-previous', name: 'Previous batch', createdAt: '2026-01-01', wordIds: ['card-1'] },
      { id: 'group-current', name: 'Current batch', createdAt: '2026-01-02', wordIds: [] },
    ];
    const result = prepareAdminWordChange(words, lists, { version: 3, groupId: 'group-current', entries: [
      { expression: '猫', reading: 'ねこ', meaning: 'kitty' },
      { expression: '鳥', reading: 'とり', meaning: 'bird' },
    ] }, groups);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.groups[0].wordIds).toEqual(['card-1']);
    expect(result.groups[1].wordIds).toContain('card-1');
    expect(result.groups[1].wordIds).toContain(result.customWords[2].id);
    expect(groups[1].wordIds).toEqual([]);
  });
  it('creates, renames, and deletes groups without deleting their cards', () => {
    const created = prepareAdminWordChange(words, lists, { version: 1, groupAction: { type: 'create', name: 'Batch A' } }, []);
    expect(created.createdGroupId).toMatch(/^group-/);
    expect(created.groups[0]).toMatchObject({ id: created.createdGroupId, name: 'Batch A', wordIds: [] });
    const groups = [{ id: 'group-existing', name: 'Old name', createdAt: '2026-01-01', wordIds: ['card-1'] }];
    const renamed = prepareAdminWordChange(words, lists, { version: 2, groupAction: { type: 'rename', id: 'group-existing', name: 'New name' } }, groups);
    expect(renamed.groups[0].name).toBe('New name');
    const deleted = prepareAdminWordChange(words, lists, { version: 3, groupAction: { type: 'delete', id: 'group-existing' } }, groups);
    expect(deleted.groups).toEqual([]);
    expect(deleted.customWords.map(word => word.id)).toEqual(['card-1', 'card-2']);
  });
  it('removes deleted cards from every group without deleting the groups', () => {
    const groups = [
      { id: 'group-a', name: 'A', createdAt: '2026-01-01', wordIds: ['card-1', 'card-2'] },
      { id: 'group-b', name: 'B', createdAt: '2026-01-02', wordIds: ['card-1'] },
    ];
    const result = prepareAdminWordChange(words, lists, { version: 1, deleteIds: ['card-1'] }, groups);
    expect(result.groups.map(group => group.wordIds)).toEqual([['card-2'], []]);
  });
  it('rejects invalid, ambiguous and oversized changes atomically', () => {
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: [{ expression: '', reading: 'a' }] })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: [{ expression: '猫', reading: 'ねこ', level: 'admin' as never }] })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, deleteIds: ['built-in'] })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: [{ id: 'fake', expression: 'hi', reading: 'hi' }] })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: [{ id: 'card-1', expression: '犬', reading: 'いぬ' }] })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: Array.from({ length: 5001 }, (_, i) => ({ expression: `a${i}`, reading: 'b' })) })).toThrow();
    expect(() => prepareAdminWordChange(words, lists, { version: 1, entries: [{ expression: '猫', reading: 'ねこ' }, { expression: '猫', reading: 'ねこ' }] })).toThrow();
    expect(words).toHaveLength(2);
  });
});
