import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  BookOpenCheck,
  CheckCircle2,
  ClipboardList,
  Coffee,
  Headphones,
  Info,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { RealN1Simulation, type WrittenPaperResult } from './RealN1Simulation';
import { RealN1Chokai, type ListeningResult, CHOKAI_SESSIONS } from './RealN1Chokai';
import simulationData from '@/lib/realN1SimulationData.json';
import {
  N1_BLOCK_BENCHMARK,
  N1_PASS_TOTAL,
  N1_TOTAL_MARKS,
  computeExamDayVerdict,
  writeExamDayRecord,
  type ExamDayBlocks,
  type ExamDayRecord,
} from '@/lib/n1ExamDay';

type TestSetLike = {
  id: string;
  name: string;
  description: string;
  reference_sitting?: string;
  sections: Array<{ id: string; name: string; official_time_minutes: number; questions: unknown[] }>;
};

type Phase = 'intro' | 'written' | 'break' | 'chokai' | 'result' | 'review-written' | 'review-chokai';

const WRITTEN_MINUTES = 110;
const BREAK_SECONDS = 5 * 60;

const sets = simulationData.test_sets as unknown as TestSetLike[];

const sessionForSitting = (sittingId: string | null) =>
  CHOKAI_SESSIONS.find((session) => session.id === sittingId) ?? null;

const formatClock = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const PhaseBar = ({ phase, listeningMinutes }: { phase: Phase; listeningMinutes: number }) => {
  const steps: Array<{ key: Phase[]; label: string }> = [
    { key: ['written'], label: `1. 言語知識・読解 ${WRITTEN_MINUTES}分` },
    { key: ['break'], label: '2. 休憩' },
    { key: ['chokai'], label: `3. 聴解 ${listeningMinutes}分` },
    { key: ['result', 'review-written', 'review-chokai'], label: '4. 総合結果' },
  ];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-bold">
      {steps.map((step) => {
        const active = step.key.includes(phase);
        return (
          <span
            key={step.label}
            className={`rounded-full border px-3 py-1 ${
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-muted-foreground'
            }`}
          >
            {step.label}
          </span>
        );
      })}
    </div>
  );
};

