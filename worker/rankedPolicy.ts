import { emptyMastered, TIERS, type RankedAccount, type PrivateQuestion, type Answer, type CardRef, type PriorityCard } from '../shared/ranked';
import { tierWords } from './rankedQuestions';

export function higherRank(a: RankedAccount, b: RankedAccount) { return TIERS.indexOf(a.tier) > TIERS.indexOf(b.tier); }
export function cursedPriorities(accounts: Record<string, RankedAccount>): PriorityCard[] {
  const cards = new Map<string, PriorityCard>();
  for (const [uid, account] of Object.entries(accounts)) for (const tier of TIERS) for (const key of account.cursed?.[tier] ?? []) {
    const id = tier + ':' + key;
    const card = cards.get(id) ?? { tier, key, owners: [] };
    if (!card.owners.includes(uid)) card.owners.push(uid);
    cards.set(id, card);
  }
  return [...cards.values()];
}
export function repairCard(account: RankedAccount, card: CardRef) {
  account.cursed ??= emptyMastered();
  account.cursed[card.tier] = account.cursed[card.tier].filter(key => key !== card.key);
  if (!account.mastered[card.tier].includes(card.key)) account.mastered[card.tier].push(card.key);
  if (account.tier === card.tier && card.tier !== 'N1' && account.mastered[card.tier].length >= tierWords(card.tier).length) {
    account.tier = TIERS[TIERS.indexOf(card.tier) + 1];
  }
}
export function curseDelta(q: PrivateQuestion, uid: string, answer: Answer): number {
  if (q.cursedFor?.includes(uid)) return 0;
  if (q.cursedFor?.length && answer.result === 'correct') return 2;
  return answer.delta;
}
// The exception removes only previously owned missed cards; never grants those cards to the winner.
// All missed cards, including unseen ones, become the higher-ranked loser's repair queue.
export function applyHigherRankLoss(account: RankedAccount, before: RankedAccount, missed: CardRef[], cardLimit: number) {
  account.cursed ??= emptyMastered();
  const seen = new Set<string>(); let removed = 0;
  for (const card of missed) {
    const id = card.tier + ':' + card.key; if (seen.has(id)) continue; seen.add(id);
    if (!account.cursed[card.tier].includes(card.key)) account.cursed[card.tier].push(card.key);
    if (removed < cardLimit && before.mastered[card.tier].includes(card.key)) {
      account.mastered[card.tier] = account.mastered[card.tier].filter(key => key !== card.key); removed++;
    }
  }
}
