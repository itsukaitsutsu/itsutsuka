/**
 * N1 "exam day" verdict — the single 合否 result that combines all three
 * official 得点区分 blocks, exactly as the real JLPT reports them:
 *
 *   言語知識（文字・語彙・文法）  60点  基準点 19
 *   読解                          60点  基準点 19
 *   聴解                          60点  基準点 19
 *   総合                         180点  合格点 90
 *
 * Scoring caveat: the real JLPT converts raw marks with IRT 尺度得点
 * (item-level difficulty weighting + equating across sittings). That formula is
 * never published, so these /60 conversions are a proportional practice
 * approximation — the block structure, 基準点 and 合格点 are official.
 */

export const EXAM_DAY_STORAGE_KEY = 'jlpt_n1_exam_day_result';

export const N1_TOTAL_MARKS = 180;
export const N1_PASS_TOTAL = 90;
export const N1_BLOCK_MARKS = 60;
export const N1_BLOCK_BENCHMARK = 19;

export type BlockKey = 'language' | 'reading' | 'listening';

export type ExamDayBlocks = Record<BlockKey, number>;

export type ExamDayRecord = {
  version: 1;
  completedAt: string;
  setId: string;
  setName: string;
  sittingId: string;
  sittingLabel: string;
  blocks: ExamDayBlocks;
  total: number;
  benchmarks: Record<BlockKey, boolean>;
  passed: boolean;
  correct: { written: number; writtenTotal: number; listening: number; listeningTotal: number };
};

export type ExamDayVerdict = {
  total: number;
  benchmarks: Record<BlockKey, boolean>;
  passed: boolean;
  /** Why the sitting failed, in the official order of the criteria. */
  reasons: string[];
};

export const computeExamDayVerdict = (blocks: ExamDayBlocks): ExamDayVerdict => {
  const total = blocks.language + blocks.reading + blocks.listening;
  const benchmarks: Record<BlockKey, boolean> = {
    language: blocks.language >= N1_BLOCK_BENCHMARK,
    reading: blocks.reading >= N1_BLOCK_BENCHMARK,
    listening: blocks.listening >= N1_BLOCK_BENCHMARK,
  };
  const reasons: string[] = [];
  if (total < N1_PASS_TOTAL) {
    reasons.push(
      `総合得点 ${total}/180 is below the 合格点 of ${N1_PASS_TOTAL}/180.`,
    );
  }
  if (!benchmarks.language) {
    reasons.push(
      `言語知識 ${blocks.language}/60 is below the 基準点 of ${N1_BLOCK_BENCHMARK}/60.`,
    );
  }
  if (!benchmarks.reading) {
    reasons.push(
      `読解 ${blocks.reading}/60 is below the 基準点 of ${N1_BLOCK_BENCHMARK}/60.`,
    );
  }
  if (!benchmarks.listening) {
    reasons.push(
      `聴解 ${blocks.listening}/60 is below the 基準点 of ${N1_BLOCK_BENCHMARK}/60.`,
    );
  }
  return { total, benchmarks, passed: reasons.length === 0, reasons };
};

export const readExamDayRecord = (): ExamDayRecord | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(EXAM_DAY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExamDayRecord;
    if (!parsed || typeof parsed.total !== 'number' || !parsed.blocks) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const writeExamDayRecord = (record: ExamDayRecord): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXAM_DAY_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* private mode / quota — the verdict still renders, it just isn't kept. */
  }
};
