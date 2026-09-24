import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight,
  ClipboardCheck,
  Clock,
  FileText,
  GraduationCap,
  Headphones,
  Layers,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { readExamDayRecord as readN2ExamDayRecord, type ExamDayRecord } from '@/lib/n2ExamDay';
import { readExamDayRecord as readN1ExamDayRecord } from '@/lib/n1ExamDay';
import { SimulationSpeechVoice } from '@/components/SimulationSpeechVoice';

type Sim = {
  href: string;
  level: 'N1' | 'N2' | 'N3' | 'N4';
  title: string;
  tagline: string;
  sets: string;
  questions: string;
  timings: Array<[string, string]>;
  pass: string;
  features: string[];
  accent: string;   // tailwind classes for the level chip
  ring: string;     // tailwind classes for the card border/ring
};

const SIMULATIONS: Sim[] = [
  {
    href: '/jlpt-simulation/n1',
    level: 'N1',
    title: 'N1 Written Mock Simulation',
    tagline:
      'The N1 written paper (言語知識（文字・語彙・文法）・読解, 110分) as one timed sitting, built from original practice banks in the published 問題1〜13 layout with scored breakdown, per-block 基準点 and answer explanations. 聴解 is sat separately below it as a 55-minute original block played with the browser voice.',
    sets: '3 practice papers',
    questions: '204 auto-scored questions',
    timings: [
      ['言語知識・読解', '110分'],
      ['聴解', '55分'],
      ['Exam day total', '165分'],
    ],
    pass: '90 / 180 · 19 per block',
    features: [
      'Published three-block scoring (言語知識 60 / 読解 60 / 聴解 60)',
      'Written paper scored out of 120 with 基準点 ≥ 19 per block',
      'Original 聴解 block, browser-voice audio (問題1〜5, 30 items, 55分)',
      'Mark-for-review, question grid and explanations',
    ],
    accent: 'bg-rose-500/15 text-rose-700',
    ring: 'hover:border-rose-500/50',
  },
  {
    href: '/jlpt-simulation/n2',
    level: 'N2',
    title: 'N2 Written Mock Simulation',
    tagline:
      'The N2 written paper (言語知識（文字・語彙・文法）・読解, 105分) as one timed sitting, built from original practice banks in the published 問題1〜14 layout with scored breakdown, per-block 基準点 and answer explanations. 聴解 is sat separately below it as a 50-minute original listening block played with the browser voice.',
    sets: '3 practice papers',
    questions: '154 auto-scored questions',
    timings: [
      ['言語知識・読解', '105分'],
      ['聴解', '50分'],
      ['Exam day total', '155分'],
    ],
    pass: '90 / 180 · 19 per block',
    features: [
      'Published three-block scoring (言語知識 60 / 読解 60 / 聴解 60)',
      'Written paper scored out of 120 with 基準点 ≥ 19 per block',
      'Original 聴解 block, browser-voice audio (scored /60)',
      'Mark-for-review, question grid and explanations',
    ],
    accent: 'bg-emerald-500/15 text-emerald-700',
    ring: 'hover:border-emerald-500/50',
  },
  {
    href: '/jlpt-simulation/n3',
    level: 'N3',
    title: 'N3 Mock Exam Simulation',
    tagline:
      'N3 mock exams in the published 問題1〜問題7 layout: 言語知識（文字・語彙）30分 and 言語知識（文法）・読解 70分, with scored result breakdown and answer explanations. 聴解 is practised with the browser voice — official recordings are not distributed here.',
    sets: '2 original mock sets',
    questions: '≈ 109 auto-scored questions',
    timings: [
      ['文字・語彙', '30分'],
      ['文法・読解', '70分'],
      ['聴解', '40分'],
    ],
    pass: '95 / 180 · each section ≥ 19',
    features: [
      'Per-section or full-exam timer (140 min)',
      'Auto-scored with explanations',
      '聴解 practice with browser-voice playback',
      'Mark-for-review + test-day equipment checklist',
    ],
    accent: 'bg-amber-500/15 text-amber-700',
    ring: 'hover:border-amber-500/50',
  },
  {
    href: '/jlpt-simulation/n4',
    level: 'N4',
    title: 'Mock N4 Exam Simulation',
    tagline:
      'Four original N4-format practice sets (2021-07・2021-12・2025-07・2025-12 style) written for this app, each a scored 問題Ⅰ〜Ⅹ simulation with timings, underlines and answer explanations.',
    sets: '4 original mock sets',
    questions: '≈ 190 auto-scored questions',
    timings: [
      ['文字・語彙', '30分'],
      ['文法・読解', '55分'],
      ['聴解', '35分'],
    ],
    pass: '90 / 180 · 読解・文法 ≥ 38 · 聴解 ≥ 19',
    features: [
      'N4 two-block scoring (120 + 60)',
      'Original questions, no official papers bundled',
      'Pass-mark logic: 90/180 · written ≥ 38 · 聴解 ≥ 19',
      '聴解 practice items included',
    ],
    accent: 'bg-sky-500/15 text-sky-700',
    ring: 'hover:border-sky-500/50',
  },
];

