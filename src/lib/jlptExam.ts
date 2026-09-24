import examCsv from '@assets/data/jlpt-quiz-bank.csv?raw';

const jlptAudioAssets = import.meta.glob('/attached_assets/jlpt-listening/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function jlptAudioUrl(id: string): string | null {
  const entry = Object.entries(jlptAudioAssets).find(([path]) => path.endsWith(`/${id}.mp3`));
  return entry?.[1] ?? null;
}

export type JlptLevel = 'N4' | 'N3' | 'N2' | 'N1';
export type JlptSection = 'vocabulary' | 'grammar' | 'reading' | 'listening';

export type JlptQuestion = {
  id: string;
  level: JlptLevel;
  section: JlptSection;
  questionType: string;
  question: string;
  options: [string, string, string, string];
  answer: 'A' | 'B' | 'C' | 'D';
  explanation: string;
};

export type JlptChoice = { label: 'A' | 'B' | 'C' | 'D'; text: string };

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  return rows;
}

function isLevel(value: string): value is JlptLevel {
  return value === 'N4' || value === 'N3' || value === 'N2' || value === 'N1';
}

function isSection(value: string): value is JlptSection {
  return value === 'vocabulary' || value === 'grammar' || value === 'reading' || value === 'listening';
}

function isAnswer(value: string): value is JlptQuestion['answer'] {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D';
}

function buildQuestions(csv: string): JlptQuestion[] {
  const rows = parseCsv(csv.replace(/^\ufeff/, ''));
  const header = rows.shift()?.map((cell) => cell.trim()) ?? [];
  const indexOf = (name: string) => header.indexOf(name);
  const valueAt = (row: string[], name: string) => row[indexOf(name)]?.trim() ?? '';

  return rows.flatMap((row) => {
    const level = valueAt(row, 'level');
    const section = valueAt(row, 'section');
    const answer = valueAt(row, 'answer');
    if (!isLevel(level) || !isSection(section) || !isAnswer(answer)) return [];
    const options = [
      valueAt(row, 'option_a'), valueAt(row, 'option_b'),
      valueAt(row, 'option_c'), valueAt(row, 'option_d'),
    ];
    if (options.some((option) => option === '') || valueAt(row, 'question') === '') return [];
    return [{
      id: valueAt(row, 'id'),
      level,
      section,
      questionType: valueAt(row, 'question_type'),
      question: valueAt(row, 'question'),
      options: options as JlptQuestion['options'],
      answer,
      explanation: valueAt(row, 'explanation'),
    }];
  });
}

export const jlptQuestions: JlptQuestion[] = buildQuestions(examCsv);
export const jlptChoices: JlptChoice['label'][] = ['A', 'B', 'C', 'D'];

export const jlptCounts = {
  total: jlptQuestions.length,
  levels: {
    N4: jlptQuestions.filter((question) => question.level === 'N4').length,
    N3: jlptQuestions.filter((question) => question.level === 'N3').length,
    N2: jlptQuestions.filter((question) => question.level === 'N2').length,
    N1: jlptQuestions.filter((question) => question.level === 'N1').length,
  },
  sections: {
    vocabulary: jlptQuestions.filter((question) => question.section === 'vocabulary').length,
    grammar: jlptQuestions.filter((question) => question.section === 'grammar').length,
    reading: jlptQuestions.filter((question) => question.section === 'reading').length,
    listening: jlptQuestions.filter((question) => question.section === 'listening').length,
  },
};

export function shuffleJlpt<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [next[index], next[swap]] = [next[swap], next[index]];
  }
  return next;
}

export function formatJlptSection(section: JlptSection | 'all'): string {
  if (section === 'all') return 'all sections';
  return section.charAt(0).toUpperCase() + section.slice(1);
}
