import { describe, expect, it } from 'vitest';
import sample from './fixtures/new_bulk_test.csv?raw';
import { isQuizReadyWord, matchWordImport, MAX_IMPORT_BYTES, parseWordImport, prepareBulkImport } from '../src/lib/bulkWordImport';
import { wordProgressKey } from '../src/lib/cardProgress';
import { vocabulary, type Word } from '../src/lib/vocabulary';
import type { CustomWord } from '../src/lib/customWords';

const cat: Word = { id: 'original-cat', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', tags: [] };
const request = (text = 'expression,reading\n猫,ねこ\n命綱,いのちづな') => ({ rows: parseWordImport(text).rows, name: 'Imported words', defaultLevel: 'N3' as const, importId: 'fixture-import-0001' });

describe('CSV decoding and validation', () => {
  it('handles BOM, CRLF, aliases, whitespace and quoted meanings', () => {
    const parsed = parseWordImport('\uFEFF KANJI , Furigana ,meaning\r\n 猫 , ねこ ,"cat, feline"\r\n命綱,いのちづな,"quoted ""text""\nand newline"\r\n');
    expect(parsed.rows).toEqual([{ expression: '猫', reading: 'ねこ', meaning: 'cat, feline', line: 2 }, { expression: '命綱', reading: 'いのちづな', meaning: 'quoted "text"\nand newline', line: 3 }]);
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.issues).toHaveLength(0);
  });
  it('parses the bilingual POS columns and ignores unrelated columns', () => {
    const parsed = parseWordImport('part_of_speech_en,expression,part_of_speech_jp,reading,meaning,tags\nParticle,は,助詞,は,topic marker,JLPT_N5');
    expect(parsed.rows).toEqual([{ expression: 'は', reading: 'は', meaning: 'topic marker', partOfSpeechEn: 'Particle', partOfSpeechJp: '助詞', line: 2 }]);
    expect(parsed.ignoredColumns).toEqual(['tags']);
  });
  it('detects an optional meaning header in any position and preserves meaning text', () => {
    const parsed = parseWordImport(' Meaning ,reading,expression,level\n  Ａ lifeline  ,いのちづな,命綱,N1\n   ,ねこ,猫,N5');
    expect(parsed.rows.map((row) => row.meaning)).toEqual(['Ａ lifeline', '']);
    expect(parsed.ignoredColumns).toEqual(['level']);
    expect(() => parseWordImport('expression,reading,meaning, MEANING\n猫,ねこ,cat,kitten')).toThrow(/at most one meaning/);
  });
  it('keeps the first valid row when duplicate identities have different meanings', () => {
    const parsed = parseWordImport('expression,reading,meaning\n命綱,いのちづな,lifeline\n 命綱 , いのちづな ,safety rope');
    expect(parsed.duplicates).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].meaning).toBe('lifeline');
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
  it('syncs bilingual POS onto new My words while leaving matched source cards untouched', () => {
    const result = prepareBulkImport({}, request('expression,reading,part_of_speech_jp,part_of_speech_en,meaning\n猫,ねこ,名詞,Noun,WRONG\n命綱,いのちづな,名詞,Noun,lifeline'), [cat]);
    expect(result.customWords).toHaveLength(1);
    expect(result.customWords[0]).toMatchObject({
      expression: '命綱', meaning: 'lifeline', partOfSpeechJp: '名詞', partOfSpeechEn: 'Noun',
    });
    expect(result.list.wordIds).toContain('original-cat');
    expect(cat.meaning).toBe('cat');
    expect(cat.partOfSpeechEn).toBeUndefined();
  });
  it('saves CSV meanings only for new identities, leaving missing meanings blank', () => {
    const result = prepareBulkImport({}, request('expression,reading,meaning,level\n猫,ねこ,WRONG,N1\n命綱,いのちづな," lifeline, safety rope ",N1\n猫,びょう,alternate reading,N1\n未登録,みとうろく,,N1'), [cat]);
    expect(result.originalCount).toBe(1);
    expect(result.createdCount).toBe(3);
    expect(result.customWords.map(({ expression, meaning, level }) => ({ expression, meaning, level }))).toEqual([
      { expression: '命綱', meaning: 'lifeline, safety rope', level: 'N3' },
      { expression: '猫', meaning: 'alternate reading', level: 'N3' },
      { expression: '未登録', meaning: '', level: 'N3' },
    ]);
    expect(cat.meaning).toBe('cat');
    expect(isQuizReadyWord(result.customWords[0])).toBe(true);
    expect(isQuizReadyWord(result.customWords[2])).toBe(false);
  });
  it('does not fill blank meanings on existing cards or overwrite a previous import', () => {
    const first = prepareBulkImport({}, request('expression,reading,meaning\n命綱,いのちづな,lifeline'), [cat]);
    const changed = { ...request('expression,reading,meaning\n命綱,いのちづな,replacement'), importId: 'fixture-import-0002' };
    const second = prepareBulkImport(first, changed, [cat]);
    expect(second.createdCount).toBe(0);
    expect(second.customWords[0].meaning).toBe('lifeline');
    const blank = { ...first.customWords[0], meaning: '' };
    expect(prepareBulkImport({ customWords: [blank] }, changed, []).customWords[0].meaning).toBe('');
    const blankOriginal = { ...cat, meaning: '' };
    const originalResult = prepareBulkImport({}, request('expression,reading,meaning\n猫,ねこ,cat'), [blankOriginal]);
    expect(originalResult.customWords).toHaveLength(0);
    expect(blankOriginal.meaning).toBe('');
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