export function JlptSimulationHub() {
  const [examDay, setExamDay] = useState<ExamDayRecord | null>(null);
  const [examDayN1, setExamDayN1] = useState<ExamDayRecord | null>(null);

  useEffect(() => {
    setExamDay(readN2ExamDayRecord());
    setExamDayN1(readN1ExamDayRecord());
  }, []);

  const renderExamDayLatest = (level: 'N1' | 'N2', record: ExamDayRecord | null) => {
    const tone =
      level === 'N1'
        ? 'border-rose-500/30 bg-rose-500/5'
        : 'border-emerald-500/30 bg-emerald-500/5';
    const linkTone =
      level === 'N1' ? 'text-rose-700' : 'text-emerald-700';
    const listeningLine =
      level === 'N1' ? '聴解 60分 (2022-12は55分)' : '聴解 50分';
    const writtenLine = level === 'N1' ? '言語知識・読解 110分' : '言語知識・読解 105分';
    return (
      <div
        className={`mt-4 rounded-xl border p-3 text-xs ${tone}`}
        data-testid={`${level.toLowerCase()}-exam-day-latest`}
      >
        {record ? (
          <>
            <p className="font-bold text-foreground">
              Latest exam day: {record.total} / 180 ·{' '}
              {record.passed ? '合格 (Pass)' : '不合格 (Fail)'}
            </p>
            <p className="mt-1 text-muted-foreground">
              言語知識 {record.blocks.language}/60 · 読解 {record.blocks.reading}/60 · 聴解{' '}
              {record.blocks.listening}/60 — {record.sittingLabel} 聴解
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            No full exam day yet — sit {writtenLine} then {listeningLine} for one 合否 verdict.
          </p>
        )}
        <Link
          href={`/jlpt-simulation/${level.toLowerCase()}/exam-day`}
          className={`mt-2 inline-flex items-center gap-1 font-bold hover:underline ${linkTone}`}
          data-testid={`open-exam-day-${level}`}
        >
          Start {level} exam day <ArrowRight size={12} />
        </Link>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-[1080px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="page-jlpt-simulation">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-[1.75rem] border border-border bg-card p-6 md:p-9">
        <div className="absolute -right-16 -top-16 size-56 rounded-full border-[26px] border-[hsl(var(--accent)/.18)]" />
        <div className="relative">
          <span className="mono-label inline-flex items-center gap-2 rounded-full bg-[hsl(var(--primary))] px-3 py-1.5 text-[hsl(var(--primary-foreground))]">
            <GraduationCap size={13} /> Exam hall
          </span>
          <h1 className="mt-5 font-serif text-4xl tracking-[-.03em] md:text-5xl">JLPT Simulation</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
            Sit a full-length mock — exam-accurate section timings, original question banks, pass/fail benchmark logic and a
            full answer review. Pick your level below.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5">
              <Layers size={13} /> 4 levels available
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5">
              <ShieldCheck size={13} /> Exam scoring rules
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5">
              <FileText size={13} /> Exam-accurate format
            </span>
          </div>
          <SimulationSpeechVoice />
        </div>
      </section>

      {/* Level cards */}
      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        {SIMULATIONS.map((sim) => (
          <article
            key={sim.href}
            className={`flex flex-col justify-between rounded-[1.5rem] border border-border bg-card p-6 transition md:p-7 ${sim.ring}`}
            data-testid={`sim-card-${sim.level}`}
          >
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-black ${sim.accent}`}>
                  <ClipboardCheck size={15} /> {sim.level}
                </span>
                <span className="font-mono text-[11px] uppercase text-muted-foreground">{sim.sets}</span>
              </div>

              <h2 className="mt-4 font-serif text-2xl tracking-[-.02em]">{sim.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{sim.tagline}</p>

              <div className="mt-5 grid grid-cols-3 gap-2">
                {sim.timings.map(([label, time]) => (
                  <div key={label} className="rounded-xl border border-border bg-muted/40 p-3 text-center">
                    <p className="text-[10px] font-mono uppercase text-muted-foreground">{label}</p>
                    <p className="mt-1 text-sm font-bold">{time}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Target size={13} /> {sim.questions}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={13} /> Pass: {sim.pass}
                </span>
                {sim.level === 'N3' && (
                  <span className="inline-flex items-center gap-1.5">
                    <Headphones size={13} /> Audio listening
                  </span>
                )}
              </div>

              <ul className="mt-5 space-y-2 text-xs leading-5 text-muted-foreground">
                {sim.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[hsl(var(--accent))]" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>

            {sim.level === 'N1' && renderExamDayLatest('N1', examDayN1)}
            {sim.level === 'N2' && renderExamDayLatest('N2', examDay)}

            <Link
              href={sim.href}
              className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3.5 text-sm font-bold text-[hsl(var(--primary-foreground))] transition-transform hover:-translate-y-0.5"
              data-testid={`open-sim-${sim.level}`}
            >
              Open {sim.level} simulation <ArrowRight size={16} />
            </Link>
          </article>
        ))}
      </div>

      {/* Notes */}
      <section className="mt-8 rounded-2xl border border-border bg-muted/30 p-5 text-xs leading-6 text-muted-foreground md:p-6">
        <p className="font-bold text-foreground">How the N1 sets work</p>
        <p className="mt-2">
          The N1 simulation covers the written paper only (110 minutes, 68 questions in the published
          問題1〜13 layout — 漢字の読み・漢字の表記・語の知識・文脈上の語, then 文法形式・文の組み立て・文法内容,
          then 短文理解・長文理解・情報検索・総合理解・主張理解・計算・その他). Each of the three sets
          (2019年12月 / 2022年7月 / 2022年12月 style) is an original practice bank written for this app —
          the sitting name is a format reference only. 聴解 is sat separately as an original 30-item block
          (問題1〜5, 55分) played with the browser voice, and the full 合否 is decided on the exam day page.
        </p>
      </section>

      <section className="mt-6 rounded-2xl border border-border bg-muted/30 p-5 text-xs leading-6 text-muted-foreground md:p-6">
        <p className="font-bold text-foreground">How the N2 sets work</p>
        <p className="mt-2">
          The N2 simulation covers the written paper only. Each of the three sets (2022年12月 / 2023年12月 / 2024年7月
          style) is an <strong className="text-foreground">original</strong> practice bank written for this app in the
          published 問題1〜14 layout — 漢字読み・表記・語形成・文脈規定・言い換え類義・用法, then 文法形式の判断・
          文の組み立て・文章の文法, then 内容理解（短文／中文）・統合理解・主張理解・情報検索. The sitting name is a
          format reference only: no JEES / Japan Foundation paper is reproduced or re-hosted here.
        </p>
        <p className="mt-3">
          N2 is scored in three 60-mark blocks with a 19-point 基準点 in each and a 90/180 pass mark. This
          simulation scores 言語知識 and 読解 (120 marks, 基準点 38 combined) and reports 聴解 as
          <strong className="text-foreground"> not taken</strong> — so it tells you whether the written paper is
          on track, while the full 合否 verdict still needs a real listening paper.
        </p>
      </section>

      <section className="mt-6 rounded-2xl border border-border bg-muted/30 p-5 text-xs leading-6 text-muted-foreground md:p-6">
        <p className="font-bold text-foreground">How the N4 sets work</p>
        <p className="mt-2">
          Each N4 set is an <strong className="text-foreground">original</strong> question bank written in the
          publicly documented N4 format, so the 文字・語彙 and 文法・読解 sections can be auto-scored
          with timings and pass marks. No official JEES / Japan Foundation papers or recordings are bundled or
          re-hosted. Want the organisers' own material? Use their free sample questions and the official practice
          workbooks at
          <a className="font-semibold text-[hsl(var(--primary))] underline" href="https://www.jlpt.jp/e/samples/forlearners.html" target="_blank" rel="noreferrer"> jlpt.jp/samples</a>.
        </p>
        <p className="mt-3">
          N4 scores as two blocks, not three: 言語知識（文字・語彙・文法）・読解 is worth 120 marks (benchmark 38)
          and 聴解 is worth 60 marks (benchmark 19), with an overall pass mark of 90/180. The 聴解 sections are
          paper-only here, so the simulation scores the 120-mark written block and reports the overall
          out of 180 accordingly.
        </p>
      </section>
    </div>
  );
}
