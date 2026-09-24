import { describe, expect, it } from 'vitest';
import { emptyMastered, surrenderWindow, type RankedAccount, type Answer } from '../shared/ranked';
import { makeQuestions } from '../worker/rankedQuestions';
import { applyHigherRankLoss, cursedPriorities, curseDelta, repairCard } from '../worker/rankedPolicy';
const account = (): RankedAccount => ({ points: 100, tier: 'N4', mastered: emptyMastered(), cursed: emptyMastered(), version: 0, activeMatch: null });
describe('ranked AFK and cursed-card policy', () => {
  it('unlocks only Q1, Q10, Q20 and does not accumulate skipped opportunities', () => {
    expect(surrenderWindow(1, 0).available).toBe(true);
    expect(surrenderWindow(9, 1)).toEqual({ available: false, slot: 0, nextQuestion: 10 });
    expect(surrenderWindow(10, 1).available).toBe(true);
    expect(surrenderWindow(19, 2).available).toBe(false);
    expect(surrenderWindow(20, 2).available).toBe(true);
    expect(surrenderWindow(21, 0).slot).toBe(2);
    expect(surrenderWindow(200, 3)).toEqual({ available: false, slot: 2, nextQuestion: null });
  });
  it.each(['correct', 'incorrect', 'timeout'] as const)('gives the curse owner zero delta on %s', result => {
    const [q] = makeQuestions('N5', 1); q.cursedFor = ['owner'];
    const answer: Answer = { result, delta: result === 'correct' ? 4 : result === 'incorrect' ? -2 : -1, selectedAnswerId: null };
    expect(curseDelta(q, 'owner', answer)).toBe(0);
    expect(curseDelta(q, 'opponent', answer)).toBe(result === 'correct' ? 2 : answer.delta);
  });
  it('deduplicates shared curses, prioritizes across tiers and marks only the actual owners', () => {
    const a = account(), b = account(), [n5] = makeQuestions('N5', 1), [n3] = makeQuestions('N3', 1);
    a.cursed!.N5 = [n5.key]; a.cursed!.N3 = [n3.key]; b.cursed!.N5 = [n5.key];
    const priority = cursedPriorities({ a, b }); expect(priority).toHaveLength(2);
    const questions = makeQuestions('N5', 5, [], priority);
    expect(questions[0].key).toBe(n5.key); expect(questions[0].cursedFor).toEqual(['a', 'b']);
    expect(questions[1].key).toBe(n3.key); expect(questions[1].tier).toBe('N3'); expect(questions[1].cursedFor).toEqual(['a']);
    expect(new Set(questions.map(q => q.key)).size).toBe(5);
  });
  it('removes at most the wager from owned misses, not unseen/correct/unplayed cards, but curses every miss', () => {
    const a = account(), [one, two, unseen, correct, unplayed] = makeQuestions('N5', 5);
    a.mastered.N5 = [one.key, two.key, correct.key, unplayed.key];
    const before = structuredClone(a), misses = [one, one, unseen, two].map(q => ({ tier: 'N5' as const, key: q.key }));
    applyHigherRankLoss(a, before, misses, 1);
    expect(a.mastered.N5).toEqual([two.key, correct.key, unplayed.key]);
    expect(a.cursed!.N5).toEqual([one.key, unseen.key, two.key]);
    expect(a.points).toBe(100);
  });
  it('can lose fewer cards than the wager and repairs unseen/lost mastery with no points', () => {
    const a = account(), [q] = makeQuestions('N5', 1);
    applyHigherRankLoss(a, structuredClone(a), [{ tier: 'N5', key: q.key }], 5);
    expect(a.mastered.N5).toEqual([]); expect(a.cursed!.N5).toEqual([q.key]);
    repairCard(a, { tier: 'N5', key: q.key }); repairCard(a, { tier: 'N5', key: q.key });
    expect(a.cursed!.N5).toEqual([]); expect(a.mastered.N5).toEqual([q.key]); expect(a.points).toBe(100);
  });
});
