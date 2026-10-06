import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  eligibleExpression, findExamples, isBoundary, loadExampleSet, resetExampleCache, sectorsForDeck,
  sentencePieces, stripFurigana, type ExampleFile, type ExampleSet,
} from '@/lib/exampleSentences';

const file = (sector: string) => JSON.parse(readFileSync(`public/examples/${sector}.json`, 'utf8')) as ExampleFile;
const hand: ExampleSet = {
  sector: 'manufacture',
  items: [
    // masks produced by scripts/build-example-sentences.py (fugashi/unidic tokenizer)
    { markup: '空気温度を測定します。', plain: '空気温度を測定します。', mask: 'adb', source: 'Hand', page: 1 },
    { markup: 'ノギスで外径を測る。', plain: 'ノギスで外径を測る。', mask: '9b6', source: 'Hand', page: 2 },
    { markup: 'きょうは、ネジを食べた。', plain: 'きょうは、ネジを食べた。', mask: '9db8', source: 'Hand', page: 3 },
  ],
};

describe('which decks get example sentences', () => {
  it('only admin decks named SSW…, and only for sectors that have PDFs', () => {
    expect(sectorsForDeck('SSW_Manufacture_1')).toEqual(['manufacture']);
    expect(sectorsForDeck('SSW MANUFACTURE')).toEqual(['manufacture']);
    expect(sectorsForDeck('ssw_agriculture_2')).toEqual(['agriculture']);
    expect(sectorsForDeck('SSW_Care_1')).toEqual([]);          // no PDFs for this sector -> no examples
    expect(sectorsForDeck('Manufacture words')).toEqual([]);   // not an SSW deck
    expect(sectorsForDeck('SSWork Manufacture')).toEqual([]);
    expect(sectorsForDeck(undefined)).toEqual([]);
  });
});

describe('words that may be matched', () => {
  it('rejects words that are too short or ambiguous', () => {
    expect(eligibleExpression('整理')).toBe('整理');
    expect(eligibleExpression('ノギス')).toBe('ノギス');
    expect(eligibleExpression('油')).toBeNull();
    expect(eligibleExpression('が')).toBeNull();
    expect(eligibleExpression('ねじ')).toBeNull();
    expect(eligibleExpression('はかる')).toBe('はかる');
    expect(eligibleExpression('5S')).toBeNull();
    expect(eligibleExpression('〜について')).toBeNull();
    expect(eligibleExpression('')).toBeNull();
  });
});

describe('exact, word-boundary matching', () => {
  it('finds a word that is a real word of the sentence', () => {
    expect(findExamples([hand], '温度')).toHaveLength(1);
    expect(findExamples([hand], '外径')[0]).toMatchObject({ start: 4, end: 6, source: 'Hand', page: 2 });
  });
  it('does NOT find a word spanning two words (気温 inside 空気温度)', () => {
    expect(findExamples([hand], '気温')).toEqual([]);
  });
  it('does NOT guess verb forms: the dictionary form must appear as written', () => {
    expect(findExamples([hand], '食べる')).toEqual([]);   // sentence has 食べた
    expect(findExamples([hand], '測る')).toHaveLength(1);  // sentence has 測る exactly
    expect(findExamples([hand], '測定')).toHaveLength(1);
  });
  it('returns nothing for words that are not in any sentence', () => {
    expect(findExamples([hand], '猫')).toEqual([]);
    expect(findExamples([hand], '電圧')).toEqual([]);
    expect(findExamples([], '温度')).toEqual([]);
  });
  it('decodes the boundary mask', () => {
    const marks = Array.from({ length: 12 }, (_, i) => isBoundary('adb', i) ? i : -1).filter(i => i >= 0);
    expect(marks).toEqual([0, 2, 4, 5, 7, 8, 10, 11]);   // 空気|温度|を|測定|し|ます|。
  });
});

