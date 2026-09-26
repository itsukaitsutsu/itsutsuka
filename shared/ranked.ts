import type { Level } from './vocabulary';
export const TIERS: Level[] = ['N5', 'N4', 'N3', 'N2', 'N1'];
export const RANKED_RULES_VERSION = 3;
export const SURRENDER_QUESTIONS = [1, 10, 20] as const;
export const SURRENDER_RESPONSE_MS = 30000;
export function surrenderWindow(questionNumber: number, used = 0) {
  const slot = SURRENDER_QUESTIONS.reduce((found, question, index) => questionNumber >= question ? index : found, -1);
  return { available: slot >= used, slot, nextQuestion: used < SURRENDER_QUESTIONS.length ? SURRENDER_QUESTIONS[used] : null };
}
export const RULES = { questionMs: 10000, reviewMs: 3000, mistakeLimit: 4 } as const;
/** Application WebSocket close codes. 4001 = replaced by another tab, 4403 = permanent refusal, 4409 = server error, retry with backoff. */
export const WS_CLOSE = { replaced: 4001, permanent: 4403, retryable: 4409 } as const;
export const REVIEW_TIME = { minMs: 0, maxMs: 10000, stepMs: 500 } as const;
export function isValidReviewMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= REVIEW_TIME.minMs && value <= REVIEW_TIME.maxMs && value % REVIEW_TIME.stepMs === 0;
}
export function reviewTimeLabel(ms: number): string { return ms === 0 ? 'Off (0 seconds)' : `${ms / 1000} ${ms === 1000 ? 'second' : 'seconds'}`; }
export type RankedAccount = { points: number; tier: Level; mastered: Record<Level, string[]>; version: number; activeMatch: string | null; cursed?: Record<Level, string[]> };
export const emptyMastered = (): Record<Level, string[]> => ({ N5: [], N4: [], N3: [], N2: [], N1: [] });
export const progressKey = (word: { expression: string; reading: string }) => `word:${JSON.stringify([word.expression.normalize('NFKC').trim(), word.reading.normalize('NFKC').trim()])}`;
export type CardRef = { tier: Level; key: string };
export type PriorityCard = CardRef & { owners: string[] };
// meaning: prompt shows expression+reading, choices are meanings (original ranked quiz).
// word: prompt shows the meaning, choices are expression+reading pairs ("choose Japanese").
// reading: prompt shows the expression only, choices are readings (choose 読み方).
export type QuizType = 'meaning' | 'word' | 'reading';
export const QUIZ_TYPES: QuizType[] = ['meaning', 'word', 'reading'];
export function isQuizType(value: unknown): value is QuizType { return value === 'meaning' || value === 'word' || value === 'reading'; }
export const QUIZ_TYPE_LABELS: Record<QuizType, string> = { meaning: 'Choose meaning', word: 'Choose Japanese', reading: 'Choose reading (読み方)' };
export type ChoiceOption = { id: string; meaning?: string; expression?: string; reading?: string };
// The public, in-flight shape sent to clients: only the fields a given quizType
// is allowed to reveal before the answer is locked in. See matchRoom.publicRoom.
export type Question = { tier?: Level; cursedFor?: string[]; id: string; prompt: { expression?: string; reading?: string; meaning?: string }; choices: ChoiceOption[] };
// The full server-side truth for a question, never sent to clients as-is —
// exposing `expression`/`reading`/`meaning` directly would leak the answer
// for the `word`/`reading` quiz types, whose choices ARE those fields.
export type PrivateQuestion = { tier?: Level; cursedFor?: string[]; id: string; expression: string; reading: string; meaning: string; choices: ChoiceOption[]; answerId: string; key: string };
export type Answer = { selectedAnswerId: string | null; result: 'correct' | 'incorrect' | 'timeout'; delta: number };
export type BattlePlayer = { nickname: string; score: number; correct: number; mistakes: number; combo?: number; timeoutStreak?: number; rewardCorrect?: number; answered: boolean; ready: boolean; connected: boolean; selection?: string | null; answer?: Answer };
export type PlayerResult = { pointsBefore: number; pointsAfter: number; cardsBefore: number; cardsAfter: number; gainedCards: string[]; lostCards: string[]; tier: Level; cursesBefore?: number; cursesAfter?: number; afkFine?: number; afkBonus?: number };
export type AfkResult = { uids: string[]; cause: 'timeouts' | 'surrender'; questionNumber: number; fine: number };
export type SurrenderRequest = { id: string; requestedBy: string; status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired' | 'timed_out'; respondedBy?: string; deadline?: number };
export type BattleState = {
  rulesVersion?: number; surrenderUsed?: number; afk?: AfkResult; matchId: string; roomCode: string; hostUid: string; mode: 'party' | 'solo'; tier: Level;
  quizType: QuizType;
  wagerType: 'points' | 'cards_points'; wagerPoints: number; wagerCards: number; reviewMs: number;
  status: 'lobby' | 'live' | 'complete' | 'cancelled'; phase: 'question' | 'review';
  players: Record<string, BattlePlayer>; questionIndex: number; totalQuestions: number;
  question?: Question; answerId?: string; deadline: number | null; serverNow: number;
  winnerUid: string | null; endReason?: 'mistakes' | 'questions' | 'aborted' | 'surrender' | 'afk'; endedBy?: string; surrender?: SurrenderRequest; results?: Record<string, PlayerResult>;
};
export function lowerTier(a: Level, b: Level): Level { return TIERS[Math.min(TIERS.indexOf(a), TIERS.indexOf(b))]; }
export function winner(players: Record<string, Pick<BattlePlayer, 'score' | 'mistakes'>>): string | null {
  const entries = Object.entries(players);
  if (entries.length !== 2) return null;
  const [[a, x], [b, y]] = entries;
  // One player hitting the mistake limit loses. If both hit it together, score breaks the tie.
  if ((x.mistakes >= RULES.mistakeLimit) !== (y.mistakes >= RULES.mistakeLimit)) return x.mistakes >= RULES.mistakeLimit ? b : a;
  return x.score === y.score ? null : x.score > y.score ? a : b;
}
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
