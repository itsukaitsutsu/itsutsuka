import { describe, expect, it } from 'vitest';
import sample from './fixtures/new_bulk_test.csv?raw';
import { isQuizReadyWord, matchWordImport, MAX_IMPORT_BYTES, parseWordImport, prepareBulkImport } from '../src/lib/bulkWordImport';
import { wordProgressKey } from '../src/lib/cardProgress';
import { vocabulary, type Word } from '../src/lib/vocabulary';
import type { CustomWord } from '../src/lib/customWords';

const cat: Word = { id: 'original-cat', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', tags: [] };
const request = (text = 'expression,reading\n猫,ねこ\n命綱,いのちづな') => ({ rows: parseWordImport(text).rows, name: 'Imported words', defaultLevel: 'N3' as const, importId: 'fixture-import-0001' });

describe('CSV decoding and validation', () => {
  it('handles BOM, CRLF, aliases, whitespace, quotes and optional ignored columns', () => {
    const parsed = parseWordImport('\uFEFF KANJI , Furigana ,meaning\r\n 猫 , ねこ ,"cat, feline"\r\n命綱,いのちづな,"quoted ""text""\nand newline"\r\n');
    expect(parsed.rows).toEqual([{ expression: '猫', reading: 'ねこ', line: 2 }, { expression: '命綱', reading: 'いのちづな', line: 3 }]);
    expect(parsed.ignoredColumns).toEqual(['meaning']);
    expect(parsed.issues).toHaveLength(0);
  });
  it('does not split semicolons or guess kana/kanji equivalences', () => {
    const parsed = parseWordImport('expression,reading\n在る; 有る,ある\n行き,いき\n行き,ゆき');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].expression).toBe('在る; 有る');
    expect(matchWordImport(parsed.rows, [{ ...cat, expression: '在る', reading: 'ある' }], [])[0].source).toBe('new');
  });
  it('deduplicates normalized identity but keeps different readings distinct', () => {
    const parsed = parseWordImport('expression,reading\n猫,ねこ\n 猫 , ねこ \nＡ,ｶﾅ\nA,カナ\n猫,びょう');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.duplicates).toBe(2);
  });
  it('reports invalid data rows by line without silently importing them', () => {
    const parsed = parseWordImport('expression,reading\n猫,ねこ\n,empty\n犬,\n犬,いぬ,extra\n"a\nb",かな');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.issues.map((issue) => issue.line)).toEqual([3, 4, 5, 6]);
  });
  it('rejects empty files, missing/ambiguous headers and structurally broken CSV', () => {
    for (const text of ['', 'kanji\n猫', 'expression,kanji,reading\n猫,猫,ねこ', 'expression,reading\n"猫,ねこ', 'expression,reading\n"猫"bad,ねこ']) {
      expect(() => parseWordImport(text)).toThrow();
    }
    expect(parseWordImport('expression,reading\n').rows).toHaveLength(0);
  });
  it('rejects oversized files and row counts rather than silently truncating', () => {
    expect(() => parseWordImport('a'.repeat(MAX_IMPORT_BYTES + 1))).toThrow(/too large/);
    expect(() => parseWordImport('expression,reading\n' + '猫,ねこ\n'.repeat(5001))).toThrow(/5,000/);
  });
});

describe('import planning and atomic payload', () => {
  it('matches the supplied 773-row file: 772 originals and one new custom word', () => {
    const parsed = parseWordImport(sample);
    expect(parsed.dataRows).toBe(773);
    expect(parsed.rows).toHaveLength(773);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.issues).toHaveLength(0);
    const matches = matchWordImport(parsed.rows, vocabulary, []);
    expect(matches.filter((item) => item.source === 'original')).toHaveLength(772);
    expect(matches.filter((item) => item.source === 'new')).toMatchObject([{ expression: '命綱', reading: 'いのちづな' }]);
    const result = prepareBulkImport({}, { ...request(), rows: parsed.rows, name: 'new_bulk_test' }, vocabulary);
    expect(result.list.wordIds).toHaveLength(773);
    expect(new Set(result.list.wordIds).size).toBe(773);
    expect(result.customWords).toHaveLength(1);
    expect(result.customWords[0]).toMatchObject({ expression: '命綱', reading: 'いのちづな', meaning: '', level: 'N3' });
    expect(result.originalCount).toBe(772);
    expect(result.createdCount).toBe(1);
  });
  it('never overwrites original meaning/level, ignores conflicting CSV fields, and reuses custom matches', () => {
    const custom: CustomWord = { id: 'my-rope', expression: '命綱', reading: 'いのちづな', meaning: 'personal meaning', level: 'N2', createdAt: '2026-01-01' };
    const customCat = { ...custom, id: 'my-cat', expression: '猫', reading: 'ねこ', meaning: 'other meaning' };
    const data = { customWords: [custom, customCat], history: [{ score: 4, total: 5 }], nickname: 'Test' };
    const before = JSON.stringify(data);
    const result = prepareBulkImport(data, request('expression,reading,meaning,level\n猫,ねこ,WRONG,N1\n命綱,いのちづな,WRONG,N5'), [cat]);
    expect(result.list.wordIds).toEqual(['original-cat', 'my-rope']);
    expect(result.customWords).toEqual([custom, customCat]);
    expect(result.createdCount).toBe(0);
    expect(JSON.stringify(data)).toBe(before);
    expect(cat.meaning).toBe('cat');
  });
  it('deduplicates retries and reuse across separate imports without creating extra custom entries', () => {
    const first = prepareBulkImport({}, request(), [cat]);
    const next = prepareBulkImport({ lists: first.lists, customWords: first.customWords }, request(), [cat]);
    expect(next.lists).toHaveLength(1);
    expect(next.customWords).toHaveLength(1);
    expect(next.list.id).toBe(first.list.id);
    const another = prepareBulkImport({ lists: first.lists, customWords: first.customWords }, { ...request(), importId: 'fixture-import-0002' }, [cat]);
    expect(another.lists).toHaveLength(2);
    expect(another.customWords).toHaveLength(1);
    expect(another.reusedCount).toBe(1);
    expect(another.list.wordIds).toEqual(first.list.wordIds);
  });
  it('blocks slot/document limits with no partial mutation', () => {
    const data = { lists: Array.from({ length: 10 }, (_, i) => ({ id: `slot${i}`, name: 'Slot', wordIds: [], createdAt: '2026-01-01' })) };
    expect(() => prepareBulkImport(data, request(), [cat])).toThrow(/10 save slots/);
    expect(data.lists).toHaveLength(10);
    expect(() => prepareBulkImport({ nickname: 'x'.repeat(800000) }, request(), [cat])).toThrow(/too large/);
  });
  it('keeps seen identity stable without mutating progress and excludes blank meanings from quiz eligibility', () => {
    const seen = new Set([wordProgressKey(cat)]);
    const matches = matchWordImport(request().rows, [cat], []);
    expect(matches.filter((item) => seen.has(item.key))).toHaveLength(1);
    const result = prepareBulkImport({}, request(), [cat]);
    expect(seen).toEqual(new Set([wordProgressKey(cat)]));
    expect(isQuizReadyWord(result.customWords[0])).toBe(false);
    expect(isQuizReadyWord(cat)).toBe(true);
  });
});
