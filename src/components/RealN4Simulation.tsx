import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  FileText,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Award,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Eye,
  ShieldAlert,
  Info,
  Calendar,
  Layers,
  ArrowRight,
  Headphones,
  Volume2,
  VolumeX,
  Play,
  Pause,
  BookOpen,
  Check,
  Flame,
  ArrowLeft,
  RotateCcw
} from 'lucide-react';
// N4 data: public scoring rules + original N4-format practice question sets.
// No JEES / Japan Foundation exam papers or recordings are bundled with this app.
import simulationData from '@/lib/realN4SimulationData.json';
import { SimulationSpeechVoice, useSimulationSpeechSettings } from '@/components/SimulationSpeechVoice';
import { getPreferredSpeechVoice } from '@/lib/soundSettings';

interface Question {
  id: string;
  section: string;
  mondai: string;
  mondai_instruction?: string;
  prompt: string;
  target_word?: string;
  passage?: string;
  transcript?: string;
  options: string[];
  correct_answer: number;
  explanation: string;
}

interface Section {
  id: string;
  name: string;
  english_name: string;
  official_time_minutes: number;
  questions: Question[];
}

interface PaperRef {
  pdf: string;
  source_url?: string;
  exam?: string;
  written_pages?: string;
  listening_pages?: string;
  answer_key_pages?: string | null;
}

interface TestSet {
  id: string;
  name: string;
  description: string;
  /** Optional pointer to the organisers' own sample-question page (nothing bundled). */
  paper?: PaperRef;
  sections: Section[];
}

const STORAGE_KEY = 'jlpt_n4_simulation_state';

