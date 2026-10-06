/**
 * Example sentences for SSW decks.
 *
 * Data comes from static files built from the SSW PDFs (scripts/build-example-sentences.py):
 *   /examples/<sector>.json   - served by Cloudflare's static-asset layer.
 * This feature NEVER calls the API/D1. It issues at most one plain GET per sector per page load,
 * and only when a quiz is running on an admin-published deck whose name starts with "SSW".
 *
 * Matching is deliberately strict (a missing example is better than a wrong one):
 *  - the card's word must appear EXACTLY as written (no verb/adjective stem guessing);
 *  - the match must start and end on a word boundary found by the tokenizer at build time,
 *    so "気温" is not found inside "空気温度" (空気 + 温度);
 *  - words too short/ambiguous to match safely are skipped.
 */

export type ExampleFile = {
  version: 1;
  sector: string;
  sources: string[];
  /** [text with 漢字(よみ) furigana, source index, page, hex word-boundary mask] */
  sentences: [string, number, number, string][];
};

export type ExampleSet = {
  sector: string;
  items: { markup: string; plain: string; mask: string; source: string; page: number }[];
};

export type ExampleMatch = {
  markup: string;
  /** Character range of the matched word inside the sentence WITHOUT furigana. */
  start: number;
  end: number;
  source: string;
  page: number;
  sector: string;
};

/** Deck name -> sector files. Only decks named "SSW…" qualify; unknown sectors get nothing. */
const SECTORS: { key: string; pattern: RegExp }[] = [
  { key: 'manufacture', pattern: /manufactur/i },
  { key: 'agriculture', pattern: /agricultur|farming/i },
];

export function sectorsForDeck(deckName: string | null | undefined): string[] {
  const name = (deckName ?? '').normalize('NFKC').trim();
  if (!/^ssw(?![a-z])/i.test(name)) return [];
  return SECTORS.filter(sector => sector.pattern.test(name)).map(sector => sector.key);
}

const KANA_RANGE = '\\u3040-\\u30ff';
const FURIGANA = /\(([ぁ-ゖァ-ヺーｰ]{1,40})\)/g;
const WORD_CHARS = new RegExp(`^[\\u3005\\u3006\\u30f6\\u4e00-\\u9fff${KANA_RANGE}A-Za-z0-9]+$`);

export const stripFurigana = (markup: string) => markup.replace(FURIGANA, '');

/** The exact text to look for, or null when this word cannot be matched safely. */
export function eligibleExpression(expression: string | null | undefined): string | null {
  const text = (expression ?? '').normalize('NFKC').trim();
  if (text.length < 2 || !WORD_CHARS.test(text)) return null;
  if (/^[0-9A-Za-z]+$/.test(text)) return null;                    // numbers / latin codes are too ambiguous
  if (/^[\u3040-\u309f]+$/.test(text) && text.length < 3) return null; // very short hiragana words
  return text;
}

export function isBoundary(mask: string, position: number): boolean {
  const digit = parseInt(mask[position >> 2] ?? '0', 16);
  return ((digit >> (3 - (position & 3))) & 1) === 1;
}

function toSet(file: unknown): ExampleSet | null {
  const data = file as Partial<ExampleFile> | null;
  if (!data || data.version !== 1 || typeof data.sector !== 'string' || !Array.isArray(data.sources) || !Array.isArray(data.sentences)) return null;
  const items: ExampleSet['items'] = [];
  for (const row of data.sentences) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[3] !== 'string') continue;
    items.push({ markup: row[0], plain: stripFurigana(row[0]), mask: row[3], source: String(data.sources[row[1]] ?? ''), page: Number(row[2]) || 0 });
  }
  return { sector: data.sector, items };
}

const cache = new Map<string, Promise<ExampleSet | null>>();

/** One static GET per sector per page load. A failure just means "no examples"; it never retries in a loop. */
export function loadExampleSet(sector: string, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<ExampleSet | null> {
  let pending = cache.get(sector);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetcher(`/examples/${sector}.json`, { credentials: 'omit' });
        if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? 'json')) return null; // SPA fallback returns HTML
        return toSet(await response.json());
      } catch {
        return null;
      }
    })();
    cache.set(sector, pending);
  }
  return pending;
}

export function resetExampleCache() { cache.clear(); }

/** Sentences containing `expression` exactly, on word boundaries. Natural-length sentences (~30 characters) first. */
export function findExamples(sets: readonly ExampleSet[], expression: string | null | undefined, limit = 5): ExampleMatch[] {
  const needle = eligibleExpression(expression);
  if (!needle) return [];
  const found: ExampleMatch[] = [];
  for (const set of sets) {
    for (const item of set.items) {
      let from = item.plain.indexOf(needle);
      while (from !== -1) {
        const end = from + needle.length;
        if (isBoundary(item.mask, from) && isBoundary(item.mask, end)) {
          found.push({ markup: item.markup, start: from, end, source: item.source, page: item.page, sector: set.sector });
          break;
        }
        from = item.plain.indexOf(needle, from + 1);
      }
    }
  }
  const distance = (match: ExampleMatch) => Math.abs(stripFurigana(match.markup).length - 30);
  return found.sort((a, b) => distance(a) - distance(b)).slice(0, limit);
}

/** Pieces for rendering: ruby runs keep their reading; `hit` marks the matched word. */
export type SentencePiece = { text: string; ruby?: string; hit: boolean };

export function sentencePieces(markup: string, start: number, end: number): SentencePiece[] {
  const parts: { text: string; ruby?: string }[] = [];
  const re = /([\u3005\u3006\u30f6\u4e00-\u9fff]+)\(([ぁ-ゖァ-ヺーｰ]{1,40})\)/g;
  let last = 0;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    if (m.index > last) parts.push({ text: markup.slice(last, m.index) });
    parts.push({ text: m[1], ruby: m[2] });
    last = m.index + m[0].length;
  }
  if (last < markup.length) parts.push({ text: markup.slice(last) });

  const pieces: SentencePiece[] = [];
  let offset = 0;
  for (const part of parts) {
    const from = offset, to = offset + part.text.length;
    offset = to;
    if (part.ruby) { pieces.push({ ...part, hit: from < end && to > start }); continue; }   // a reading cannot be split
    const cuts = [from, Math.min(Math.max(start, from), to), Math.min(Math.max(end, from), to), to];
    for (let i = 0; i < 3; i++) {
      if (cuts[i + 1] > cuts[i]) pieces.push({ text: part.text.slice(cuts[i] - from, cuts[i + 1] - from), hit: i === 1 });
    }
  }
  return pieces;
}
