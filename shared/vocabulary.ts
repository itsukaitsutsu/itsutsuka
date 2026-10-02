export type Level = 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
// Custom is a personal drawer label, never a JLPT/ranked tier.
export type WordLevel = Level | 'Custom';
export const WORD_LEVELS: WordLevel[] = ['N5', 'N4', 'N3', 'N2', 'N1', 'Custom'];

/** Normalized English categories used by the part-of-speech deck filter. */
export const PART_OF_SPEECH_OPTIONS = [
  { key: 'Noun', label: 'Noun', japanese: '名詞 / 代名詞' },
  { key: 'Verb', label: 'Verb', japanese: '動詞' },
  { key: 'Adjective', label: 'Adjective', japanese: '形容詞 / 形状詞' },
  { key: 'Adverb', label: 'Adverb', japanese: '副詞' },
  { key: 'Particle', label: 'Particle', japanese: '助詞' },
  { key: 'Other', label: 'Other', japanese: 'その他 / 未分類' },
] as const;
export type PartOfSpeechKey = typeof PART_OF_SPEECH_OPTIONS[number]['key'];
export type PartOfSpeechFilter = 'all' | PartOfSpeechKey;

export type Word<L extends WordLevel = WordLevel> = {
  id: string;
  expression: string;
  reading: string;
  meaning: string;
  level: L;
  tags: string[];
  /** Original `part_of_speech_en` CSV value, e.g. Noun, Particle, or Other. */
  partOfSpeechEn?: string;
  /** Original `part_of_speech_jp` CSV value, e.g. 名詞, 助詞, or 接続詞. */
  partOfSpeechJp?: string;
};

const PART_OF_SPEECH_KEYS = new Set<string>(PART_OF_SPEECH_OPTIONS.map((option) => option.key));
const JAPANESE_PART_OF_SPEECH: Record<string, PartOfSpeechKey> = {
  名詞: 'Noun', 代名詞: 'Noun',
  動詞: 'Verb',
  形容詞: 'Adjective', 形状詞: 'Adjective',
  副詞: 'Adverb',
  助詞: 'Particle',
};

/** Map the supplied bilingual POS fields to one of the stable filter categories. */
export function partOfSpeechCategory(partOfSpeechEn?: string, partOfSpeechJp?: string): PartOfSpeechKey {
  const english = partOfSpeechEn?.trim();
  if (english && PART_OF_SPEECH_KEYS.has(english)) return english as PartOfSpeechKey;
  const japanese = partOfSpeechJp?.trim();
  return (japanese && JAPANESE_PART_OF_SPEECH[japanese]) || 'Other';
}

export function parsePartOfSpeechFilter(value: string | null | undefined): PartOfSpeechFilter {
  if (value === 'all') return 'all';
  return value && PART_OF_SPEECH_KEYS.has(value) ? value as PartOfSpeechKey : 'all';
}

export function filterByPartOfSpeech<T extends Pick<Word, 'partOfSpeechEn' | 'partOfSpeechJp'>>(
  words: T[],
  filter: PartOfSpeechFilter,
): T[] {
  return filter === 'all' ? words : words.filter((word) => partOfSpeechCategory(word.partOfSpeechEn, word.partOfSpeechJp) === filter);
}

function parseLine(line: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

export function parseCsv(csv: string, source: string, level: Level): Word<Level>[] {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = parseLine(lines.shift() ?? '').map(normalizeHeader);
  const indexOf = (names: string[], fallback: number) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index < 0 ? fallback : index;
  };
  const expressionIndex = indexOf(['expression', 'kanji'], 0);
  const readingIndex = indexOf(['reading', 'furigana'], 1);
  const japanesePosIndex = indexOf(['part_of_speech_jp', 'part_of_speech_ja', 'part_of_speech_japanese'], -1);
  const englishPosIndex = indexOf(['part_of_speech_en', 'part_of_speech_english', 'part_of_speech'], -1);
  const meaningIndex = indexOf(['meaning'], 2);
  const tagsIndex = indexOf(['tags'], 3);

  // Preserve the old stable numeric IDs for every row that has a reading.
  // A couple of source rows omit furigana, but their expression/meaning/POS are
  // still useful in cards and meaning/Japanese drills, so give those unique IDs.
  let readableRowIndex = 0;
  return lines.flatMap((line, lineIndex) => {
    const cells = parseLine(line);
    if (!cells[expressionIndex]) return [];
    const reading = cells[readingIndex] ?? '';
    const stableIndex = reading ? readableRowIndex++ : `no-reading-${lineIndex}`;
    return [{
      id: `${source}-${stableIndex}-${cells[expressionIndex]}`,
      expression: cells[expressionIndex],
      reading,
      meaning: cells[meaningIndex] || 'meaning not listed',
      level,
      tags: cells[tagsIndex]?.split(/\s+/).filter(Boolean) ?? [],
      ...(japanesePosIndex >= 0 && cells[japanesePosIndex] ? { partOfSpeechJp: cells[japanesePosIndex] } : {}),
      ...(englishPosIndex >= 0 && cells[englishPosIndex] ? { partOfSpeechEn: cells[englishPosIndex] } : {}),
    }];
  });
}