describe('the generated data files', () => {
  for (const sector of ['manufacture', 'agriculture']) {
    it(`${sector}.json is well formed and every sentence is usable`, () => {
      const data = file(sector);
      expect(data.version).toBe(1);
      expect(data.sentences.length).toBeGreaterThan(500);
      for (const [markup, source, page, mask] of data.sentences) {
        const plain = stripFurigana(markup);
        expect(data.sources[source]).toBeTruthy();
        expect(page).toBeGreaterThan(0);
        expect(plain).toMatch(/[。？！][」』）]?$/);
        expect(plain).not.toMatch(/[\u0000-\u001f]/);
        expect(markup).not.toMatch(/\((?![ぁ-ゖァ-ヺーｰ]{1,40}\))/ );   // no stray brackets in furigana text
        expect(mask).toHaveLength(Math.ceil((plain.length + 1) / 4));
        expect(isBoundary(mask, 0)).toBe(true);
        expect(isBoundary(mask, plain.length)).toBe(true);
      }
    });
  }
  it('manufacture sentences are question sentences, never the answer choices', () => {
    for (const [markup] of file('manufacture').sentences) expect(markup).not.toMatch(/^\d+[.．]/);
  });
  it('every real match is the exact word on word boundaries', () => {
    const sets: ExampleSet[] = ['manufacture', 'agriculture'].map(sector => {
      const data = file(sector);
      return { sector, items: data.sentences.map(([markup, s, page, mask]) => ({ markup, plain: stripFurigana(markup), mask, source: data.sources[s], page })) };
    });
    let words = 0;
    for (const word of ['整理', '清掃', '電圧', '栽培', '収穫', '工具', '品質']) {
      for (const match of findExamples(sets, word, 50)) {
        words++;
        expect(stripFurigana(match.markup).slice(match.start, match.end)).toBe(word);
      }
    }
    expect(words).toBeGreaterThan(10);
  });
});

describe('rendering pieces', () => {
  it('keeps furigana and highlights the matched word', () => {
    const markup = '直(じか)まき栽培(さいばい)では、間引(まび)きをします。';
    const plain = stripFurigana(markup);
    expect(plain).toBe('直まき栽培では、間引きをします。');
    const pieces = sentencePieces(markup, plain.indexOf('栽培'), plain.indexOf('栽培') + 2);
    expect(pieces.filter(p => p.hit).map(p => p.text).join('')).toBe('栽培');
    expect(pieces.find(p => p.text === '栽培')?.ruby).toBe('さいばい');
    expect(pieces.map(p => p.text).join('')).toBe(plain);
  });
  it('highlights a word inside plain text without splitting other characters', () => {
    const pieces = sentencePieces('ノギスで外径を測る。', 4, 6);
    expect(pieces.map(p => p.text)).toEqual(['ノギスで', '外径', 'を測る。']);
    expect(pieces.filter(p => p.hit).map(p => p.text)).toEqual(['外径']);
  });
});

describe('loading (one static file, never the API)', () => {
  beforeEach(() => resetExampleCache());
  const json = (body: unknown, type = 'application/json') => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': type } });
  it('requests only /examples/<sector>.json and caches it', async () => {
    const fetcher = vi.fn(async () => json(file('manufacture'))) as unknown as typeof fetch;
    const a = await loadExampleSet('manufacture', fetcher);
    const b = await loadExampleSet('manufacture', fetcher);
    expect(a?.items.length).toBeGreaterThan(500);
    expect(b).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as any).mock.calls[0][0]).toBe('/examples/manufacture.json');
  });
  it('treats a missing file / SPA fallback / bad JSON as "no examples" without retrying', async () => {
    const html = vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await loadExampleSet('agriculture', html)).toBeNull();
    resetExampleCache();
    const notFound = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await loadExampleSet('agriculture', notFound)).toBeNull();
    resetExampleCache();
    const bad = vi.fn(async () => json({ nope: true })) as unknown as typeof fetch;
    expect(await loadExampleSet('agriculture', bad)).toBeNull();
    resetExampleCache();
    const boom = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await loadExampleSet('agriculture', boom)).toBeNull();
    expect(await loadExampleSet('agriculture', boom)).toBeNull();
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
