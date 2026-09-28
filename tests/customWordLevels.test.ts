import { beforeEach, describe, expect, it } from 'vitest';
import { addCustomWord, CUSTOM_LEVELS, customWordsToWords, loadCustomWords, persistCustomWords, sanitizeCustomWords, updateCustomWord } from '@/lib/customWords';
import { parseWordImport, prepareBulkImport } from '@/lib/bulkWordImport';
import { vocabulary, type WordLevel } from '@/lib/vocabulary';
import { TIERS } from '../shared/ranked';

beforeEach(() => localStorage.clear());

describe('Custom personal-word level', () => {
  it('appends Custom without reordering the five JLPT options', () => {
    expect(CUSTOM_LEVELS).toEqual(['N5', 'N4', 'N3', 'N2', 'N1', 'Custom']);
  });
  it('round-trips every selectable level and preserves legacy JLPT levels', () => {
    const words = CUSTOM_LEVELS.map((level, i) => addCustomWord([], { expression: `造語${i}`, reading: 'ぞうご', meaning: 'coined word', level }).words[0]);
    persistCustomWords(words);
    expect(loadCustomWords()).toEqual(words);
    expect(customWordsToWords(loadCustomWords()).map(word => word.level)).toEqual(CUSTOM_LEVELS);
    expect(sanitizeCustomWords([{ expression: '未分類' }])[0].level).toBe('N5');
    expect(sanitizeCustomWords([{ expression: '旧単語', level: 'N2' }])[0].level).toBe('N2');
  });

  it('changes Custom to a JLPT level and back without changing identity', () => {
    const draft = { expression: '造語', reading: 'ぞうご', meaning: 'coined word', level: 'Custom' as const };
    const original = addCustomWord([], draft).words;
    const changed = updateCustomWord(original, original[0].id, { ...draft, level: 'N3' });
    expect(changed[0]).toEqual({ ...original[0], level: 'N3' });
    expect(updateCustomWord(changed, changed[0].id, draft)).toEqual(original);
  });

  it.each(CUSTOM_LEVELS)('applies %s only to unmatched CSV words', (level: WordLevel) => {
    const original = vocabulary.find(word => word.expression === '猫' && word.reading === 'ねこ')!;
    const existing = addCustomWord([], { expression: '私の既存語', reading: 'わたしのきそんご', meaning: 'keep me', level: 'N2' }).words;
    const result = prepareBulkImport({ customWords: existing }, {
      rows: parseWordImport('expression,reading,meaning\n猫,ねこ,do not overwrite\n私の既存語,わたしのきそんご,do not overwrite\n新造語,しんぞうご,newly coined word').rows,
      name: 'Level test', defaultLevel: level, importId: 'custom-level-test-001',
    }, [original]);
    expect(result.createdCount).toBe(1);
    expect(result.originalCount).toBe(1);
    expect(result.reusedCount).toBe(1);
    expect(result.customWords.find(word => word.expression === '新造語')).toMatchObject({ level, meaning: 'newly coined word' });
    expect(result.customWords.find(word => word.id === existing[0].id)).toEqual(existing[0]);
    expect(result.list.wordIds).toContain(original.id);
    expect(original.level).toBe('N5');
    expect(original.meaning).not.toBe('do not overwrite');
  });

  it('does not introduce Custom into the original catalogue or ranked tiers', () => {
    expect(TIERS).toEqual(['N5', 'N4', 'N3', 'N2', 'N1']);
    expect(vocabulary.every(word => TIERS.includes(word.level))).toBe(true);
  });
});
