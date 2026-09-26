import bank from './rankedBank.json';
import { progressKey, shuffle, type ChoiceOption, type PriorityCard, type PrivateQuestion, type QuizType } from '../shared/ranked';
import type { Level, Word } from '../shared/vocabulary';
export const rankedWords = (bank as Word[]).filter(w => w.expression.trim() && w.reading.trim() && w.meaning.trim() && w.meaning !== 'meaning not listed');
export const tierWords = (tier: Level) => rankedWords.filter(w => w.level === tier);
const label = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
// Distractors must look distinct in whatever field the quiz type displays:
// meanings for `meaning`, kanji+reading pairs for `word`, bare readings for
// `reading` (several different kanji can share a reading, e.g. 公立/効率 = こうりつ).
const labelFor = (word: Word, quizType: QuizType) =>
  label(quizType === 'reading' ? word.reading : quizType === 'word' ? `${word.expression}\u0000${word.reading}` : word.meaning);
const choiceContent = (word: Word, quizType: QuizType): Omit<ChoiceOption, 'id'> =>
  quizType === 'reading' ? { reading: word.reading } : quizType === 'word' ? { expression: word.expression, reading: word.reading } : { meaning: word.meaning };
export function makeQuestions(tier: Level, count: number, mastered: string[] = [], priority: PriorityCard[] = [], quizType: QuizType = 'meaning'): PrivateQuestion[] {
  const pool = tierWords(tier);
  const known = new Set(mastered);
  const indexed = new Map(rankedWords.map(w => [w.level + ':' + progressKey(w), w]));
  const priorityWords = priority.map(card => ({ card, word: indexed.get(card.tier + ':' + card.key) })).filter(item => !!item.word);
  const reserved = new Set(priorityWords.map(item => progressKey(item.word!)));
  const words = [...priorityWords.map(item => item.word!), ...[...shuffle(pool.filter(w => !known.has(progressKey(w)))), ...shuffle(pool.filter(w => known.has(progressKey(w))))].filter(w => !reserved.has(progressKey(w)))].slice(0, count);
  const candidates = shuffle(pool).map(word => ({ word, label: labelFor(word, quizType) }));
  return words.map(word => {
    const labels = new Set([labelFor(word, quizType)]);
    const distractors: Word[] = [];
    const start = Math.floor(Math.random() * candidates.length);
    for (let i = 0; i < candidates.length && distractors.length < 3; i++) {
      const candidate = candidates[(start + i) % candidates.length];
      if (candidate.word.expression === word.expression || labels.has(candidate.label)) continue;
      labels.add(candidate.label); distractors.push(candidate.word);
    }
    if (distractors.length !== 3) throw new Error('Not enough distinct choices in this tier.');
    // Opaque question-local IDs avoid exposing which choice matches the vocabulary ID.
    const choices = shuffle([word, ...distractors]).map((item, i) => ({ id: String(i), ...choiceContent(item, quizType), correct: item === word }));
    return { tier: word.level, cursedFor: priorityWords.find(item => item.word === word)?.card.owners, id: crypto.randomUUID(), expression: word.expression, reading: word.reading, meaning: word.meaning, key: progressKey(word),
      answerId: choices.find(c => c.correct)!.id, choices: choices.map(({ correct, ...rest }) => rest) };
  });
}
