import { emptyMastered, progressKey, TIERS, type RankedAccount, type PlayerResult, type Answer, type PrivateQuestion } from '../shared/ranked';
import type { Level } from '../shared/vocabulary';
import { tierWords } from './rankedQuestions';
export async function getAccount(db: D1Database, uid: string): Promise<RankedAccount> {
  const row = await db.prepare('SELECT * FROM ranked_accounts WHERE uid = ?').bind(uid).first<{ points: number; tier: Level; mastered: string; version: number; active_match: string | null; cursed?: string }>();
  if (!row) throw new Error('Open Ranked setup to initialize your account first.');
  return { points: row.points, tier: row.tier, mastered: JSON.parse(row.mastered), version: row.version, activeMatch: row.active_match, cursed: row.cursed ? JSON.parse(row.cursed) : emptyMastered() };
}
export function sanitizeLegacy(raw: Partial<RankedAccount>): Pick<RankedAccount, 'points' | 'tier' | 'mastered'> {
  const mastered = emptyMastered();
  for (const tier of TIERS) {
    const allowed = new Set(tierWords(tier).map(progressKey));
    const supplied = raw.mastered?.[tier];
    mastered[tier] = Array.isArray(supplied) ? [...new Set(supplied.filter(key => allowed.has(key)))] : [];
  }
  const total = Object.values(mastered).flat().length;
  // Legacy browser data was never authoritative. Import only once, cap positive points to verified card IDs.
  const points = Number.isSafeInteger(raw.points) ? Math.max(-100000, Math.min(raw.points!, total)) : 0;
  let tier: Level = 'N5';
  while (tier !== 'N1' && mastered[tier].length >= tierWords(tier).length) tier = TIERS[TIERS.indexOf(tier) + 1];
  return { points, tier, mastered };
}
export function applySoloAnswer(account: RankedAccount, tier: Level, question: PrivateQuestion, answer: Answer) {
  const known = new Set(account.mastered[tier]);
  if (answer.result === 'correct') { if (!known.has(question.key)) account.points += 4; known.add(question.key); }
  else if (answer.result === 'incorrect') {
    account.points -= 2; known.delete(question.key);
    const keys = [...known]; if (keys.length) known.delete(keys[Math.floor(Math.random() * keys.length)]);
  } else account.points--;
  account.mastered[tier] = [...known];
  if (account.tier === tier && tier !== 'N1' && known.size >= tierWords(tier).length) account.tier = TIERS[TIERS.indexOf(tier) + 1];
}
export function transferable(from: RankedAccount, to: RankedAccount, tier: Level): string[] {
  const existing = new Set(to.mastered[tier]);
  return from.mastered[tier].filter(key => !existing.has(key));
}
export function resultOf(before: RankedAccount, after: RankedAccount): PlayerResult {
  const a = Object.values(before.mastered).flat(), b = Object.values(after.mastered).flat();
  const aa = new Set(a), bb = new Set(b);
  return { pointsBefore: before.points, pointsAfter: after.points, cardsBefore: a.length, cardsAfter: b.length,
    gainedCards: b.filter(k => !aa.has(k)), lostCards: a.filter(k => !bb.has(k)), tier: after.tier,
    cursesBefore: Object.values(before.cursed ?? {}).flat().length, cursesAfter: Object.values(after.cursed ?? {}).flat().length };
}
