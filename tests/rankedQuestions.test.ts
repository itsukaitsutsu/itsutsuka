import { describe, it, expect } from 'vitest';
import { vocabulary } from '@/lib/vocabulary';
import { wordProgressKey } from '@/lib/cardProgress';
import { makeQuestions, rankedWords, tierWords } from '../worker/rankedQuestions';
import { TIERS, emptyMastered, progressKey, winner } from '../shared/ranked';
import { applySoloAnswer, sanitizeLegacy, transferable } from '../worker/rankedAccounts';
const account = () => ({ points: 10, tier: 'N5' as const, mastered: emptyMastered(), version: 0, activeMatch: null });
describe('ranked questions and rules', () => {
  it('uses exactly the browser vocabulary and progress identities in every tier', () => {
    expect(rankedWords).toEqual(vocabulary);
    rankedWords.forEach(w => expect(progressKey(w)).toBe(wordProgressKey(w)));
  });
  it.each(TIERS)('%s has four unique choices, one valid answer and no ID answer leak', tier => {
    const pool = tierWords(tier);
    const questions = makeQuestions(tier, pool.length);
    expect(new Set(questions.map(q => q.key)).size).toBe(pool.length);
    for (const q of questions) {
      expect(q.choices).toHaveLength(4);
      expect(new Set(q.choices.map(c => c.meaning.normalize('NFKC').trim().toLowerCase())).size).toBe(4);
      const word = pool.find(w => progressKey(w) === q.key)!;
      expect(q.choices.find(c => c.id === q.answerId)?.meaning).toBe(word.meaning);
      expect(q.id).not.toBe(word.id);
      expect(q.choices.some(c => c.id === q.id)).toBe(false);
    }
  });
  it('uses the four-mistake loser rule, score for simultaneous elimination, and ties', () => {
    expect(winner({ a: { score: 5, mistakes: 4 }, b: { score: 0, mistakes: 3 } })).toBe('b');
    expect(winner({ a: { score: -6, mistakes: 4 }, b: { score: -7, mistakes: 4 } })).toBe('a');
    expect(winner({ a: { score: 2, mistakes: 0 }, b: { score: 2, mistakes: 0 } })).toBeNull();
  });
  it('keeps solo mastery rewards distinct from battle scores and removes two masteries on wrong answers', () => {
    const a = account(), [q, other] = makeQuestions('N5', 2);
    const correct = { result: 'correct' as const, delta: 4, selectedAnswerId: q.answerId };
    // First mastery of a card: +4. Repeating an already-mastered card: +0.
    applySoloAnswer(a, 'N5', q, correct); applySoloAnswer(a, 'N5', q, correct);
    expect(a.points).toBe(14); expect(a.mastered.N5).toEqual([q.key]);
    a.mastered.N5.push(other.key);
    applySoloAnswer(a, 'N5', q, { result: 'incorrect', delta: -2, selectedAnswerId: 'wrong' });
    expect(a.points).toBe(12); expect(a.mastered.N5).toEqual([]);
    applySoloAnswer(a, 'N5', q, { result: 'timeout', delta: -1, selectedAnswerId: null });
    expect(a.points).toBe(11);
  });
  it('only transfers unique cards, and sanitizes one-time legacy data', () => {
    const [q, other] = makeQuestions('N5', 2), a = account(), b = account();
    a.mastered.N5 = [q.key, other.key]; b.mastered.N5 = [q.key];
    expect(transferable(a, b, 'N5')).toEqual([other.key]);
    const imported = sanitizeLegacy({ points: 999999, tier: 'N1', mastered: { ...emptyMastered(), N5: [q.key, q.key, 'fake'] } });
    expect(imported).toEqual({ points: 1, tier: 'N5', mastered: { ...emptyMastered(), N5: [q.key] } });
  });
});
