import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Headphones,
  Info,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import rawChokaiData from '@/lib/n2ChokaiData.json';
import { SimulationSpeechVoice, useSimulationSpeechSettings } from '@/components/SimulationSpeechVoice';
import { getPreferredSpeechVoice } from '@/lib/soundSettings';

/**
 * N2 聴解 block — original content only.
 *
 * Every script, option and answer in `src/lib/n2ChokaiData.json` was written for
 * this app, in the publicly documented N2 聴解 layout (問題1〜5). Nothing here is
 * copied from, or streamed out of, a real sitting: no official recordings, no
 * official scripts, no official answer keys, no third-party mirrors.
 *
 * Audio is the browser's Japanese voice (speechSynthesis) reading our own
 * transcript, which is also why the "scripts" are revealed after submitting —
 * they are our text, not a leaked one.
 *
 * The previous version of this file streamed dated sittings from an external
 * Drive folder, revealed their scripts and marked against their answer keys;
 * that is why it looks different now.
 */

export type ChokaiAnswerMap = Record<number, number>;
type AnswerMap = ChokaiAnswerMap;

export type ChokaiQuestion = {
  id: string;
  mondai: number;
  prompt: string;
  transcript: string;
  options: string[];
  correct_answer: number;
  explanation: string;
};

export type ChokaiSitting = {
  id: string;
  label: string;
  summary: string;
  /** 1-based correct option for each item, in 問題1→5 order. */
  answers: number[];
  items: ChokaiQuestion[];
};
type ChokaiSession = ChokaiSitting;

export type QuestionGroup = {
  mondai: number;
  name: string;
  instruction: string;
  start: number;
  count: number;
  choiceCount: number;
};

/** What one finished 聴解 sitting reports back to the exam-day coach. */
export type ListeningResult = {
  sessionId: string;
  label: string;
  total: number;
  correctCount: number;
  listeningScore: number;
  answers: AnswerMap;
};

export interface RealN2ChokaiProps {
  /**
   * Exam-day mode: jump straight into this sitting (no archive list) and hand
   * the /60 conversion back on submit instead of ending the block here.
   */
  examDay?: {
    sessionId: string;
    onFinish: (result: ListeningResult) => void;
  };
  /** Review mode: reopen the scored answer sheet for a finished sitting. */
  replay?: {
    sessionId: string;
    answers: AnswerMap;
  };
}

type ChokaiDataFile = {
  meta: {
    level: string;
    note: string;
    format: string;
    timing_minutes: number;
    format_reference: { label: string; url: string };
  };
  groups: Array<{ mondai: number; name: string; choiceCount: number; instruction: string }>;
  sessions: Array<{ id: string; label: string; summary: string; items: ChokaiQuestion[] }>;
};

const chokaiData = rawChokaiData as unknown as ChokaiDataFile;

export const CHOKAI_SESSIONS: ChokaiSitting[] = chokaiData.sessions.map((session) => ({
  id: session.id,
  label: session.label,
  summary: session.summary,
  items: session.items,
  answers: session.items.map((item) => item.correct_answer),
}));

/** 問題1–5 layout, with the item counts taken straight from the data. */
export const CHOKAI_QUESTION_GROUPS: QuestionGroup[] = (() => {
  let cursor = 0;
  return chokaiData.groups.map((group) => {
    const count = chokaiData.sessions[0].items.filter((item) => item.mondai === group.mondai).length;
    const entry: QuestionGroup = {
      mondai: group.mondai,
      name: group.name,
      instruction: group.instruction,
      start: cursor,
      count,
      choiceCount: group.choiceCount,
    };
    cursor += count;
    return entry;
  });
})();

const TOTAL_QUESTIONS = CHOKAI_QUESTION_GROUPS.reduce((total, group) => total + group.count, 0);
const EXAM_SECONDS = chokaiData.meta.timing_minutes * 60;
const OFFICIAL_SAMPLES_URL = chokaiData.meta.format_reference.url;

const formatTime = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

/** Strip the speaker labels so the voice reads dialogue, not "男：". */
const speakable = (transcript: string): string =>
  transcript
    .split('\n')
    .map((line) => line.replace(/^[^：:\n]{1,6}[：:]\s*/, ''))
    .join(' ');

const resolveSession = (sessionId: string | undefined): ChokaiSitting | null =>
  CHOKAI_SESSIONS.find((session) => session.id === sessionId) ?? CHOKAI_SESSIONS[0] ?? null;

