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
