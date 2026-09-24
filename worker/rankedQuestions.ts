import bank from './rankedBank.json';
import { progressKey, shuffle, type PriorityCard, type PrivateQuestion } from '../shared/ranked';
import type { Level, Word } from '../shared/vocabulary';
export const rankedWords = (bank as Word[]).filter(w => w.expression.trim() && w.reading.trim() && w.meaning.trim() && w.meaning !== 'meaning not listed');
export const tierWords = (tier: Level) => rankedWords.filter(w => w.level === tier);
const label = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function makeQuestions(tier: Level, count: number, mastered: string[] = [], priority: PriorityCard[] = []): PrivateQuestion[] {
  const pool = tierWords(tier);
  const known = new Set(mastered);
  const indexed = new Map(rankedWords.map(w => [w.level + ':' + progressKey(w), w]));
  const priorityWords = priority.map(card => ({ card, word: indexed.get(card.tier + ':' + card.key) })).filter(item => !!item.word);
  const reserved = new Set(priorityWords.map(item => progressKey(item.word!)));
  const words = [...priorityWords.map(item => item.word!), ...[...shuffle(pool.filter(w => !known.has(progressKey(w)))), ...shuffle(pool.filter(w => known.has(progressKey(w))))].filter(w => !reserved.has(progressKey(w)))].slice(0, count);
  const candidates = shuffle(pool).map(word => ({ word, label: label(word.meaning) }));
  return words.map(word => {
    const labels = new Set([label(word.meaning)]);
    const distractors: Word[] = [];
    const start = Math.floor(Math.random() * candidates.length);
    for (let i = 0; i < candidates.length && distractors.length < 3; i++) {
      const candidate = candidates[(start + i) % candidates.length];
      if (candidate.word.expression === word.expression || labels.has(candidate.label)) continue;
      labels.add(candidate.label); distractors.push(candidate.word);
    }
    if (distractors.length !== 3) throw new Error('Not enough distinct choices in this tier.');
    // Opaque question-local IDs avoid exposing which choice matches the vocabulary ID.
    const choices = shuffle([word, ...distractors]).map((item, i) => ({ id: String(i), meaning: item.meaning, correct: item === word }));
    return { tier: word.level, cursedFor: priorityWords.find(item => item.word === word)?.card.owners, id: crypto.randomUUID(), expression: word.expression, reading: word.reading, key: progressKey(word),
      answerId: choices.find(c => c.correct)!.id, choices: choices.map(({ id, meaning }) => ({ id, meaning })) };
  });
}