export function RealN2Chokai({ examDay, replay }: RealN2ChokaiProps = {}) {
  const speechSettings = useSimulationSpeechSettings();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    examDay?.sessionId ?? replay?.sessionId ?? null,
  );
  const [submitted, setSubmitted] = useState(Boolean(replay));
  const [answers, setAnswers] = useState<AnswerMap>(replay?.answers ?? {});
  const [secondsLeft, setSecondsLeft] = useState(EXAM_SECONDS);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [showScripts, setShowScripts] = useState(false);

  const autoPlayRef = useRef(false);
  const activeSession = useMemo(() => resolveSession(activeSessionId ?? undefined), [activeSessionId]);

  const ttsAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const stopAudio = useCallback(() => {
    autoPlayRef.current = false;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingIndex(null);
  }, []);

  const playItem = useCallback(
    (index: number) => {
      if (!activeSession || !ttsAvailable) return;
      const item = activeSession.items[index];
      if (!item) return;

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(speakable(item.transcript));
      const voice = getPreferredSpeechVoice(speechSettings);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = 'ja-JP';
      }
      utterance.rate = 0.95;
      utterance.onend = () => {
        if (autoPlayRef.current && index + 1 < activeSession.items.length) {
          playItem(index + 1);
          return;
        }
        autoPlayRef.current = false;
        setPlayingIndex(null);
      };
      utterance.onerror = () => {
        autoPlayRef.current = false;
        setPlayingIndex(null);
      };

      setPlayingIndex(index);
      window.speechSynthesis.speak(utterance);
    },
    [activeSession, speechSettings, ttsAvailable],
  );

  const playAll = useCallback(() => {
    autoPlayRef.current = true;
    playItem(0);
  }, [playItem]);

  const answeredCount = Object.keys(answers).length;
  const correctCount = activeSession
    ? activeSession.answers.filter((correctAnswer, questionIndex) => answers[questionIndex] === correctAnswer).length
    : 0;
  const listeningScore = activeSession
    ? Math.round((correctCount / activeSession.answers.length) * 60)
    : 0;

  const startExam = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setAnswers({});
    setSecondsLeft(EXAM_SECONDS);
    setSubmitted(false);
    setShowScripts(false);
  };

  const finishExam = () => {
    stopAudio();
    setSubmitted(true);
    if (examDay && activeSession) {
      examDay.onFinish({
        sessionId: activeSession.id,
        label: activeSession.label,
        total: activeSession.answers.length,
        correctCount,
        listeningScore,
        answers,
      });
    }
  };

  const returnToSessions = () => {
    stopAudio();
    setActiveSessionId(null);
    setAnswers({});
    setSecondsLeft(EXAM_SECONDS);
    setSubmitted(false);
    setShowScripts(false);
  };

  useEffect(() => {
    if (!activeSession || submitted || secondsLeft <= 0) return;

    const timer = window.setTimeout(() => {
      setSecondsLeft((previous) => previous - 1);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [activeSession, secondsLeft, submitted]);

  useEffect(() => {
    if (activeSession && !submitted && secondsLeft === 0) {
      setSubmitted(true);
    }
  }, [activeSession, secondsLeft, submitted]);

  // Never leave the browser voice talking after this block unmounts.
  useEffect(() => stopAudio, [stopAudio]);

  // ---------------------------------------------------------------------
  // Archive list
  // ---------------------------------------------------------------------
  if (!activeSession) {
    return (
      <section className="mt-8 border-t border-border pt-8">
        <SimulationSpeechVoice />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Headphones className="h-5 w-5" />
              <span className="text-xs font-black uppercase tracking-wider">N2 聴解 practice block</span>
            </div>
            <h2 className="mt-2 flex items-center gap-2 text-lg font-bold text-foreground">
              3. Sit a 50-minute Listening Block
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              {TOTAL_QUESTIONS} original items across 問題1〜5 (課題理解・ポイント理解・概要理解・即時応答・統合理解),
              timed at 50 minutes and scored out of 60. The scripts are our own text and are played by your
              browser&apos;s Japanese voice — official recordings are not distributed with this app.
            </p>
          </div>
          <span className="w-fit rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-700">
            {CHOKAI_SESSIONS.length} scored set{CHOKAI_SESSIONS.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CHOKAI_SESSIONS.map((session, index) => (
            <article
              key={session.id}
              data-testid={`n2-chokai-session-${index + 1}`}
              className="flex flex-col justify-between rounded-3xl border border-border bg-card p-5 shadow-sm transition hover:border-primary/50"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-lg bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-bold text-primary">
                    {session.id.replace('n2-chokai-', 'SET ')}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Scored
                  </span>
                </div>
                <h3 className="mt-3 text-lg font-black text-foreground">{session.label}</h3>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {chokaiData.meta.timing_minutes} minutes
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1">
                    {session.items.length} questions
                  </span>
                  <span className="rounded-full bg-muted px-2.5 py-1">Browser voice</span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{session.summary}</p>
              </div>

              <button
                type="button"
                data-testid={`n2-chokai-start-${index + 1}`}
                onClick={() => startExam(session.id)}
                className="mt-5 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
              >
                Start {session.label}
              </button>
            </article>
          ))}
        </div>

        <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Looking for the organisers&apos; own material? Their free sample questions and audio are published at{' '}
            <a
              className="font-semibold text-primary underline"
              href={OFFICIAL_SAMPLES_URL}
              target="_blank"
              rel="noreferrer"
            >
              jlpt.jp/samples
            </a>
            . JLPT is a trademark of its organisers; this app is not affiliated with them.
          </span>
        </p>
      </section>
    );
  }

  // ---------------------------------------------------------------------
  // Result / review
  // ---------------------------------------------------------------------
  if (submitted) {
    return (
      <section
        data-testid="n2-chokai-result"
        className="mt-8 rounded-3xl border border-border bg-card p-6 shadow-sm md:p-8"
      >
        <button
          type="button"
          onClick={returnToSessions}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground transition hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" /> Back to listening sets
        </button>

        <div className="mt-5 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Headphones className="h-7 w-7" />
          </div>
          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-primary">聴解 result</p>
          <h2 className="mt-1 text-2xl font-black text-foreground">{activeSession.label} completed</h2>
        </div>

        <div className="mx-auto mt-6 grid max-w-2xl gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">Correct</p>
            <p className="mt-1 text-2xl font-black" data-testid="n2-chokai-correct">
              {correctCount} / {TOTAL_QUESTIONS}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">Practice conversion</p>
            <p className="mt-1 text-2xl font-black" data-testid="n2-chokai-score">
              {listeningScore} / 60
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">N2 benchmark</p>
            <p
              className={`mt-1 text-xl font-black ${
                listeningScore >= 19 ? 'text-emerald-600' : 'text-destructive'
              }`}
            >
              {listeningScore >= 19 ? 'Cleared' : 'Below 19'}
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <h3 className="font-bold text-foreground">聴解スクリプト</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                These scripts were written for this app, so they can be shown now that the attempt is
                submitted — read along to check what you missed.
              </p>
              <button
                type="button"
                data-testid="n2-chokai-script-link"
                onClick={() => setShowScripts((previous) => !previous)}
                className="mt-3 inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-amber-700"
              >
                {showScripts ? 'Hide' : 'Show'} {activeSession.label} scripts
              </button>
            </div>
          </div>
        </div>

        <div className="mt-7">
          <h3 className="font-bold text-foreground">Answer review</h3>
          <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7">
            {activeSession.answers.map((correctAnswer, index) => {
              const userAnswer = answers[index];
              const isCorrect = userAnswer === correctAnswer;

              return (
                <div
                  key={index}
                  className={`rounded-xl border p-2 text-center text-xs ${
                    isCorrect
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : 'border-destructive/40 bg-destructive/10'
                  }`}
                >
                  <p className="font-bold">Q{index + 1}</p>
                  <p className="mt-1">You: {userAnswer ?? '—'}</p>
                  <p>Key: {correctAnswer}</p>
                </div>
              );
            })}
          </div>
        </div>

        {showScripts && (
          <div className="mt-7 space-y-4">
            {activeSession.items.map((item, index) => (
              <article key={item.id} className="rounded-2xl border border-border bg-background p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs font-bold text-primary">
                    Q{index + 1} · 問題{item.mondai}
                  </p>
                  <p className="text-xs font-bold text-foreground">{item.prompt}</p>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm leading-6 text-muted-foreground">
                  {item.transcript}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  <span className="font-bold text-foreground">Key {item.correct_answer}: </span>
                  {item.options[item.correct_answer - 1]}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.explanation}</p>
              </article>
            ))}
          </div>
        )}

        <div className="mt-7 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => startExam(activeSession.id)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" /> Retake this set
          </button>
          {!examDay && (
            <button
              type="button"
              onClick={returnToSessions}
              className="rounded-xl border border-border bg-background px-5 py-2.5 text-sm font-bold transition hover:bg-muted"
            >
              Choose another set
            </button>
          )}
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------------
  // Exam
  // ---------------------------------------------------------------------
  return (
    <section data-testid="n2-chokai-exam" className="mt-8">
      <div className="sticky top-2 z-30 rounded-2xl border border-primary/30 bg-card/95 p-4 shadow-lg backdrop-blur">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="shrink-0">
            <p className="text-xs font-bold uppercase text-primary">
              N2 聴解・{activeSession.label}
            </p>
            <p className="mt-1 flex items-center gap-2 font-mono text-xl font-black">
              <Clock className="h-5 w-5" />
              <span data-testid="n2-chokai-timer">{formatTime(secondsLeft)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {answeredCount} of {TOTAL_QUESTIONS} answered
            </p>
          </div>

          <div className="w-full lg:max-w-xl">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 p-3">
              <button
                type="button"
                onClick={playAll}
                disabled={!ttsAvailable}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" /> Play all in order
              </button>
              <button
                type="button"
                onClick={stopAudio}
                disabled={playingIndex === null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-bold transition hover:bg-muted disabled:opacity-40"
              >
                <Pause className="h-3.5 w-3.5" /> Stop
              </button>
              <span className="text-[10px] text-muted-foreground">
                {ttsAvailable
                  ? 'Your browser reads the script in Japanese — synthesised voice, not an official recording.'
                  : 'This browser has no speech synthesis; use the per-question scripts after submitting.'}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {!examDay && (
              <button
                type="button"
                onClick={returnToSessions}
                className="rounded-xl border border-border bg-background px-3 py-2 text-xs font-bold transition hover:bg-muted"
              >
                Exit
              </button>
            )}
            <button
              type="button"
              onClick={finishExam}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-700"
            >
              Submit listening block
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        {CHOKAI_QUESTION_GROUPS.map((group) => (
          <div key={group.mondai}>
            <div className="flex flex-wrap items-baseline gap-2 border-b border-border pb-2">
              <h3 className="font-black text-foreground">
                問題{group.mondai}（{group.name}）
              </h3>
              <span className="text-xs text-muted-foreground">
                {group.count} questions · choose from {group.choiceCount}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{group.instruction}</p>

            <div className="mt-4 space-y-3">
              {activeSession.items
                .slice(group.start, group.start + group.count)
                .map((item, localIndex) => {
                  const index = group.start + localIndex;
                  const isPlaying = playingIndex === index;
                  return (
                    <article
                      key={item.id}
                      className="rounded-2xl border border-border bg-card p-4 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-[11px] font-bold text-primary">Q{index + 1}</p>
                          <p className="mt-1 text-sm font-bold text-foreground">{item.prompt}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => (isPlaying ? stopAudio() : playItem(index))}
                          disabled={!ttsAvailable}
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition disabled:opacity-40 ${
                            isPlaying
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border bg-background hover:bg-muted'
                          }`}
                        >
                          {isPlaying ? (
                            <>
                              <Pause className="h-3.5 w-3.5" /> Stop
                            </>
                          ) : (
                            <>
                              <Play className="h-3.5 w-3.5" /> Play
                            </>
                          )}
                        </button>
                      </div>

                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {item.options.map((option, optionIndex) => {
                          const value = optionIndex + 1;
                          const selected = answers[index] === value;
                          return (
                            <button
                              key={item.id + '-' + value}
                              type="button"
                              onClick={() =>
                                setAnswers((previous) => ({ ...previous, [index]: value }))
                              }
                              className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-left text-sm transition ${
                                selected
                                  ? 'border-primary bg-primary/10 font-bold text-primary'
                                  : 'border-border bg-background hover:border-primary/40'
                              }`}
                            >
                              <span className="mt-0.5 font-mono text-xs font-bold">{value}</span>
                              <span className="min-w-0">{option}</span>
                            </button>
                          );
                        })}
                      </div>
                    </article>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={finishExam}
        className="mt-6 w-full rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700"
      >
        Submit listening block
      </button>
    </section>
  );
}