export function RealN4Simulation() {
  const speechSettings = useSimulationSpeechSettings();
  const [selectedSetIndex, setSelectedSetIndex] = useState(0);
  const [activeSectionId, setActiveSectionId] = useState<string>('all');
  const [viewState, setViewState] = useState<'intro' | 'guidelines' | 'exam' | 'result'>('intro');
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<string, number>>({});
  const [markedQuestions, setMarkedQuestions] = useState<Record<string, boolean>>({});
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [timerActive, setTimerActive] = useState(false);
  const [showExplanationMap, setShowExplanationMap] = useState<Record<string, boolean>>({});
  const [filterResult, setFilterResult] = useState<'all' | 'incorrect' | 'marked'>('all');
  const [showTranscriptMap, setShowTranscriptMap] = useState<Record<string, boolean>>({});
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  // Audio speech synthesis ref
  const audioSpeechRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Checklist state for Test Day Preparation Guide
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({
    'item-1': false,
    'item-2': false,
    'item-3': false,
    'item-4': false,
    'item-5': false,
  });

  const currentSet: TestSet = (simulationData.test_sets as TestSet[])[selectedSetIndex] || simulationData.test_sets[0];

  // Active question pool
  const activeQuestions: Question[] = useMemo(() => {
    if (!currentSet || !currentSet.sections) return [];
    if (activeSectionId === 'all') {
      return currentSet.sections.flatMap((s) => s.questions);
    }
    const sec = currentSet.sections.find((s) => s.id === activeSectionId);
    return sec ? sec.questions : [];
  }, [currentSet, activeSectionId]);

  // Audio helper - safely stop
  const stopAudio = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  }, []);

  // Cleanup speech synthesis on unmount
  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

  // Start exam setup
  const startExam = (sectionId: string = 'all') => {
    stopAudio();
    setActiveSectionId(sectionId);
    let timeMinutes = 0;
    if (sectionId === 'all') {
      timeMinutes = currentSet.sections.reduce((acc, s) => acc + s.official_time_minutes, 0);
    } else {
      const targetSec = currentSet.sections.find((s) => s.id === sectionId);
      timeMinutes = targetSec ? targetSec.official_time_minutes : 30;
    }

    setSecondsRemaining(timeMinutes * 60);
    setTimerActive(true);
    setCurrentQIndex(0);
    setUserAnswers({});
    setMarkedQuestions({});
    setShowExplanationMap({});
    setShowTranscriptMap({});
    setViewState('exam');
  };

  // Timer countdown
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (timerActive && secondsRemaining > 0) {
      interval = setInterval(() => {
        setSecondsRemaining((prev) => {
          if (prev <= 1) {
            if (interval) clearInterval(interval);
            finishExam();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [timerActive, secondsRemaining]);

  const finishExam = () => {
    stopAudio();
    setTimerActive(false);
    setViewState('result');
  };

  const handleSelectOption = (qId: string, optionIndex: number) => {
    setUserAnswers((prev) => ({
      ...prev,
      [qId]: optionIndex + 1, // 1-indexed to match answers (1,2,3,4)
    }));
  };

  const toggleMarkQuestion = (qId: string) => {
    setMarkedQuestions((prev) => ({
      ...prev,
      [qId]: !prev[qId],
    }));
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Keyboard navigation & Shortcuts for Exam mode
  useEffect(() => {
    if (viewState !== 'exam') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is in an input/textarea
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      const currentQ = activeQuestions[currentQIndex];
      if (!currentQ) return;

      if (['1', '2', '3', '4'].includes(e.key)) {
        const optIdx = parseInt(e.key, 10) - 1;
        if (optIdx < currentQ.options.length) {
          handleSelectOption(currentQ.id, optIdx);
        }
      } else if (e.key.toLowerCase() === 'm') {
        toggleMarkQuestion(currentQ.id);
      } else if (e.key === 'ArrowRight' && currentQIndex < activeQuestions.length - 1) {
        stopAudio();
        setCurrentQIndex((prev) => prev + 1);
      } else if (e.key === 'ArrowLeft' && currentQIndex > 0) {
        stopAudio();
        setCurrentQIndex((prev) => prev - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewState, currentQIndex, activeQuestions, stopAudio]);

  // Audio playback for listening questions
  const playListeningAudio = (transcript: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      alert('Speech synthesis is not supported in your browser.');
      return;
    }
    if (isPlayingAudio) {
      stopAudio();
      return;
    }

    stopAudio();
    const cleanText = transcript.replace(/[母男女客社長吉田林リン山川学生店員]+：/g, ' ');
    const utter = new SpeechSynthesisUtterance(cleanText);
    const voice = getPreferredSpeechVoice(speechSettings);
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    } else {
      utter.lang = 'ja-JP';
    }
    utter.rate = 0.93; // exam-like pacing

    utter.onstart = () => setIsPlayingAudio(true);
    utter.onend = () => setIsPlayingAudio(false);
    utter.onerror = () => setIsPlayingAudio(false);

    audioSpeechRef.current = utter;
    window.speechSynthesis.speak(utter);
  };

  // Render question prompt with support for <u> underlines and rich markup
  const renderPrompt = (text: string) => {
    if (!text.includes('<u>')) {
      return <span>{text}</span>;
    }
    const parts = text.split(/(<u>.*?<\/u>)/g);
    return (
      <span>
        {parts.map((p, idx) => {
          if (p.startsWith('<u>') && p.endsWith('</u>')) {
            const inner = p.slice(3, -4);
            return (
              <span
                key={idx}
                className="underline decoration-primary decoration-2 underline-offset-4 font-black text-primary"
              >
                {inner}
              </span>
            );
          }
          return <span key={idx}>{p}</span>;
        })}
      </span>
    );
  };

  // Score calculations
  const totalQuestions = activeQuestions.length;
  const {
    correctCount,
    vocabCorrect,
    vocabTotal,
    gramCorrect,
    gramTotal,
    readCorrect,
    readTotal,
    listenCorrect,
    listenTotal,
  } = useMemo(() => {
    let cCount = 0;
    let vCorr = 0, vTot = 0;
    let gCorr = 0, gTot = 0;
    let rCorr = 0, rTot = 0;
    let lCorr = 0, lTot = 0;

    activeQuestions.forEach((q) => {
      const isCorrect = userAnswers[q.id] === q.correct_answer;
      if (isCorrect) cCount++;

      if (q.section === 'vocab') {
        vTot++;
        if (isCorrect) vCorr++;
      } else if (q.section === 'grammar') {
        gTot++;
        if (isCorrect) gCorr++;
      } else if (q.section === 'reading') {
        rTot++;
        if (isCorrect) rCorr++;
      } else if (q.section === 'listening') {
        lTot++;
        if (isCorrect) lCorr++;
      }
    });

    return {
      correctCount: cCount,
      vocabCorrect: vCorr,
      vocabTotal: vTot,
      gramCorrect: gCorr,
      gramTotal: gTot,
      readCorrect: rCorr,
      readTotal: rTot,
      listenCorrect: lCorr,
      listenTotal: lTot,
    };
  }, [activeQuestions, userAnswers]);

  // ---------------------------------------------------------------------------
  // JLPT N4 uses only TWO scoring blocks (N3 uses three):
  //   言語知識（文字・語彙・文法）・読解 = 120 marks, benchmark 38
  //   聴解                              =  60 marks, benchmark 19
  //   total 180 marks, pass mark 90
  // The written block is what this simulation scores; 聴解 ships as the bundled
  // listening practice items only — official listening recordings are not distributed.
  // ---------------------------------------------------------------------------
  const writtenTotal = vocabTotal + gramTotal + readTotal;
  const writtenCorrect = vocabCorrect + gramCorrect + readCorrect;
  const writtenScore = writtenTotal > 0 ? Math.round((writtenCorrect / writtenTotal) * 120) : 0;
  const listeningScore = listenTotal > 0 ? Math.round((listenCorrect / listenTotal) * 60) : null;
  const scaledScore = writtenScore + (listeningScore ?? 0);
  const langKnowledgeScore = writtenScore;

  // Passing criteria: written >= 38/120 AND overall >= 90/180.
  const isPassed = writtenScore >= 38 && scaledScore >= 90;

  // -------------------------------------------------------------
  // VIEW: 2026 Test Day Preparation Guidelines
  // -------------------------------------------------------------
  if (viewState === 'guidelines') {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-8 pb-28 md:px-8 md:py-12 md:pb-16 animate-fadeIn">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setViewState('intro')}
            className="text-xs uppercase font-bold tracking-wider px-3.5 py-2 rounded-xl border border-border bg-card hover:bg-accent transition inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Simulation
          </button>
          <span className="text-xs font-mono px-2.5 py-1 rounded bg-primary/10 text-primary font-semibold">
            Test-Day Protocol
          </span>
        </div>

        <div className="rounded-3xl border border-border bg-card p-6 md:p-10 shadow-lg">
          <div className="flex items-start gap-4 border-b border-border pb-6">
            <div className="rounded-2xl bg-primary/10 p-3.5 text-primary shrink-0">
              <Calendar className="h-7 w-7" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-black tracking-tight text-foreground">
                JLPT Exam Day Rules & Checklist (unofficial summary)
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                A plain-language summary of the public test-day rules. Always verify against the 受験案内 given by your test centre — the organisers' instructions always win.
              </p>
            </div>
          </div>

          <div className="mt-8 space-y-8">
            <div>
              <h3 className="text-lg font-bold flex items-center gap-2 text-foreground">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Physical Test-Day Packing Checklist (必需品チェックリスト)
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Tick each item as you pack your exam bag:
              </p>

              <div className="mt-4 grid gap-3">
                {[
                  { id: 'item-1', label: 'Test Voucher (受験票 - Jukenhyou)', desc: 'Official printed paper voucher with photo and examinee number. Digital display on phones is strictly prohibited.' },
                  { id: 'item-2', label: 'Original Photo ID (本人確認書類)', desc: 'Residence Card (在留カード), Valid Passport, My Number Card, or Japanese Driver License. Must be original, physical, and unexpired.' },
                  { id: 'item-3', label: 'Medium-Soft Pencils (HB or 2B)', desc: 'Mechanical or wooden HB / 2B pencils only. Ballpoint pens, gel pens, or highlighters will invalidate optical mark sheets.' },
                  { id: 'item-4', label: 'High-Quality Plastic Eraser (プラスチック消しゴム)', desc: 'Clean white plastic eraser to cleanly erase any pencil marks without smudging optical bubbles.' },
                  { id: 'item-5', label: 'Analog Wristwatch (アナログ時計)', desc: 'Watch with simple hands only. Smartwatches, fitness bands, Apple Watches, alarms, and audible ticking are strictly barred.' }
                ].map((item) => (
                  <label
                    key={item.id}
                    className={`flex items-start gap-3.5 p-4 rounded-2xl border transition cursor-pointer select-none ${
                      checkedItems[item.id] ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-border bg-background hover:border-muted-foreground/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={!!checkedItems[item.id]}
                      onChange={() => setCheckedItems((p) => ({ ...p, [item.id]: !p[item.id] }))}
                      className="mt-1 h-5 w-5 rounded border-border text-emerald-600 focus:ring-emerald-500"
                    />
                    <div>
                      <p className={`font-bold text-sm ${checkedItems[item.id] ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                        {item.label}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
              <h3 className="text-base font-bold text-destructive flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                Zero-Tolerance Electronic & Mobile Phone Regulations
              </h3>
              <ul className="mt-3 space-y-2 text-xs md:text-sm text-foreground/90 list-disc list-inside">
                <li>
                  <strong>Envelope Sealing Rule:</strong> Immediately upon entering the test room, all cellphones, smartphones, smart bands, and alarms must be powered completely OFF and sealed inside the official paper pouch provided by proctors.
                </li>
                <li>
                  <strong>Immediate Expulsion:</strong> If any device emits a vibration, ring, alert sound, or screen glow at any point (even inside a backpack or jacket), your test is instantly cancelled with a grade of zero.
                </li>
                <li>
                  <strong>Listening Room Lockout:</strong> During the Listening (聴解) section, doors lock the exact moment the test audio begins. No late entry or bathroom exits are allowed under any circumstances.
                </li>
              </ul>
            </div>

            <div>
              <h3 className="text-lg font-bold flex items-center gap-2 text-foreground">
                <Award className="h-5 w-5 text-amber-500" />
                N4 Timings & Sectional Pass Matrix (per JLPT published guidelines)
              </h3>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-2xl border border-border bg-background text-center">
                  <p className="text-xs text-muted-foreground font-mono uppercase">1. 言語知識（文字・語彙）</p>
                  <p className="text-2xl font-black text-foreground mt-1">30 Minutes</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Kanji & Vocabulary</p>
                </div>
                <div className="p-4 rounded-2xl border border-border bg-background text-center">
                  <p className="text-xs text-muted-foreground font-mono uppercase">2. 言語知識（文法）・読解</p>
                  <p className="text-2xl font-black text-foreground mt-1">55 Minutes</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Grammar & Reading</p>
                </div>
                <div className="p-4 rounded-2xl border border-border bg-background text-center">
                  <p className="text-xs text-muted-foreground font-mono uppercase">3. 聴解 (Listening)</p>
                  <p className="text-2xl font-black text-foreground mt-1">35 Minutes</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Practise separately — not scored in this run</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-border flex justify-end">
            <button
              onClick={() => {
                setViewState('intro');
                startExam('all');
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 font-bold text-primary-foreground shadow-md hover:bg-primary/90 transition"
            >
              Start Full Written Simulation
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: Exam In Progress
  // -------------------------------------------------------------
  if (viewState === 'exam') {
    const q = activeQuestions[currentQIndex];
    if (!q) return null;
    const isMarked = markedQuestions[q.id];
    const currentAnswer = userAnswers[q.id];
    const isListening = q.section === 'listening';
    const isLowTime = secondsRemaining > 0 && secondsRemaining < 300; // < 5 mins

    return (
      <div className="mx-auto max-w-[1020px] px-4 py-6 pb-28 md:px-8 md:py-8 md:pb-16 animate-fadeIn">
        {/* Status & Timer Bar */}
        <div className={`sticky top-3 z-30 mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 shadow-md backdrop-blur transition-all ${
          isLowTime ? 'border-destructive bg-destructive/10 text-destructive' : 'border-border bg-card/95'
        }`}>
          <div className="flex items-center gap-2.5">
            <span className="rounded-lg bg-primary/10 px-3 py-1 text-xs font-bold text-primary uppercase">
              {isListening ? '聴解 LISTENING' : q.section.toUpperCase()}
            </span>
            <span className="text-xs text-muted-foreground hidden sm:inline font-medium">
              {currentSet.name}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 rounded-xl px-3.5 py-1.5 font-mono text-sm font-bold border transition ${
              isLowTime
                ? 'border-destructive bg-destructive text-destructive-foreground animate-pulse'
                : 'border-border bg-background text-foreground'
            }`}>
              <Clock className="h-4 w-4" />
              <span>{formatTime(secondsRemaining)}</span>
            </div>

            <button
              onClick={() => {
                if (window.confirm('Are you sure you want to finish and submit your exam now?')) {
                  finishExam();
                }
              }}
              className="rounded-xl bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 transition shadow-sm"
            >
              Submit Exam
            </button>
          </div>
        </div>

        {/* Exam Hotkeys Hint Bar */}
        <div className="mb-4 hidden md:flex items-center justify-between text-[11px] text-muted-foreground bg-muted/40 px-4 py-2 rounded-xl border border-border">
          <span className="font-semibold">⚡ Exam Shortcuts:</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono font-bold">1</kbd>-<kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono font-bold">4</kbd> Select Option</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono font-bold">M</kbd> Mark Question</span>
          <span><kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono font-bold">←</kbd> / <kbd className="px-1.5 py-0.5 rounded bg-background border border-border font-mono font-bold">→</kbd> Prev/Next Question</span>
        </div>

        {/* Main question card */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-3 space-y-6">
            <div className="rounded-3xl border border-border bg-card p-6 md:p-8 shadow-sm">
              {/* Question metadata badge */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-md bg-secondary text-secondary-foreground">
                    Question {currentQIndex + 1} of {totalQuestions}
                  </span>
                  <span className="text-xs font-semibold text-muted-foreground">
                    {q.mondai}
                  </span>
                </div>
                <button
                  onClick={() => toggleMarkQuestion(q.id)}
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border transition ${
                    isMarked ? 'border-amber-500 bg-amber-500/10 text-amber-600' : 'border-border hover:bg-muted text-muted-foreground'
                  }`}
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                  {isMarked ? 'Review Marked (M)' : 'Mark for Review (M)'}
                </button>
              </div>

              {/* Instructions */}
              {q.mondai_instruction && (
                <div className="mt-4 rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground font-medium">
                  {q.mondai_instruction}
                </div>
              )}

              {/* Listening Audio Control Box */}
              {isListening && q.transcript && (
                <div className="mt-5 rounded-2xl border border-primary/30 bg-primary/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2.5 rounded-xl bg-primary text-primary-foreground">
                        <Headphones className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-foreground">Listening Playback (browser voice)</p>
                        <p className="text-[11px] text-muted-foreground">Press play to listen to native dialogue & question prompt</p>
                      </div>
                    </div>

                    <button
                      onClick={() => playListeningAudio(q.transcript || '')}
                      className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground shadow-sm hover:bg-primary/90 transition"
                    >
                      {isPlayingAudio ? (
                        <>
                          <Pause className="h-4 w-4" /> Stop Audio
                        </>
                      ) : (
                        <>
                          <Play className="h-4 w-4" /> Listen to Audio
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Reading Passage */}
              {q.passage && (
                <div className="mt-5 rounded-2xl border border-border/80 bg-background/60 p-5 text-sm md:text-base leading-relaxed whitespace-pre-wrap font-sans">
                  {q.passage}
                </div>
              )}

              {/* Question Prompt with Underline */}
              <div className="mt-6">
                <h2 className="text-lg md:text-xl font-bold text-foreground leading-relaxed">
                  {renderPrompt(q.prompt)}
                </h2>
              </div>

              {/* Options */}
              <div className="mt-6 space-y-3">
                {q.options.map((opt, idx) => {
                  const optionNum = idx + 1;
                  const isSelected = currentAnswer === optionNum;
                  return (
                    <button
                      key={idx}
                      onClick={() => handleSelectOption(q.id, idx)}
                      className={`w-full flex items-center justify-start gap-4 p-4 rounded-2xl border text-left transition-all ${
                        isSelected
                          ? 'border-primary bg-primary/10 text-foreground ring-2 ring-primary/20 font-semibold'
                          : 'border-border bg-background hover:border-primary/50 text-foreground/90'
                      }`}
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold border transition ${
                        isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-muted/30 text-muted-foreground'
                      }`}>
                        {optionNum}
                      </span>
                      <span className="text-sm md:text-base">{opt}</span>
                    </button>
                  );
                })}
              </div>

              {/* Bottom Nav */}
              <div className="mt-8 pt-6 border-t border-border flex items-center justify-between">
                <button
                  disabled={currentQIndex === 0}
                  onClick={() => {
                    stopAudio();
                    setCurrentQIndex((p) => p - 1);
                  }}
                  className="px-4 py-2 text-xs font-bold rounded-xl border border-border bg-background hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition inline-flex items-center gap-1.5"
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </button>
                <span className="text-xs font-mono text-muted-foreground">
                  {Object.keys(userAnswers).length} / {totalQuestions} answered
                </span>
                <button
                  disabled={currentQIndex === totalQuestions - 1}
                  onClick={() => {
                    stopAudio();
                    setCurrentQIndex((p) => p + 1);
                  }}
                  className="px-5 py-2 text-xs font-bold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:pointer-events-none transition flex items-center gap-1.5 shadow-sm"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Quick Palette */}
          <div className="lg:col-span-1">
            <div className="rounded-3xl border border-border bg-card p-5 shadow-sm sticky top-24">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Question Grid
              </h3>
              <div className="mt-3 grid grid-cols-5 gap-2 max-h-[380px] overflow-y-auto p-1">
                {activeQuestions.map((item, idx) => {
                  const answered = userAnswers[item.id] !== undefined;
                  const marked = markedQuestions[item.id];
                  const isCurrent = currentQIndex === idx;

                  let colorClass = 'border-border bg-background text-muted-foreground';
                  if (answered) colorClass = 'border-primary/50 bg-primary/10 text-primary font-bold';
                  if (marked) colorClass = 'border-amber-500 bg-amber-500/20 text-amber-600 font-bold';
                  if (isCurrent) colorClass += ' ring-2 ring-primary';

                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        stopAudio();
                        setCurrentQIndex(idx);
                      }}
                      className={`h-9 w-full rounded-xl text-xs font-mono flex items-center justify-center border transition ${colorClass}`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 pt-4 border-t border-border space-y-2 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-primary/20 border border-primary/50"></span>
                  <span>Answered</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-amber-500/20 border border-amber-500"></span>
                  <span>Marked for review</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-background border border-border"></span>
                  <span>Unanswered</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: Exam Results
  // -------------------------------------------------------------
  if (viewState === 'result') {
    const filteredQuestions = activeQuestions.filter((q) => {
      const isCorrect = userAnswers[q.id] === q.correct_answer;
      if (filterResult === 'incorrect') return !isCorrect;
      if (filterResult === 'marked') return !!markedQuestions[q.id];
      return true;
    });

    return (
      <div className="mx-auto max-w-[960px] px-4 py-8 pb-28 md:px-8 md:py-12 md:pb-16 animate-fadeIn">
        <div className={`rounded-3xl border p-6 md:p-8 text-center shadow-lg transition ${
          isPassed ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-destructive/40 bg-destructive/10'
        }`}>
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl mb-4 shadow-sm bg-card">
            {isPassed ? <Award className="h-9 w-9 text-emerald-500" /> : <XCircle className="h-9 w-9 text-destructive" />}
          </div>

          <h2 className="text-2xl md:text-3xl font-black text-foreground">
            {isPassed ? 'JLPT N4 PASS (合格) — Simulation Cleared!' : 'JLPT N4 DID NOT PASS (不合格)'}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground max-w-xl mx-auto">
            {isPassed
              ? 'Congratulations! You cleared the N4 written benchmarks: ≥ 38/120 on 言語知識（文字・語彙・文法）・読解 and ≥ 90/180 overall.'
              : 'Review your breakdown below. To pass the JLPT N4 you need at least 38/120 on 言語知識（文字・語彙・文法）・読解 AND at least 90/180 overall — on test day you also need ≥ 19/60 on 聴解.'}
          </p>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto">
            <div className="p-3.5 rounded-2xl border border-border bg-card text-center">
              <p className="text-[11px] font-mono text-muted-foreground uppercase">言語知識・読解 (Written)</p>
              <p className="text-2xl font-black text-foreground mt-1">{writtenScore} / 120</p>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${writtenScore >= 38 ? 'bg-emerald-500/20 text-emerald-600' : 'bg-destructive/20 text-destructive'}`}>
                Benchmark ≥ 38
              </span>
            </div>

            <div className="p-3.5 rounded-2xl border border-border bg-card text-center">
              <p className="text-[11px] font-mono text-muted-foreground uppercase">聴解 (Listening)</p>
              <p className="text-2xl font-black text-foreground mt-1">{listeningScore === null ? 'Not scored' : `${listeningScore}/60`}</p>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Benchmark ≥ 19
              </span>
            </div>

            <div className="p-3.5 rounded-2xl border border-border bg-card text-center">
              <p className="text-[11px] font-mono text-muted-foreground uppercase">Overall (written)</p>
              <p className="text-2xl font-black text-foreground mt-1">{scaledScore} / 180</p>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${scaledScore >= 90 ? 'bg-emerald-500/20 text-emerald-600' : 'bg-destructive/20 text-destructive'}`}>
                Pass req: 90
              </span>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => setViewState('intro')}
              className="px-5 py-2.5 rounded-xl border border-border bg-background hover:bg-muted font-bold text-xs transition"
            >
              Choose Another Simulation / Section
            </button>
            <button
              onClick={() => startExam(activeSectionId)}
              className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-xs transition flex items-center gap-1.5 shadow-sm"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retake Section
            </button>
          </div>
        </div>

        {/* Detailed Answer Key & Review */}
        <div className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
            <div>
              <h3 className="text-xl font-black text-foreground">Answer Explanations</h3>
              <p className="text-xs text-muted-foreground">Comprehensive Japanese explanations and complete listening scripts.</p>
            </div>

            <div className="flex items-center gap-1.5 rounded-xl border border-border p-1 bg-card text-xs">
              <button
                onClick={() => setFilterResult('all')}
                className={`px-3 py-1 rounded-lg font-semibold transition ${filterResult === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                All ({activeQuestions.length})
              </button>
              <button
                onClick={() => setFilterResult('incorrect')}
                className={`px-3 py-1 rounded-lg font-semibold transition ${filterResult === 'incorrect' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Incorrect ({totalQuestions - correctCount})
              </button>
              <button
                onClick={() => setFilterResult('marked')}
                className={`px-3 py-1 rounded-lg font-semibold transition ${filterResult === 'marked' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Marked ({Object.keys(markedQuestions).filter((k) => markedQuestions[k]).length})
              </button>
            </div>
          </div>

          <div className="space-y-4">
            {filteredQuestions.map((q) => {
              const userAns = userAnswers[q.id];
              const isCorrect = userAns === q.correct_answer;
              const isExpanded = showExplanationMap[q.id];
              const isTranscriptShown = showTranscriptMap[q.id];

              return (
                <div
                  key={q.id}
                  className={`rounded-2xl border p-5 transition bg-card ${
                    isCorrect ? 'border-border' : 'border-destructive/30 bg-destructive/5'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        isCorrect ? 'bg-emerald-500/20 text-emerald-600' : 'bg-destructive/20 text-destructive'
                      }`}>
                        {isCorrect ? '✓' : '✗'}
                      </span>
                      <span className="font-mono text-xs font-bold text-muted-foreground">
                        {q.mondai}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-medium">
                        Your answer: <strong>{userAns ? `[${userAns}]` : 'None'}</strong>
                      </span>
                      <span className="text-xs font-bold text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded">
                        Correct: [{q.correct_answer}]
                      </span>
                    </div>
                  </div>

                  {q.transcript && (
                    <div className="mt-3">
                      <button
                        onClick={() => setShowTranscriptMap((p) => ({ ...p, [q.id]: !p[q.id] }))}
                        className="text-xs font-bold text-amber-600 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1 rounded-lg transition inline-flex items-center gap-1.5"
                      >
                        <Headphones className="h-3.5 w-3.5" />
                        {isTranscriptShown ? 'Hide Audio Transcript' : 'Show Listening Audio Transcript (聴解スクリプト)'}
                      </button>

                      {isTranscriptShown && (
                        <div className="mt-2 p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed font-sans">
                          {q.transcript}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-3 text-sm font-bold text-foreground">
                    {renderPrompt(q.prompt)}
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    {q.options.map((opt, oIdx) => {
                      const num = oIdx + 1;
                      const isOptionCorrect = num === q.correct_answer;
                      const isUserChoice = num === userAns;

                      let optClass = 'border-border bg-background text-foreground/80';
                      if (isOptionCorrect) optClass = 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 font-bold';
                      else if (isUserChoice) optClass = 'border-destructive/60 bg-destructive/10 text-destructive font-semibold';

                      return (
                        <div key={oIdx} className={`p-2.5 rounded-xl border flex items-center gap-2 ${optClass}`}>
                          <span className="font-mono font-bold">[{num}]</span>
                          <span>{opt}</span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                    <button
                      onClick={() => setShowExplanationMap((p) => ({ ...p, [q.id]: !p[q.id] }))}
                      className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
                    >
                      <Eye className="h-3 w-3" />
                      {isExpanded ? 'Hide Explanation' : 'View Explanation (解説)'}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 p-3.5 rounded-xl bg-muted/60 text-xs text-foreground/90 leading-relaxed font-sans border border-border">
                      <p className="font-bold text-primary mb-1">【解説・ポイント】</p>
                      {q.explanation}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW: Simulation Selection & Section Dashboard (Intro)
  // -------------------------------------------------------------
  return (
    <div className="mx-auto max-w-[1000px] px-5 py-8 pb-28 md:px-10 md:py-12 md:pb-16 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-xs font-extrabold uppercase tracking-wider px-2.5 py-1 rounded bg-primary/15 text-primary">
              N4 Mock Simulation
            </span>
            <span className="text-xs font-bold text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> N4 Timings & Guidelines
            </span>
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-black tracking-tight text-foreground">
            N4-Format Mock Examination
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Choose between full written-exam mode or a single timed section (文字・語彙 30分 / 文法・読解 55分) with proper underlines and N4 passing-score evaluation. Questions are original items written in the published N4 format — official exam papers are not redistributed here.
          </p>
        </div>

        <div>
          <button
            onClick={() => setViewState('guidelines')}
            className="inline-flex items-center gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-700 hover:bg-amber-500/20 transition shadow-sm"
          >
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            2026 Test Rules & Checklist
          </button>
        </div>
      </div>

      <SimulationSpeechVoice />

      {/* Test Set Selector */}
      <div className="mt-8">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          1. Choose Mock Set
        </h2>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {(simulationData.test_sets as TestSet[]).map((set, idx) => {
            const isSelected = selectedSetIndex === idx;
            const totalQs = set.sections.reduce((acc, s) => acc + s.questions.length, 0);
            return (
              <div
                key={set.id}
                onClick={() => setSelectedSetIndex(idx)}
                className={`p-6 rounded-3xl border transition cursor-pointer flex flex-col justify-between ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/20 shadow-md'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold text-primary px-2.5 py-1 rounded bg-primary/10">
                      EXAM PAPER #{idx + 1}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {totalQs} questions
                    </span>
                  </div>
                  <h3 className="mt-3 font-bold text-base md:text-lg text-foreground">
                    {set.name}
                  </h3>
                  <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                    {set.description}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                      <a
                        href="https://www.jlpt.jp/e/samples/forlearners.html"
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-[11px] font-bold text-primary hover:bg-primary/15 transition"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        Official sample questions (jlpt.jp)
                      </a>
                      <span className="text-[11px] font-mono text-muted-foreground">
                        original questions · 問題Ⅰ〜Ⅹ layout
                      </span>
                    </div>
                </div>

                <div className="mt-5 pt-4 border-t border-border flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
                    <span className="flex items-center gap-1 font-mono">
                      {set.sections.length} Sections
                    </span>
                  </div>

                  <span className={`text-xs font-bold ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}>
                    {isSelected ? '● Selected' : 'Select'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section Selector */}
      <div className="mt-8">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          2. Select Test Mode & Timings
        </h2>

        <p className="text-xs text-muted-foreground mt-1">
          Take the whole written exam together, or practise one section with its exact JLPT timer:
        </p>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Full Test Option */}
          <div
            onClick={() => startExam('all')}
            className="p-5 rounded-2xl border border-primary bg-primary/5 hover:bg-primary/10 cursor-pointer transition flex flex-col justify-between group shadow-sm"
          >
            <div>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-primary text-primary-foreground">
                ALL SECTIONS
              </span>

              <h3 className="mt-2 font-black text-sm text-foreground group-hover:text-primary transition">
                Full Mock
              </h3>

              <p className="mt-1 text-xs text-muted-foreground">
                Both written sections combined under real conditions
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-primary/20 flex items-center justify-between text-xs font-bold text-primary">
              <span>85 min</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </div>
          </div>

          {/* Individual Sections */}
          {currentSet.sections.map((sec) => (
            <div
              key={sec.id}
              onClick={() => startExam(sec.id)}
              className="p-5 rounded-2xl border border-border bg-card hover:border-primary/50 hover:bg-accent/40 cursor-pointer transition flex flex-col justify-between group shadow-sm"
            >
              <div>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-secondary text-secondary-foreground">
                  {sec.id.toUpperCase()}
                </span>

                <h3 className="mt-2 font-bold text-sm text-foreground group-hover:text-primary transition">
                  {sec.name}
                </h3>

                <p className="mt-1 text-xs text-muted-foreground">
                  {sec.questions.length} questions ({sec.english_name})
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs font-semibold text-muted-foreground group-hover:text-primary">
                <span className="font-mono font-bold">
                  {sec.official_time_minutes} min timer
                </span>

                <ArrowRight className="h-3.5 w-3.5" />
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}