export function RealN1ExamDay() {
  const [phase, setPhase] = useState<Phase>('intro');
  const [setIndex, setSetIndex] = useState(0);
  const [written, setWritten] = useState<WrittenPaperResult | null>(null);
  const [listening, setListening] = useState<ListeningResult | null>(null);
  const [breakSeconds, setBreakSeconds] = useState(BREAK_SECONDS);

  const activeSet = sets[setIndex] ?? sets[0];
  // 聴解 is our own N1 set, not a dated sitting: never build an id out of
  // reference_sitting or the UI would label the block as a real sitting it is not.
  const sittingId = CHOKAI_SESSIONS[0]?.id ?? null;
  const activeSitting = sessionForSitting(sittingId);
  const listeningMinutes = activeSitting ? activeSitting.examMinutes : 55;
  const listeningItems = activeSitting
    ? activeSitting.answers.length
    : 30;

  const verdict = useMemo(
    () =>
      written && listening
        ? computeExamDayVerdict({
            language: written.languageScore,
            reading: written.readingScore,
            listening: listening.listeningScore,
          })
        : null,
    [written, listening],
  );

  // Break between the written paper and 聴解, as scheduled on test day.
  useEffect(() => {
    if (phase !== 'break' || breakSeconds <= 0) return;
    const timer = window.setTimeout(() => setBreakSeconds((prev) => prev - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, breakSeconds]);

  useEffect(() => {
    if (phase === 'break' && breakSeconds === 0) setPhase('chokai');
  }, [phase, breakSeconds]);

  // Persist the verdict so the hub card can show the latest full run.
  useEffect(() => {
    if (phase !== 'result' || !written || !listening || !verdict) return;
    const blocks: ExamDayBlocks = {
      language: written.languageScore,
      reading: written.readingScore,
      listening: listening.listeningScore,
    };
    const record: ExamDayRecord = {
      version: 1,
      completedAt: new Date().toISOString(),
      setId: written.setId,
      setName: written.setName,
      sittingId: listening.sessionId,
      sittingLabel: listening.label,
      blocks,
      total: verdict.total,
      benchmarks: verdict.benchmarks,
      passed: verdict.passed,
      correct: {
        written: written.correctCount,
        writtenTotal: written.totalQuestions,
        listening: listening.correctCount,
        listeningTotal: listening.total,
      },
    };
    writeExamDayRecord(record);
  }, [phase, written, listening, verdict]);

  const beginExamDay = (index: number) => {
    setSetIndex(index);
    setWritten(null);
    setListening(null);
    setBreakSeconds(BREAK_SECONDS);
    setPhase('written');
  };

  const retakeSameSitting = () => beginExamDay(setIndex);

  // ------------------------------------------------------------------
  // Intro: choose the written paper (all three pair with the same original 聴解 block)
  // ------------------------------------------------------------------
  if (phase === 'intro') {
    return (
      <div className="mx-auto max-w-[1000px] px-5 py-8 pb-28 md:px-10 md:py-12 md:pb-16 animate-fadeIn">
        <Link
          href="/jlpt-simulation/n1"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground transition hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" /> Back to N1 practice
        </Link>

        <div className="mt-4 rounded-[1.75rem] border border-primary/30 bg-card p-6 md:p-8 shadow-sm">
          <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-primary">
            <ClipboardList className="h-3.5 w-3.5" /> Full exam day
          </span>
          <h1 className="mt-4 text-2xl font-black tracking-tight text-foreground md:text-3xl">
            N1 Exam Day — 言語知識・読解 110分 → 聴解 55分 → one 合否 verdict
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            One sitting, laid out like the real test day. You write the 110-minute
            written paper first, take a short break, then sit the 55-minute 聴解
            block, which uses original items played by your browser's Japanese
            voice. Scores stay hidden until both halves are in, and the result is
            the published three-block 合否:
            total ≥ {N1_PASS_TOTAL}/{N1_TOTAL_MARKS} with at least{' '}
            {N1_BLOCK_BENCHMARK}/60 in every block.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-[11px] font-mono uppercase text-muted-foreground">Written paper</p>
              <p className="mt-1 text-sm font-bold text-foreground">{WRITTEN_MINUTES} minutes</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                言語知識（文字・語彙・文法）+ 読解, 問題1〜13
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-[11px] font-mono uppercase text-muted-foreground">Break</p>
              <p className="mt-1 text-sm font-bold text-foreground">5 minutes</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Skippable — start 聴解 whenever you're ready</p>
            </div>
            <div className="rounded-2xl border border-border bg-background p-4">
              <p className="text-[11px] font-mono uppercase text-muted-foreground">聴解</p>
              <p className="mt-1 text-sm font-bold text-foreground">{listeningMinutes} minutes</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {listeningItems} items, 問題1〜5, browser-voice audio
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <p>
              Both halves are original practice material written for this app in the
              published N1 format — no JEES / Japan Foundation paper, recording or
              answer key is reproduced or streamed. Block scores are a proportional
              practice conversion; the real JLPT uses IRT 尺度得点, which is never
              published.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {sets.map((set, index) => {
            const cardSitting = sessionForSitting(sittingId);
            return (
            <article
              key={set.id}
              data-testid={`n1-exam-day-set-${index + 1}`}
              className="flex flex-col justify-between rounded-3xl border border-border bg-card p-5 shadow-sm transition hover:border-primary/50"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-lg bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-bold text-primary">
                    {set.reference_sitting ?? `SET ${index + 1}`}
                  </span>
                  <span className="text-[10px] font-bold text-muted-foreground">
                    Exam day {index + 1}
                  </span>
                </div>
                <h2 className="mt-3 text-base font-black text-foreground">{set.name}</h2>
                <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                  {set.description}
                </p>
                <ul className="mt-3 space-y-1.5 text-[11px] text-muted-foreground">
                  <li className="flex items-center gap-1.5">
                    <BookOpenCheck className="h-3.5 w-3.5 text-primary" />
                    {set.sections.reduce((acc, s) => acc + s.questions.length, 0)} written questions
                    · {set.sections.reduce((acc, s) => acc + s.official_time_minutes, 0)} min
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Headphones className="h-3.5 w-3.5 text-primary" />
                    {cardSitting
                      ? `${cardSitting.label} · ${cardSitting.answers.length} items · ${cardSitting.examMinutes} min`
                      : '聴解 30 items · 55 min'}
                  </li>
                </ul>
              </div>

              <button
                type="button"
                data-testid={`n1-exam-day-start-${index + 1}`}
                onClick={() => beginExamDay(index)}
                className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
              >
                Begin exam day <ArrowRight className="h-4 w-4" />
              </button>
            </article>
            );
          })}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Phase 1 — written paper (110:00, scores hidden until the very end)
  // ------------------------------------------------------------------
  if (phase === 'written') {
    return (
      <div className="mx-auto max-w-[1020px] px-5 py-6 md:px-10">
        <PhaseBar phase={phase} listeningMinutes={listeningMinutes} />
        <RealN1Simulation
          examDay={{
            setIndex,
            onFinish: (result) => {
              setWritten(result);
              setBreakSeconds(BREAK_SECONDS);
              setPhase('break');
            },
          }}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Phase 2 — break, then straight into 聴解
  // ------------------------------------------------------------------
  if (phase === 'break') {
    return (
      <div className="mx-auto max-w-[820px] px-5 py-8 pb-28 md:px-10 md:py-12 animate-fadeIn">
        <PhaseBar phase={phase} listeningMinutes={listeningMinutes} />
        <div
          data-testid="n1-exam-day-break"
          className="rounded-3xl border border-border bg-card p-6 text-center shadow-sm md:p-8"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Coffee className="h-7 w-7" />
          </div>
          <h2 className="mt-4 text-xl font-black text-foreground">
            Written paper submitted — answers are locked
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            As on the real test day your written score stays hidden until the
            聴解 block is done. Take a short break, then sit the{' '}
            {listening ? listening.label : CHOKAI_SESSIONS[0]?.label ?? 'N1 聴解'}
            ({listeningMinutes} min) — headphones recommended.
          </p>

          <p className="mt-6 font-mono text-4xl font-black text-primary">
            {formatClock(breakSeconds)}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            聴解 starts automatically when the break runs out
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              data-testid="n1-exam-day-start-listening"
              onClick={() => setPhase('chokai')}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
            >
              <Headphones className="h-4 w-4" /> Start 聴解 now
            </button>
            <button
              type="button"
              onClick={() => setBreakSeconds((prev) => prev + 5 * 60)}
              className="rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-bold transition hover:bg-muted"
            >
              +5 minutes
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Phase 3 — 聴解 (per-sitting timer)
  // ------------------------------------------------------------------
  if (phase === 'chokai') {
    return (
      <div className="mx-auto max-w-[1020px] px-5 py-6 md:px-10">
        <PhaseBar phase={phase} listeningMinutes={listeningMinutes} />
        <RealN1Chokai
          examDay={{
            sessionId: sittingId ?? CHOKAI_SESSIONS[0].id,
            onFinish: (result) => {
              setListening(result);
              setPhase('result');
            },
          }}
        />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Review views (replay the finished halves with their explanations)
  // ------------------------------------------------------------------
  if (phase === 'review-written' || phase === 'review-chokai') {
    return (
      <div className="mx-auto max-w-[1020px] px-5 py-6 md:px-10">
        <button
          type="button"
          onClick={() => setPhase('result')}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground transition hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" /> Back to the 総合結果
        </button>
        {phase === 'review-written' && written && (
          <RealN1Simulation replay={{ setIndex, answers: written.answers }} />
        )}
        {phase === 'review-chokai' && listening && (
          <RealN1Chokai
            replay={{ sessionId: listening.sessionId, answers: listening.answers }}
          />
        )}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Result — the single combined 合否 across all three blocks
  // ------------------------------------------------------------------
  if (!written || !listening || !verdict) {
    return null;
  }

  const blockRows = [
    { key: 'language' as const, label: '言語知識（文字・語彙・文法）', score: written.languageScore },
    { key: 'reading' as const, label: '読解 (Reading)', score: written.readingScore },
    { key: 'listening' as const, label: '聴解 (Listening)', score: listening.listeningScore },
  ];

  return (
    <div className="mx-auto max-w-[960px] px-5 py-8 pb-28 md:px-10 md:py-12 animate-fadeIn">
      <PhaseBar phase={phase} listeningMinutes={listeningMinutes} />

      <section
        data-testid="n1-exam-day-result"
        className={`rounded-3xl border p-6 text-center shadow-lg md:p-8 ${
          verdict.passed
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-destructive/40 bg-destructive/10'
        }`}
      >
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-card shadow-sm">
          {verdict.passed ? (
            <Award className="h-9 w-9 text-emerald-500" />
          ) : (
            <XCircle className="h-9 w-9 text-destructive" />
          )}
        </div>

        <p className="mt-4 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          総合結果 · {written.setName} + {listening.label} 聴解
        </p>
        <h2 className="mt-1 text-3xl font-black text-foreground">
          {verdict.passed ? '合格 — N1 CLEARED' : '不合格 — N1 NOT CLEARED'}
        </h2>
        <p className="mt-2 font-mono text-2xl font-black" data-testid="n1-exam-day-total">
          {verdict.total} / {N1_TOTAL_MARKS}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pass mark {N1_PASS_TOTAL}/{N1_TOTAL_MARKS} with 基準点 ≥ {N1_BLOCK_BENCHMARK}/60 in every block
        </p>

        <div className="mx-auto mt-6 grid max-w-2xl gap-3 sm:grid-cols-3">
          {blockRows.map((row) => {
            const met = verdict.benchmarks[row.key];
            return (
              <div
                key={row.key}
                className="rounded-2xl border border-border bg-card p-4 text-center"
                data-testid={`n1-exam-day-block-${row.key}`}
              >
                <p className="text-[11px] font-mono uppercase text-muted-foreground">{row.label}</p>
                <p className="mt-1 text-2xl font-black text-foreground">{row.score} / 60</p>
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    met ? 'bg-emerald-500/20 text-emerald-600' : 'bg-destructive/20 text-destructive'
                  }`}
                >
                  {met ? `基準点 ≥ ${N1_BLOCK_BENCHMARK} ✓` : `Below ${N1_BLOCK_BENCHMARK}`}
                </span>
              </div>
            );
          })}
        </div>

        {verdict.passed ? (
          <p className="mx-auto mt-5 max-w-2xl rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
            <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5 text-emerald-600" />
            All three blocks cleared their 基準点 and the total cleared{' '}
            {N1_PASS_TOTAL}. On the real test that is a pass.
          </p>
        ) : (
          <ul className="mx-auto mt-5 max-w-2xl space-y-1.5 rounded-2xl border border-border bg-card p-4 text-left text-xs text-muted-foreground">
            {verdict.reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                {reason}
              </li>
            ))}
          </ul>
        )}

        <p className="mx-auto mt-4 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
          Raw marks: written {written.correctCount}/{written.totalQuestions} (
          {written.languageScore} + {written.readingScore}) and 聴解{' '}
          {listening.correctCount}/{listening.total}. Each block is converted to a
          proportional /60 — the real JLPT scales raw marks with IRT 尺度得点,
          which JEES does not publish, so treat this as a practice verdict.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            data-testid="n1-exam-day-review-written"
            onClick={() => setPhase('review-written')}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-bold transition hover:bg-muted"
          >
            <BookOpenCheck className="h-4 w-4" /> Review written paper (解説)
          </button>
          <button
            type="button"
            data-testid="n1-exam-day-review-listening"
            onClick={() => setPhase('review-chokai')}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-bold transition hover:bg-muted"
          >
            <Headphones className="h-4 w-4" /> Review 聴解 answers
          </button>
          <button
            type="button"
            data-testid="n1-exam-day-retake"
            onClick={retakeSameSitting}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" /> Retake this exam day
          </button>
          <button
            type="button"
            onClick={() => setPhase('intro')}
            className="rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-bold transition hover:bg-muted"
          >
            Choose another sitting
          </button>
        </div>
      </section>
    </div>
  );
}
