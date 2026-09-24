import n1Csv from '@assets/data/vocab-n1.csv?raw';
import n2Csv from '@assets/data/vocab-n2.csv?raw';
import n3Csv from '@assets/data/vocab-n3.csv?raw';
import n4Csv from '@assets/data/vocab-n4.csv?raw';
import n5Csv from '@assets/data/vocab-n5.csv?raw';

import combo1 from '@assets/feedback/round-combo-1.mp3';
import combo2 from '@assets/feedback/round-combo-2.mp3';
import combo3 from '@assets/feedback/round-combo-3.mp3';
import combo4 from '@assets/feedback/round-combo-4.mp3';
import combo5 from '@assets/feedback/round-combo-5.mp3';
import answerSound from '@assets/feedback/answer-confirm.wav';
import wrongSound from '@assets/feedback/answer-wrong.mp3';
import highResultSound from '@assets/feedback/result-high.mp3';
import lowResultSound from '@assets/feedback/result-low.mp3';
import perfectResultSound from '@assets/feedback/result-perfect.mp3';

import { parseCsv, type Level, type Word } from '../../shared/vocabulary';
export type { Level, Word } from '../../shared/vocabulary';

const sources: Array<[string, string, Level]> = [
  [n1Csv, 'n1', 'N1'], [n2Csv, 'n2', 'N2'], [n3Csv, 'n3', 'N3'],
  [n4Csv, 'n4', 'N4'], [n5Csv, 'n5', 'N5'],
];

const seen = new Set<string>();
export const vocabulary: Word[] = sources.flatMap(([csv, source, level]) => parseCsv(csv, source, level)).filter((word) => {
  const key = `${word.expression}|${word.reading}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

  export const feedbackAudio = {
    kills: [combo1, combo2, combo3, combo4, combo5],
    combo: [combo1, combo2, combo3, combo4, combo5],
    // Neutral JLPT answer confirmation; unlike the quiz feedback sounds, this never reveals correctness.
    answer: answerSound,
    wrong: wrongSound,
    high: highResultSound,
    low: lowResultSound,
    perfect: perfectResultSound,
  };

/**
 * Score band for a completed round — the single source of truth for the
 * 100% / >= 80% / below thresholds used by sounds, slots, and popups.
 */
export type ResultBand = 'perfect' | 'high' | 'low';

export function resultBandForScore(score: number, total: number): ResultBand {
  if (total > 0 && score >= total) return 'perfect';
  if (total > 0 && score / total >= 0.8) return 'high';
  return 'low';
}

/**
 * Pick the finish sound for a completed round.
 * 100% (score === total) gets the perfect fanfare, >= 80% gets the
 * high sound, anything below gets the low sound.
 */
export function resultSoundForScore(score: number, total: number) {
  const band = resultBandForScore(score, total);
  return band === 'perfect' ? feedbackAudio.perfect : band === 'high' ? feedbackAudio.high : feedbackAudio.low;
}

export function playFeedback(src: string, onAudio?: (audio: HTMLAudioElement) => void) {
  try {
    const audio = new Audio(src);
    audio.volume = 0.7;
    onAudio?.(audio);
    void audio.play().catch(() => undefined);
  } catch { /* Audio is unavailable in some embedded browsers. */ }
}

export function shuffle<T>(items: T[]) {
  return [...items].sort(() => Math.random() - 0.5);
}