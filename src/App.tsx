import { BulkWordImport } from '@/components/BulkWordImport';
import { commitBulkImport } from '@/lib/bulkImportStore';
import { MAX_SAVE_SLOTS, isQuizReadyWord, type BulkImportRequest, type BulkImportResult } from '@/lib/bulkWordImport';
import { CardReview } from '@/components/CardReview';
import { CardProgressProvider, DiscoveryFilterControl, DiscoverySummary, OpenedCardBadge, useCardProgress } from '@/components/CardProgress';
import { filterDiscovered, parseDiscoveryFilter, type DiscoveryFilter, wordProgressKey, jlptProgressKey } from '@/lib/cardProgress';
import Login from '@/auth/Login';
import ForgotPassword from '@/auth/ForgotPassword';
import ResetPassword from '@/auth/ResetPassword';
import { AuthProvider, useAuth } from '@/auth/useAuth';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar, CartesianGrid } from 'recharts';
import { api, ApiError, type MePayload } from '@/lib/api';
import { usePoll } from '@/hooks/usePoll';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Redirect, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import {
  ArrowRight, BookOpen, BookPlus, Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Coins, Filter, RefreshCw, Shuffle,
  FolderOpen, Gift, Headphones, Heart, Home, Keyboard, Layers3, LogOut,
  Pencil, Play, Plus, RotateCcw, Search, Sparkles, Star, Target, Trash2,
  ListChecks, Trophy, TrendingUp, UserPlus, Users, Volume2, X, Zap, GraduationCap, ClipboardCheck, Crown,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { CreditsFooter } from '@/components/CreditsFooter';
import { SoundMuteButton, SoundSettings } from '@/components/SoundSettings';
import { RankedActive, RankedSetup } from '@/components/RankedMode';
import { RankedRoomPage } from '@/pages/RankedRoomPage';
import { RankedLeaderboard } from '@/components/RankedLeaderboard';
import { RankedBattlePage } from '@/pages/RankedBattlePage';
import { FinishPopupProvider, GlobalFinishPopup, useFinishPopup } from '@/components/FinishPopup';
import { playUserSound, type SoundSlot } from '@/lib/soundSettings';
import { TermsOfService } from '@/components/TermsOfService';
import { PrivacyPolicy } from '@/components/PrivacyPolicy';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { RealJlptSimulation } from '@/components/RealJlptSimulation';
import { RealN4Simulation } from '@/components/RealN4Simulation';
import { RealN2Simulation } from '@/components/RealN2Simulation';
import { RealN2ExamDay } from '@/components/RealN2ExamDay';
import { RealN1Simulation } from '@/components/RealN1Simulation';
import { RealN1ExamDay } from '@/components/RealN1ExamDay';
import { JlptSimulationHub } from '@/components/JlptSimulationHub';
import { feedbackAudio, playFeedback, shuffle, vocabulary, type Level, type Word } from '@/lib/vocabulary';
import {
  addCustomWord, customWordsToWords, deleteCustomWord, loadCustomWords, persistCustomWords, updateCustomWord,
  sanitizeCustomWords,
  CUSTOM_LEVELS, type CustomWord, type CustomWordDraft,
} from '@/lib/customWords';
import {
  createWordList, deleteWordList, loadActiveListId, loadWordLists, persistActiveListId,
  persistWordLists, renameWordList, toggleWordInList, sanitizeLists, type WordList,
} from '@/lib/wordLists';
import {
  formatJlptSection, jlptAudioUrl, jlptChoices, jlptQuestions, shuffleJlpt,
  type JlptLevel, type JlptQuestion, type JlptSection,
} from '@/lib/jlptExam';
import {
  CABINET_PAGE_SIZES, clampPage, loadCabinetPageSize, loadCabinetShuffle, saveCabinetPageSize, saveCabinetShuffle, totalPagesFor,
} from '@/lib/cabinetPaging';

const queryClient = new QueryClient();
const levels: Array<Level | 'ALL'> = ['ALL', 'N5', 'N4', 'N3', 'N2', 'N1'];
const levelColor: Record<Level, string> = {
  N5: 'hsl(69 73% 52%)', N4: 'hsl(194 71% 42%)', N3: 'hsl(38 68% 59%)',
  N2: 'hsl(11 77% 61%)', N1: 'hsl(224 37% 27%)',
};

// Quiz drawer options. The five level drawers, 'Saved' and 'My words' can be
// combined freely (e.g. N4 + My words, N3 + N4 + Saved). 'Mixed' ('ALL') is
// the original "everything" deck and stays exclusive — it never combines
// with the other drawers.
type Deck = Level | 'ALL' | 'FAVORITES' | 'MY_WORDS';

const ALL_DECKS: Deck[] = ['N5', 'N4', 'N3', 'N2', 'N1', 'ALL', 'FAVORITES', 'MY_WORDS'];
const DECK_LABEL: Record<Deck, string> = {
  N5: 'N5', N4: 'N4', N3: 'N3', N2: 'N2', N1: 'N1',
  ALL: 'Mix', FAVORITES: 'saved', MY_WORDS: 'my words',
};
function formatDecks(decks: Deck[]): string {
  return decks.map((deck) => DECK_LABEL[deck]).join(' + ');
}

type QuizResult = { score: number; total: number; answers: Array<{ word: Word; choice: string; correct: boolean }>; level: string; finishedAt: string };
type HistoryEntry = { date: string; score: number; total: number; level?: string };
const HISTORY_KEY = 'kotoba-history';
function isJlptHistoryEntry(entry: HistoryEntry) { return entry.level?.startsWith('JLPT ') ?? false; }
const JLPT_RESULT_KEY = 'kotoba-last-jlpt-result';
// ─────────────────────────────────────────────────────────────────────────────
// DAILY BONUS SETTINGS — change the numbers here, nothing else needs editing.
// The old streak/freeze system is gone: instead of punishing a missed day, every
// day hands out tasks. Playing finishes them, finishing pays bonus points, and
// lifetime points rank you on the global leaderboard.
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_TASK_COUNT = 4;      // Missions per day = 1 warm-up + (DAILY_TASK_COUNT - 1) rotating tasks.
const DAILY_CLEAR_BONUS = 50;    // Extra points when EVERY mission of the day is finished ("full clear").
const WARMUP_ROUND_PTS = 10;     // Points per quiz round on the daily warm-up mission.
const CODE_PREFIX = 'YRSK';      // Invite code prefix -> codes look like YRSK-7F3K. Letters/numbers only.
// ─────────────────────────────────────────────────────────────────────────────
const CODE_LEN = CODE_PREFIX.length + 5; // prefix + '-' + 4 chars
// Accepts "yrsk-czcy", "YRSK CZCY", "yrskczcy", " YRSK-CZCY " -> "YRSK-CZCY"
function normalizeCode(raw: string) {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith(CODE_PREFIX)) return `${CODE_PREFIX}-${clean.slice(CODE_PREFIX.length, CODE_PREFIX.length + 4)}`;
  return clean.slice(0, CODE_LEN);
}
function makeFriendCode() { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = `${CODE_PREFIX}-`; for (let i = 0; i < 4; i += 1) out += abc[Math.floor(Math.random() * abc.length)]; return out; }
// Local calendar date (YYYY-MM-DD). NOT toISOString(): that is UTC and would make
// "today" flip at 07:00 in Jakarta instead of midnight.
function toDateKey(date: Date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function loadHistory(): HistoryEntry[] { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function sanitizeHistory(history: any[]): HistoryEntry[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && typeof item.date === 'string' && typeof item.score === 'number' && typeof item.total === 'number')
    .map((item) => ({
      date: item.date,
      score: item.score,
      total: item.total,
      ...(typeof item.level === 'string' ? { level: item.level } : {}),
    }));
}

function computeProgress(history: HistoryEntry[]) {
  const pct = (items: HistoryEntry[]) => {
    const total = items.reduce((sum, h) => sum + h.total, 0);
    if (total === 0) return null;
    return Math.round((items.reduce((sum, h) => sum + h.score, 0) / total) * 100);
  };
  const totalQuizzes = history.length;
  const totalCards = history.reduce((sum, h) => sum + h.total, 0);
  const average = pct(history) ?? 0;
  const best = history.reduce((b, h) => Math.max(b, Math.round((h.score / h.total) * 100)), 0);
  const recent = pct(history.slice(-5));
  const older = pct(history.slice(-10, -5));
  const trend = recent !== null && older !== null ? recent - older : null;
  const byLevel: Record<string, { score: number; total: number }> = {};
  for (const h of history) {
    const key = h.level ?? 'Unknown';
    byLevel[key] ??= { score: 0, total: 0 };
    byLevel[key].score += h.score;
    byLevel[key].total += h.total;
  }
  const start = Math.max(0, history.length - 20);
  const chart = history.slice(-20).map((h, i) => ({ name: `#${start + i + 1}`, pct: Math.round((h.score / h.total) * 100), date: h.date }));
  const activity: { day: string; quizzes: number }[] = [];
  const cursor = new Date();
  for (let i = 0; i < 14; i += 1) {
    const key = toDateKey(cursor);
    activity.unshift({ day: key.slice(5), quizzes: history.filter((h) => h.date === key).length });
    cursor.setDate(cursor.getDate() - 1);
  }
  return { totalQuizzes, totalCards, average, best, trend, byLevel, chart, activity };
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY BONUS ENGINE — MOBA-style rotating missions. No "log in, collect" free
// reward: every point comes from actually playing. The rules:
//   * Each day deterministically picks 1 warm-up + 3 rotating tasks from the pool
//     below, seeded by the local date. Everyone gets the same set on the same day,
//     so the global leaderboard is fair.
//   * Progress is recomputed from the rounds finished that day, so a session
//     synced from another device completes the same tasks automatically. There is
//     nothing to claim and nothing that can break — no freeze insurance needed.
//   * Finishing every task of a day pays the full-clear bonus on top.
//   * Lifetime points (sum over all days) drive the global leaderboard rank.
// ─────────────────────────────────────────────────────────────────────────────
type BonusTaskDef = {
  key: string;
  title: (target: number) => string;
  targets: number[];      // possible daily targets — one is drawn per day by the date seed
  unitPts: number;        // points per completed step, up to the target
  progress: (entries: HistoryEntry[]) => number;
  goto: '/quiz' | '/exam';
};
const quizEntries = (entries: HistoryEntry[]) => entries.filter((entry) => !isJlptHistoryEntry(entry));
const BONUS_TASK_POOL: BonusTaskDef[] = [
  { key: 'cards',   title: (t) => `Answer ${t} cards`, targets: [20, 30, 45], unitPts: 1, progress: (es) => es.reduce((sum, entry) => sum + entry.total, 0), goto: '/quiz' },
  { key: 'correct', title: (t) => `Get ${t} answers right`, targets: [10, 20, 30], unitPts: 2, progress: (es) => es.reduce((sum, entry) => sum + entry.score, 0), goto: '/quiz' },
  { key: 'strong',  title: (t) => `Score 80% or more in ${t} round${t === 1 ? '' : 's'}`, targets: [1, 2], unitPts: 25, progress: (es) => es.filter((entry) => entry.total > 0 && entry.score / entry.total >= 0.8).length, goto: '/quiz' },
  { key: 'perfect', title: () => 'Finish a 100% perfect round', targets: [1], unitPts: 40, progress: (es) => es.filter((entry) => entry.total >= 5 && entry.score === entry.total).length, goto: '/quiz' },
  { key: 'jlpt',    title: (t) => `Complete ${t} JLPT practice test${t === 1 ? '' : 's'}`, targets: [1, 2], unitPts: 25, progress: (es) => es.filter(isJlptHistoryEntry).length, goto: '/exam' },
  { key: 'decks',   title: (t) => `Practice from ${t} different decks`, targets: [2, 3], unitPts: 20, progress: (es) => new Set(quizEntries(es).map((entry) => entry.level ?? 'Unknown')).size, goto: '/quiz' },
];
// FNV-1a over the date string -> deterministic seed for that day's task draw.
function dayHash(key: string) { let h = 2166136261; for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
type DailyBonusTask = { key: string; title: string; target: number; unitPts: number; progress: number; earned: number; done: boolean; goto: '/quiz' | '/exam' };
function pickDayTasks(dayKey: string): Array<Omit<DailyBonusTask, 'progress' | 'earned' | 'done'>> {
  const seed = (dayHash(`kotoba-bonus:${dayKey}`) || 7) % 2147483646;
  const rotating = seededShuffle(BONUS_TASK_POOL, seed).slice(0, Math.max(0, DAILY_TASK_COUNT - 1));
  // separate LCG stream for the target draw so shuffle and targets don't correlate
  let s = (seed + 1013904223) % 2147483647; if (s <= 0) s += 2147483646;
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const warmup = { key: 'warmup', title: 'Finish 1 quiz round', target: 1, unitPts: WARMUP_ROUND_PTS, goto: '/quiz' as const };
  return [warmup, ...rotating.map((def) => {
    const target = def.targets[Math.floor(rand() * def.targets.length)] ?? def.targets[0];
    return { key: def.key, title: def.title(target), target, unitPts: def.unitPts, goto: def.goto };
  })];
}
function taskProgressForDay(key: string, entries: HistoryEntry[]) {
  if (key === 'warmup') return quizEntries(entries).length;
  const def = BONUS_TASK_POOL.find((item) => item.key === key);
  return def ? def.progress(entries) : 0;
}
function computeBonusForDay(entries: HistoryEntry[], dayKey: string) {
  const tasks: DailyBonusTask[] = pickDayTasks(dayKey).map((task) => {
    const progress = taskProgressForDay(task.key, entries);
    const counted = Math.min(progress, task.target);
    return { ...task, progress: counted, earned: counted * task.unitPts, done: progress >= task.target };
  });
  const taskPoints = tasks.reduce((sum, task) => sum + task.earned, 0);
  const cleared = tasks.length > 0 && tasks.every((task) => task.done);
  return { tasks, taskPoints, cleared, points: taskPoints + (cleared ? DAILY_CLEAR_BONUS : 0) };
}
function computeBonusSummary(history: HistoryEntry[], todayKey = toDateKey(new Date())) {
  const byDay = new Map<string, HistoryEntry[]>();
  for (const entry of history) { const bucket = byDay.get(entry.date); if (bucket) bucket.push(entry); else byDay.set(entry.date, [entry]); }
  const today = computeBonusForDay(byDay.get(todayKey) ?? [], todayKey);
  let lifetime = 0;
  let bestDay: { date: string; points: number } | null = null;
  for (const [date, entries] of byDay) {
    const points = computeBonusForDay(entries, date).points;
    lifetime += points;
    if (points > 0 && (bestDay === null || points > bestDay.points)) bestDay = { date, points };
  }
  const last7: { day: string; points: number; cleared: boolean }[] = [];
  const cursor = new Date();
  for (let i = 0; i < 7; i += 1) {
    const key = toDateKey(cursor);
    const day = computeBonusForDay(byDay.get(key) ?? [], key);
    last7.unshift({ day: key.slice(5), points: day.points, cleared: day.cleared });
    cursor.setDate(cursor.getDate() - 1);
  }
  return { today, lifetime, bestDay, last7, tasksDone: today.tasks.filter((task) => task.done).length, tasksTotal: today.tasks.length };
}

function cx(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(' '); }

// Deterministic shuffle: the same items + the same seed ALWAYS produce the
// same order. We use it for the quiz options so their order becomes a pure
// function of the card — no matter how often React re-renders or re-evaluates
// the memo, the four buttons can never swap around while a card is on screen.
function seededShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// -------------------------------------------------------------
// CLOUD USER DATA CONTEXT (Cross-device sync for saved, custom words & history)
// -------------------------------------------------------------

// ── Friends ──────────────────────────────────────────────────────────────────
// A pending friend invitation. Doc id in Firestore is `${uidA}_${uidB}` (sorted)
// — the SAME id the future `pairs` doc will have. The doc exists only while the
// invitation is pending: confirming, declining or cancelling deletes it (the
// collection is never updated, a request is only ever "pending").
export type FriendRequest = {
  id: string;         // `${uidA}_${uidB}` (sorted) — doubles as the future pairId
  from: string;       // uid of the person who entered the code (sender)
  to: string;         // uid of the code owner (recipient — only they can confirm)
  fromName: string;   // sender's nickname when they sent it
  toName: string;     // recipient's nickname (kept for the pair record)
  members: string[];  // sorted [uidA, uidB] — enables the array-contains listener
  createdAt: string;  // ISO date
};
export type FriendActionResult = { ok: boolean; text: string };

interface DataContextType {
  lists: WordList[];
  activeId: string;
  activeList: WordList;
  setActiveId: (id: string) => void;
  createList: (name: string) => string;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  toggleWord: (wordId: string, listId?: string) => void;
  slotLimitReached: boolean;
  maxSlots: number;
  importReady: boolean;
  importWords: (request: BulkImportRequest) => Promise<BulkImportResult>;
  customWords: CustomWord[];
  addCustomWord: (draft: CustomWordDraft) => void;
  updateCustomWord: (id: string, draft: CustomWordDraft) => void;
  removeCustomWord: (id: string) => void;
  history: HistoryEntry[];
  recordHistory: (entry: HistoryEntry) => void;
  clearHistory: () => void;
  shareScores: boolean;
  toggleShareScores: (next: boolean) => void;
  nickname: string;
  saveNickname: (raw: string) => Promise<string | null>;
  friendCode: string;
  friendRequests: FriendRequest[];
  generateFriendCode: () => Promise<string | null>;
  addFriendByCode: (code: string) => Promise<FriendActionResult>;
  confirmFriendRequest: (req: FriendRequest) => Promise<string | null>;
  declineFriendRequest: (req: FriendRequest) => Promise<string | null>;
  cancelFriendRequest: (req: FriendRequest) => Promise<string | null>;
  removeFriend: (pairId: string) => Promise<string | null>;
}

const DataContext = createContext<DataContextType | null>(null);

function DataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const activeDataUser = useRef(user?.uid);
  activeDataUser.current = user?.uid;
  const [dataOwnerId, setDataOwnerId] = useState<string | null>(null);
  const importInFlight = useRef(false);
  const meVersion = useRef<number | null>(null);   // D1 row version, for optimistic locking
  const checkedInvite = useRef<string>('');        // avoids re-checking the same code each poll
  const [lists, setLists] = useState<WordList[]>(() => loadWordLists());
  const [activeId, setActiveId] = useState<string>(() => loadActiveListId(loadWordLists()));
  const [customWords, setCustomWords] = useState<CustomWord[]>(() => loadCustomWords());
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  // Per-user profile bits. These are cached in localStorage under a key that
  // includes the uid, so two accounts on the same browser never see each
  // other's nickname / invite code.
  const [shareScores, setShareScores] = useState<boolean>(false);
  const [nickname, setNickname] = useState<string>('');
  const [friendCode, setFriendCode] = useState<string>('');
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const uk = (key: string) => `kotoba:${user?.uid ?? 'anon'}:${key}`;
  const cache = (key: string, value: string) => { if (user) localStorage.setItem(uk(key), value); };

  // When the signed-in user changes, reset profile state and load that user's cache.
  useEffect(() => {
    // one-time cleanup of the old shared (non per-user) keys
    ['kotoba-share','kotoba-nickname','kotoba-perfect','kotoba-freezes','kotoba-frozen','kotoba-friend-code'].forEach((k) => localStorage.removeItem(k));
    ['perfect', 'freezes', 'frozen'].forEach((k) => localStorage.removeItem(uk(k)));   // retired streak-freeze cache
    setFriendRequests([]);
    setDataOwnerId(null);
    if (!user) { setShareScores(false); setNickname(''); setFriendCode(''); return; }
    setShareScores(localStorage.getItem(uk('share')) === '1');
    setNickname(localStorage.getItem(uk('nickname')) || '');
    setFriendCode(localStorage.getItem(uk('friend-code')) || '');
  }, [user?.uid]);

  // Pending friend invitations (received + sent). Was a Firestore onSnapshot;
  // D1 has no push, so we poll (and stop while the tab is in the background).
  usePoll(
    () => api.friendRequests(),
    (rows) => setFriendRequests(rows.map((r) => ({
      id: r.id, from: r.from, to: r.to, fromName: r.fromName, toName: r.toName,
      members: [r.from, r.to].sort(), createdAt: r.createdAt,
    }))),
    20_000,
    !!user,
  );

  // Save to D1 through the Worker instead of writing to Firestore directly.
  // `version` gives us optimistic locking: if another device saved first the API
  // answers 409, and we refetch and retry once with the fresh version.
  const pushToCloud = (payload: { lists?: WordList[]; activeId?: string; customWords?: CustomWord[]; history?: HistoryEntry[]; shareScores?: boolean; nickname?: string; friendCode?: string }) => {
    if (!user) return;
    void (async () => {
      try {
        const res = await api.saveMe({ ...payload, version: meVersion.current ?? undefined });
        meVersion.current = res.version;
      } catch (err) {
        if (!(err instanceof ApiError) || !err.isStale) { console.error(err); return; }
        try {
          const fresh = await api.me();                       // someone else saved first
          meVersion.current = fresh.version;
          const res = await api.saveMe({ ...payload, version: fresh.version });
          meVersion.current = res.version;
        } catch (retryErr) { console.error(retryErr); }
      }
    })();
  };

  // ── Cloud sync ───────────────────────────────────────────────────────────
  // Replaces the old onSnapshot on userData/{uid}. D1 has no push, so we poll
  // every 20s (plus instantly when the tab wakes up or reconnects).
  const applyMe = (data: MePayload) => {
    const uid = activeDataUser.current;
    if (!uid) return;
    setDataOwnerId(uid);
    meVersion.current = data.version;

    if (Array.isArray(data.lists)) {
      const cleanLists = sanitizeLists(data.lists as WordList[]);
      setLists(cleanLists);
      persistWordLists(cleanLists);
    }
    if (typeof data.activeId === 'string' && data.activeId !== '') {
      setActiveId(data.activeId);
      persistActiveListId(data.activeId);
    }
    if (Array.isArray(data.customWords)) {
      const cleanWords = sanitizeCustomWords(data.customWords as CustomWord[]);
      setCustomWords(cleanWords);
      persistCustomWords(cleanWords);
    }
    if (Array.isArray(data.history)) {
      const cleanHistory = sanitizeHistory(data.history as HistoryEntry[]);
      setHistory(cleanHistory);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(cleanHistory));
    }
    if (typeof data.shareScores === 'boolean') {
      setShareScores(data.shareScores);
      cache('share', data.shareScores ? '1' : '0');
    }
    if (typeof data.nickname === 'string') {
      setNickname(data.nickname);
      cache('nickname', data.nickname);
    }
    if (typeof data.friendCode === 'string' && data.friendCode) {
      // Trust a code only if its invite row points at THIS user — and look it up
      // once per code so polling doesn't re-read on every tick.
      if (checkedInvite.current === data.friendCode) {
        setFriendCode(data.friendCode);
        cache('friend-code', data.friendCode);
      } else {
        checkedInvite.current = data.friendCode;
        api.lookupInvite(data.friendCode).then((inv) => {
          if (activeDataUser.current !== uid) return;
          if (inv.from === uid) {
            setFriendCode(data.friendCode);
            cache('friend-code', data.friendCode);
          } else {
            setFriendCode('');
            cache('friend-code', '');
            pushToCloud({ friendCode: '' });
          }
        }).catch(() => {});
      }
    }

    // First sign-in on a device that already has local data → seed the account.
    if (data.version === 0 && data.lists.length === 0 && data.customWords.length === 0 && data.history.length === 0) {
      const localLists = loadWordLists();
      const localWords = loadCustomWords();
      const localHistory = loadHistory();
      if (localLists.length || localWords.length || localHistory.length) {
        pushToCloud({ lists: localLists, activeId: loadActiveListId(localLists), customWords: localWords, history: localHistory });
      }
    }
  };

  usePoll(() => api.me(), applyMe, 20_000, !!user);

  const importWords = async (request: BulkImportRequest): Promise<BulkImportResult> => {
    if (!user || dataOwnerId !== user.uid) throw new Error('Wait for your account data to load before importing.');
    if (importInFlight.current) throw new Error('An import is already being saved. Please wait.');
    const owner = user.uid;
    importInFlight.current = true;
    try {
      const result = await commitBulkImport(owner, request, vocabulary, () => activeDataUser.current === owner);
      if (activeDataUser.current !== owner) return result;
      setLists(result.lists);
      setCustomWords(result.customWords);
      setActiveId(result.list.id);
      let cacheWarning = false;
      try {
        persistWordLists(result.lists);
        persistCustomWords(result.customWords);
        persistActiveListId(result.list.id);
      } catch { cacheWarning = true; } // Cloud commit already succeeded; never report it as failed.
      return { ...result, cacheWarning };
    } finally { importInFlight.current = false; }
  };

  const slotLimitReached = lists.length >= MAX_SAVE_SLOTS;

  const createList = (name: string) => {
    if (slotLimitReached) return activeId;
    const { lists: next, id } = createWordList(lists, name);
    setLists(next);
    setActiveId(id);
    persistWordLists(next);
    persistActiveListId(id);
    pushToCloud({ lists: next, activeId: id });
    return id;
  };

  const renameList = (id: string, name: string) => {
    const next = renameWordList(lists, id, name);
    setLists(next);
    persistWordLists(next);
    pushToCloud({ lists: next });
  };

  const deleteList = (id: string) => {
    if (lists.length <= 1) return;
    const next = deleteWordList(lists, id);
    const nextActive = activeId === id ? next[0].id : activeId;
    setLists(next);
    setActiveId(nextActive);
    persistWordLists(next);
    persistActiveListId(nextActive);
    pushToCloud({ lists: next, activeId: nextActive });
  };

  const toggleWord = (wordId: string, listId: string = activeId) => {
    const next = toggleWordInList(lists, listId, wordId);
    setLists(next);
    persistWordLists(next);
    pushToCloud({ lists: next });
  };

  const addWord = (draft: CustomWordDraft) => {
    const next = addCustomWord(customWords, draft).words;
    setCustomWords(next);
    persistCustomWords(next);
    pushToCloud({ customWords: next });
  };

  const editWord = (id: string, draft: CustomWordDraft) => {
    const next = updateCustomWord(customWords, id, draft);
    setCustomWords(next);
    persistCustomWords(next);
    pushToCloud({ customWords: next });
  };

  const removeWord = (id: string) => {
    const next = deleteCustomWord(customWords, id);
    setCustomWords(next);
    persistCustomWords(next);
    pushToCloud({ customWords: next });
  };

  // Writes (or removes) MY card in the public `leaderboard` collection.
  // A card only exists when: sharing is on AND a nickname is set AND there is history.
  const publishSummary = (nextHistory: HistoryEntry[], share: boolean, name: string) => {
    if (!user) return;
    const cleanName = name.trim().slice(0, 30);
    if (!share || !cleanName || nextHistory.length === 0) {
      api.publish(false, cleanName).catch(console.error);   // removes my card
      return;
    }
    const p = computeProgress(nextHistory);
    const bonus = computeBonusSummary(nextHistory);
    const jlptHistory = nextHistory.filter(isJlptHistoryEntry);
    const jlptTotal = jlptHistory.reduce((sum, item) => sum + item.total, 0);
    const jlptScore = jlptHistory.reduce((sum, item) => sum + item.score, 0);
    api.publish(true, cleanName, {
      totalQuizzes: p.totalQuizzes,
      avgPct: p.average,
      bestPct: p.best,
      bonusPoints: bonus.lifetime,
      bestDay: bonus.bestDay?.points ?? 0,
      jlptQuizzes: jlptHistory.length,
      jlptAvgPct: jlptTotal === 0 ? 0 : Math.round((jlptScore / jlptTotal) * 100),
    }).catch(console.error);
  };

  // Nicknames are unique (case-insensitive). We reserve `nicknames/{lowercase}`;
  // the Firestore rules reject the write if someone else already owns that doc.
  // Returns an error message, or null on success.
  const saveNickname = async (raw: string): Promise<string | null> => {
    if (!user) return 'Not signed in.';
    const next = raw.trim().slice(0, 30);
    if (next.length < 2) return 'Nickname must be at least 2 characters.';
    if (!/^[\p{L}\p{N} _.-]+$/u.test(next)) return 'Only letters, numbers, spaces, _ . - are allowed.';
    const key = next.toLowerCase();
    const prevKey = nickname.trim().toLowerCase();
    if (key === prevKey) { if (next !== nickname) { setNickname(next); cache('nickname', next); pushToCloud({ nickname: next }); } return null; }
    try {
      // The Worker claims the new name and releases the old one in one go.
      // A PRIMARY KEY collision comes back as a friendly 409 message.
      await api.claimNickname(next, prevKey ? nickname : undefined);
    } catch (err) {
      return err instanceof ApiError ? err.message : `"${next}" is already taken. Try another.`;
    }
    setNickname(next);
    cache('nickname', next);
    pushToCloud({ nickname: next });
    publishSummary(history, shareScores, next);
    return null;
  };

  const toggleShareScores = (next: boolean) => {
    setShareScores(next);
    cache('share', next ? '1' : '0');
    pushToCloud({ shareScores: next });
    publishSummary(history, next, nickname);
  };

  const recordHistoryFn = (entry: HistoryEntry) => {
    const next = [...history, entry].slice(-300);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    // Daily bonus points are DERIVED from this history (see computeBonusSummary),
    // so recording a round is all it takes: today's tasks, the full-clear bonus
    // and the lifetime total update everywhere at once.
    pushToCloud({ history: next });
    publishSummary(next, shareScores, nickname);
  };

  // ---- Friends ----
  const generateFriendCode = async (): Promise<string | null> => {
    if (!user || friendCode || !nickname.trim()) return null;
    try {
    let code = makeFriendCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {           // avoid the (rare) collision with an existing code
      const taken = await api.lookupInvite(code).catch(() => null);
      if (!taken) break;
      code = makeFriendCode();
    }
    await api.createInvite(code, nickname.trim());
    setFriendCode(code); cache('friend-code', code);
    pushToCloud({ friendCode: code });
    return null;
    } catch (err) { return err instanceof ApiError ? err.message : 'Could not create your code. Please try again.'; }
  };

  // Entering someone's code now SENDS AN INVITATION instead of creating the
  // friendship instantly. The code owner confirms (or declines) it on their
  // Friends page; the `pairs` doc is only created on confirm. If they had
  // already invited US, entering their code accepts it right away.
  const addFriendByCode = async (raw: string): Promise<FriendActionResult> => {
    if (!user) return { ok: false, text: 'Not signed in.' };
    if (!nickname.trim()) return { ok: false, text: 'Set a nickname on the Leaderboard page first.' };
    const code = normalizeCode(raw);
    if (!new RegExp(`^${CODE_PREFIX}-[A-Z0-9]{4}$`).test(code)) return { ok: false, text: `That does not look like a Kotoba code (${CODE_PREFIX}-XXXX).` };
    // One call replaces the old read-invite / read-pair / read-request / write
    // dance: the Worker checks "already friends?" and "already invited?" and
    // answers 409 with the same message the user used to get.
    let inv;
    try { inv = await api.lookupInvite(code); }
    catch (err) { return { ok: false, text: err instanceof ApiError ? err.message : 'Code not found. Ask your friend to double-check it.' }; }

    const other = inv.from;
    const otherName = inv.nickname || 'Friend';
    if (other === user.uid) return { ok: false, text: 'That is your own code.' };

    try {
      const res = await api.sendFriendRequest(other, code);
      return {
        ok: true,
        text: res.autoAccepted
          ? `${otherName} already invited you — you are friends now!`
          : `Invitation sent! ${otherName} has to confirm it before you are friends.`,
      };
    } catch (err) {
      return { ok: false, text: err instanceof ApiError ? err.message : 'Could not send the invitation.' };
    }
  };

  // The code owner confirms an invitation -> create the pair, delete the request.
  // (If the pair somehow exists already — e.g. both sides confirmed at once —
  // we just clear the request.)
  const confirmFriendRequest = async (req: FriendRequest): Promise<string | null> => {
    if (!user) return 'Not signed in.';
    if (req.to !== user.uid) return 'Only the person who was invited can confirm.';
    const members = [...(req.members || [])].sort();
    if (members.length !== 2) return 'That invitation looks broken — ask your friend to send it again.';
    try {
      await api.confirmPair(req.id, { [user.uid]: nickname.trim() || req.toName || 'Friend' });
      return null;
    } catch (err) { return err instanceof ApiError ? err.message : 'Could not confirm the invitation.'; }
  };

  // Decline = just delete the pending invitation. They can always send another one.
  const declineFriendRequest = async (req: FriendRequest): Promise<string | null> => {
    if (!user) return 'Not signed in.';
    if (req.to !== user.uid) return 'Only the person who was invited can decline.';
    try { await api.deleteFriendRequest(req.id); return null; }
    catch (err) { return err instanceof ApiError ? err.message : 'Could not decline the invitation.'; }
  };

  // The sender takes back an invitation that has not been confirmed yet.
  const cancelFriendRequest = async (req: FriendRequest): Promise<string | null> => {
    if (!user) return 'Not signed in.';
    if (req.from !== user.uid) return 'Only the sender can cancel an invitation.';
    try { await api.deleteFriendRequest(req.id); return null; }
    catch (err) { return err instanceof ApiError ? err.message : 'Could not cancel the invitation.'; }
  };

  // Remove a friend: deletes the pair — the team progress banked in that
  // friendship goes with it. Any pending invitation between the same two people
  // (same doc id) is cleared too, so a fresh start is possible.
  const removeFriend = async (pairId: string): Promise<string | null> => {
    if (!user) return 'Not signed in.';
    try { await api.deletePair(pairId); }
    catch (err) { return err instanceof ApiError ? err.message : 'Could not remove the friend.'; }
    await api.deleteFriendRequest(pairId).catch(() => {});   // none pending — fine
    return null;
  };

  const clearHistoryFn = () => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
    pushToCloud({ history: [] });
    publishSummary([], shareScores, nickname);
  };

  const activeList = useMemo(() => lists.find((list) => list.id === activeId) ?? lists[0], [lists, activeId]);

  return (
    <DataContext.Provider
      value={{
        lists,
        activeId,
        activeList,
        setActiveId: (id) => {
          setActiveId(id);
          persistActiveListId(id);
          pushToCloud({ activeId: id });
        },
        createList,
        renameList,
        deleteList,
        toggleWord,
        slotLimitReached,
        maxSlots: MAX_SAVE_SLOTS,
        importReady: !!user && dataOwnerId === user.uid,
        importWords,
        customWords,
        addCustomWord: addWord,
        updateCustomWord: editWord,
        removeCustomWord: removeWord,
        history,
        recordHistory: recordHistoryFn,
        clearHistory: clearHistoryFn,
        shareScores,
        toggleShareScores,
        nickname,
        saveNickname,
        friendCode,
        friendRequests,
        generateFriendCode,
        addFriendByCode,
        confirmFriendRequest,
        declineFriendRequest,
        cancelFriendRequest,
        removeFriend,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

function useWordLists() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useWordLists must be used within DataProvider');
  return {
    lists: ctx.lists,
    activeList: ctx.activeList,
    activeId: ctx.activeId,
    setActiveId: ctx.setActiveId,
    createList: ctx.createList,
    renameList: ctx.renameList,
    deleteList: ctx.deleteList,
    toggleWord: ctx.toggleWord,
    slotLimitReached: ctx.slotLimitReached,
    maxSlots: ctx.maxSlots,
    importReady: ctx.importReady,
    importWords: ctx.importWords,
  };
}

function useCustomWords() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useCustomWords must be used within DataProvider');
  return {
    words: ctx.customWords,
    add: ctx.addCustomWord,
    update: ctx.updateCustomWord,
    remove: ctx.removeCustomWord,
  };
}

function useCabinetHistory() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useCabinetHistory must be used within DataProvider');
  return {
    history: ctx.history,
    recordHistory: ctx.recordHistory,
    clearHistory: ctx.clearHistory,
    shareScores: ctx.shareScores,
    toggleShareScores: ctx.toggleShareScores,
    nickname: ctx.nickname,
    saveNickname: ctx.saveNickname,
    friendCode: ctx.friendCode,
    friendRequests: ctx.friendRequests,
    generateFriendCode: ctx.generateFriendCode,
    addFriendByCode: ctx.addFriendByCode,
    confirmFriendRequest: ctx.confirmFriendRequest,
    declineFriendRequest: ctx.declineFriendRequest,
    cancelFriendRequest: ctx.cancelFriendRequest,
    removeFriend: ctx.removeFriend,
  };
}

function Logo() {
  return <Link href="/" className="flex items-center gap-3" data-testid="link-logo">
    <span className="grid size-10 shrink-0 place-items-center rounded-cards bg-[hsl(var(--accent))] text-[hsl(var(--foreground))] hard-shadow rotate-[-4deg]">
      <span className="kanji-display text-2xl font-bold">言</span>
    </span>
    <span className="leading-none"><strong className="block text-[1.05rem] tracking-[-.04em]">kotoba</strong><span className="mono-label text-muted-foreground">cabinet</span></span>
  </Link>;
}

// Arena.ai-style sidebar toggle: a square box with a divider and a chevron
// inside the left pane — the chevron points the way the panel will move.
// One component serves all four spots: sidebar close, header expand, phone
// header open, and phone drawer close.
function SidebarToggle({ direction, onClick, ariaLabel, title, testId, iconSize = 15 }: {
  direction: 'open' | 'close';
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  testId: string;
  iconSize?: number;
}) {
  return <button
    onClick={onClick}
    className="grid size-7 shrink-0 place-items-center rounded-buttons border border-border bg-[hsl(var(--card))] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    aria-label={ariaLabel}
    title={title ?? ariaLabel}
    data-testid={testId}
  >
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21L5 21C3.89543 21 3 20.1046 3 19L3 5C3 3.89543 3.89543 3 5 3L19 3C20.1046 3 21 3.89543 21 5L21 19C21 20.1046 20.1046 21 19 21Z" />
      <path d="M9.5 21V3" />
      <path d={direction === 'close' ? 'M7.25 10L5.5 12L7.25 14' : 'M5.5 10L7.25 12L5.5 14'} />
    </svg>
  </button>;
}

// A slim "grab" strip glued to the sidebar's edge — hover shows a divider
// line and a resize cursor, click collapses it. Same idea as shadcn/ui's
// <SidebarRail>, adapted to our single fixed <aside> (there's no separate
// gap/container element here, so the strip stays flush inside the sidebar's
// own border instead of overhanging it, which would get clipped by the
// aside's overflow-y-auto).
function SidebarRail({ onClick }: { onClick: () => void }) {
  return <button
    onClick={onClick}
    aria-label="Toggle Sidebar"
    title="Toggle Sidebar"
    tabIndex={-1}
    className="group/rail absolute inset-y-0 right-0 z-10 hidden w-3 cursor-w-resize items-center justify-center md:flex"
    data-testid="button-sidebar-rail"
  >
    <span className="h-full w-px bg-transparent transition-colors group-hover/rail:bg-[hsl(var(--sidebar-border))]" />
  </button>;
}

// The daily-bonus card — shared by the desktop sidebar and the phone drawer,
// so both show the same missions/points panel.
function DailyBonusCard({ bonus, onNavigate, testId }: {
  bonus: ReturnType<typeof computeBonusSummary>;
  onNavigate?: () => void;
  testId?: string;
}) {
  return <Link
    href="/bonus"
    onClick={onNavigate}
    className="mt-auto block rounded-cards-large border border-border bg-muted/60 p-4 transition-colors hover:bg-muted"
    data-testid={testId ?? 'link-daily-bonus'}
  >
    <div className="mb-3 flex items-center justify-between">
      <span className="mono-label text-muted-foreground">Daily bonus</span>
      <Gift size={16} className={cx(bonus.tasksTotal > 0 && bonus.tasksDone === bonus.tasksTotal ? 'text-emerald-600' : 'text-muted-foreground/60')} />
    </div>
    <p className="font-serif text-3xl">{bonus.today.points} <span className="text-base">pts today</span></p>
    <p className="mt-1 text-xs text-muted-foreground">
      {bonus.today.cleared ? '✓ Full clear — day complete.' : bonus.today.points > 0 ? `${bonus.tasksDone}/${bonus.tasksTotal} tasks done — keep going.` : 'Play to earn — logging in alone pays nothing.'}
    </p>
    <div className="mt-4 space-y-1.5">
      {bonus.today.tasks.map((task) => (
        <div key={task.key} className="flex items-center gap-2">
          <span className="mono-label w-14 shrink-0 truncate text-[9px] text-muted-foreground/80">
            {task.done ? `✓ +${task.earned}` : `${task.progress}/${task.target}`}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
            <span
              className={cx(
                'block h-full rounded-full transition-all',
                task.done ? 'bg-emerald-500' : 'bg-emerald-500/70',
              )}
              style={{ width: `${task.target > 0 ? Math.min(100, (task.progress / task.target) * 100) : 0}%` }}
            />
          </span>
        </div>
      ))}
    </div>
    <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs">
      <span className="flex items-center gap-1.5 font-bold text-foreground/80"><Coins size={13} className="text-[hsl(var(--accent))]" /> {bonus.lifetime.toLocaleString()} pts total</span>
      <span className="mono-label text-muted-foreground">{bonus.bestDay ? `best ${bonus.bestDay.points}` : 'no best yet'}</span>
    </div>
  </Link>;
}

// Phone/tablet navigation: the desktop sidebar is hidden below `md`, so on
// small screens the header button slides this drawer in from the left —
// same nav items and same sidebar theme as the desktop <aside>.
function MobileNavDrawer({ open, navItems, bonus, location, inviteCount, onClose }: {
  open: boolean;
  navItems: { href: string; label: string; icon: LucideIcon }[];
  bonus: ReturnType<typeof computeBonusSummary>;
  location: string;
  inviteCount: number;
  onClose: () => void;
}) {
  // The enter animation is a CSS keyframe, started by the mount itself — a
  // requestAnimationFrame-based class swap can stall 2+ frames on real phones
  // (tap -> visible pause -> jumpy slide). The exit is a transform transition;
  // the drawer stays mounted until the slide-out has finished.
  const [phase, setPhase] = useState<'closed' | 'entering' | 'open' | 'exiting'>(open ? 'entering' : 'closed');
  useEffect(() => {
    if (open) {
      setPhase((current) => (current === 'open' || current === 'entering' ? current : 'entering'));
      const timer = setTimeout(() => setPhase((current) => (current === 'entering' ? 'open' : current)), 320);
      return () => clearTimeout(timer);
    }
    setPhase((current) => (current === 'closed' || current === 'exiting' ? current : 'exiting'));
    const timer = setTimeout(() => setPhase('closed'), 320);
    return () => clearTimeout(timer);
  }, [open]);
  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // Lock background scrolling while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);
  if (phase === 'closed') return null;
  return <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
    <div className={cx('absolute inset-0 bg-black/40 transition-opacity duration-300', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} aria-hidden="true" />
    <aside className={cx(
      'absolute inset-y-0 left-0 flex w-[300px] max-w-[86vw] flex-col overflow-y-auto border-r border-border bg-[hsl(var(--card))] px-5 py-6 text-foreground shadow-[var(--shadow-md)] will-change-transform',
      phase === 'entering' && 'kotoba-drawer-enter',
      phase === 'open' && 'translate-x-0',
      phase === 'exiting' && '-translate-x-full transition-transform duration-300 ease-in',
    )}>
      <div className="flex items-center justify-between gap-2">
        <Logo />
        <SidebarToggle direction="close" onClick={onClose} ariaLabel="Close menu" title="Close menu" testId="button-menu-close" iconSize={16} />
      </div>
      <nav className="mt-10 space-y-1" aria-label="Mobile navigation">
        {navItems.map(({ href, label, icon: Icon }) => { const isActive = location === href || (href !== '/' && location.startsWith(`${href}/`)); return <Link key={href} href={href} onClick={onClose} data-testid={`mobile-nav-${label.toLowerCase().replace(' ', '-')}`} className={cx('group flex items-center gap-3 rounded-nav px-3 py-3 text-sm font-semibold transition-colors', isActive ? 'bg-muted font-bold text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground')}>
          <Icon size={17} strokeWidth={isActive ? 2.6 : 1.8} /><span>{label}</span>{href === '/quiz' && <span className="ml-auto size-1.5 rounded-full bg-[hsl(var(--accent))]" />}{href === '/friends' && inviteCount > 0 && <span className="ml-auto grid min-w-5 place-items-center rounded-full bg-[hsl(var(--accent))] px-1 text-[10px] font-black leading-5 text-[hsl(var(--foreground))]">{inviteCount}</span>}
        </Link>; })}
      </nav>
      <DailyBonusCard bonus={bonus} onNavigate={onClose} testId="mobile-link-daily-bonus" />
    </aside>
  </div>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { history, friendRequests } = useCabinetHistory();
  const { user, logout } = useAuth();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // Desktop sidebar show/hide. The toggle button lives inside the sidebar (top
  // row, next to the logo); a mirrored class on <html> lets every positioned
  // element (header / main / footer) follow — see index.css.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('kotoba-sidebar-collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('kotoba-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); } catch { /* storage unavailable */ }
    document.documentElement.classList.toggle('kotoba-sidebar-collapsed', sidebarCollapsed);
  }, [sidebarCollapsed]);

  const bonus = useMemo(() => computeBonusSummary(history), [history]);
  // Friend invitations waiting for this user -> badge on the Friends nav item.
  const inviteCount = user ? friendRequests.filter((r) => r.to === user.uid).length : 0;
  const navItems = [
    { href: '/', label: 'Cabinet', icon: Home },
    { href: '/quiz', label: 'Quiz deck', icon: Target },
    { href: '/exam', label: 'JLPT exam', icon: GraduationCap },
    { href: '/jlpt-simulation', label: 'JLPT Simulation', icon: ClipboardCheck },
    { href: '/custom', label: 'My words', icon: BookPlus },
    { href: '/results', label: 'Round results', icon: Trophy },
    { href: '/review', label: 'Card library', icon: BookOpen },
    { href: '/progress', label: 'Progress', icon: TrendingUp },
    { href: '/leaderboard', label: 'Leaderboard', icon: Users },
    { href: '/friends', label: 'Friends', icon: UserPlus },
  ];
  return <div className="paper-grain min-h-[100dvh] bg-background">
    <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[246px] flex-col overflow-y-auto border-r border-border bg-[hsl(var(--card))] px-5 py-6 text-foreground md:flex" aria-hidden={sidebarCollapsed || undefined}>
      <SidebarRail onClick={() => setSidebarCollapsed(true)} />
      <div className="flex items-center justify-between gap-2">
        <Logo />
        <SidebarToggle direction="close" onClick={() => setSidebarCollapsed(true)} ariaLabel="Hide sidebar" title="Hide sidebar" testId="button-sidebar-collapse" iconSize={16} />
      </div>
      <div className="mt-12">
        <p className="mono-label mb-3 px-3 text-muted-foreground">Desk / 01</p>
        <nav className="space-y-1" aria-label="Primary navigation">
          {navItems.map(({ href, label, icon: Icon }) => { const isActive = location === href || (href !== '/' && location.startsWith(`${href}/`)); return <Link key={href} href={href} data-testid={`nav-${label.toLowerCase().replace(' ', '-')}`} className={cx('group flex items-center gap-3 rounded-nav px-3 py-3 text-sm font-semibold transition-colors', isActive ? 'bg-muted font-bold text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground')}>
            <Icon size={17} strokeWidth={isActive ? 2.6 : 1.8} /><span>{label}</span>{href === '/quiz' && <span className="ml-auto size-1.5 rounded-full bg-[hsl(var(--accent))]" />}{href === '/friends' && inviteCount > 0 && <span className="ml-auto grid min-w-5 place-items-center rounded-full bg-[hsl(var(--accent))] px-1 text-[10px] font-black leading-5 text-[hsl(var(--foreground))]" data-testid="nav-friends-badge">{inviteCount}</span>}
          </Link>; })}
        </nav>
      </div>
      <DailyBonusCard bonus={bonus} testId="link-daily-bonus" />
    </aside>
    <header className="app-sidebar-offset sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-border bg-background/90 px-5 backdrop-blur-md md:ml-[246px] md:px-10">
      <div className="flex items-center gap-3 md:hidden"><SidebarToggle direction="open" onClick={() => setMenuOpen(!menuOpen)} ariaLabel="Toggle menu" testId="button-menu" iconSize={16} /><Logo /></div>
      {sidebarCollapsed && <span className="hidden md:block"><SidebarToggle direction="open" onClick={() => setSidebarCollapsed(false)} ariaLabel="Show sidebar" title="Show sidebar" testId="button-sidebar-expand" /></span>}
      <div className="ml-auto flex items-center gap-3">
           {user && <Link href="/bonus" data-testid="header-bonus-chip" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-bold transition-colors hover:bg-muted md:hidden" aria-label="Open daily bonus"><Gift size={13} className={cx(bonus.tasksTotal > 0 && bonus.tasksDone === bonus.tasksTotal ? 'text-[hsl(var(--accent))]' : 'text-muted-foreground')} />{bonus.today.points} pts</Link>}
            {user && (
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-1.5 pr-3 text-sm hover:bg-muted"
              data-testid="button-user-menu"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary))] text-xs font-bold text-[hsl(var(--primary-foreground))]">
                {user.email?.[0].toUpperCase()}
              </span>
              <span className="hidden max-w-[140px] truncate text-xs font-semibold text-muted-foreground sm:inline">{user.email}</span>
              <ChevronDown size={14} className={cx('text-muted-foreground transition-transform', userMenuOpen && 'rotate-180')} />
            </button>
            {userMenuOpen && <>
              <div className="fixed inset-0 z-30" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-60 rounded-cards border border-border bg-card p-2 shadow-[var(--shadow-md)]" data-testid="menu-user">
                <div className="px-2 py-2">
                  <p className="text-xs text-muted-foreground">Signed in as</p>
                  <p className="truncate text-sm font-semibold">{user.email}</p>
                </div>
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={async () => {
                    if (loggingOut) return;
                    setLoggingOut(true);
                    setUserMenuOpen(false);
                    try { await logout(); } catch (err) { console.error(err); }
                    // Hard redirect: guarantees every in-memory state (context, listeners,
                    // sessionStorage quiz result) is dropped before the next user signs in.
                    sessionStorage.removeItem('kotoba-last-result');
                    window.location.assign(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/login`);
                  }}
                  disabled={loggingOut}
                  className="flex w-full items-center justify-end gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-[hsl(var(--destructive))] transition-colors hover:bg-[hsl(var(--destructive)/.1)] disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="button-logout"
                >
                  <LogOut size={15} /> {loggingOut ? 'Logging out…' : 'Log out'}
                </button>
              </div>
            </>}
          </div>
        )}
      </div>
    </header>
    <MobileNavDrawer open={menuOpen} navItems={navItems} bonus={bonus} location={location} inviteCount={inviteCount} onClose={() => setMenuOpen(false)} />
    <main className="app-sidebar-offset md:ml-[246px]">{children}</main>
    <CreditsFooter />
    <GlobalFinishPopup />
    </div>;
}

function LevelPill({ level }: { level: Level }) {
  return <span className="mono-label inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold" style={{ color: levelColor[level], backgroundColor: `${levelColor[level]}22` }}>{level}</span>;
}

// Simple Title component
function SectionTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="mb-5 flex items-end justify-between gap-4"><div><p className="mono-label mb-2 text-[hsl(var(--secondary))]">{eyebrow}</p><h2 className="font-serif text-heading-sm">{title}</h2></div>{action}</div>;
}

function StatCard({ icon: Icon, label, value, note, color }: { icon: LucideIcon; label: string; value: string; note: string; color: string }) {
  return <div className="soft-shadow rounded-cards border border-border bg-card p-4"><div className="mb-4 flex items-center justify-between"><span className="mono-label text-muted-foreground">{label}</span><span className="grid size-8 place-items-center rounded-lg" style={{ color, backgroundColor: `${color}1c` }}><Icon size={16} /></span></div><p className="font-serif text-3xl">{value}</p><p className="mt-1 text-xs text-muted-foreground">{note}</p></div>;
}

// One card shape for every word in the Cabinet. Original and "My words"
// cards behave identically — same heart button, both save into the active
// slot — the footer is the only difference: "Original" vs "My words".
function WordCard({ word, source, favorite, onFavorite }: { word: Word; source: 'original' | 'my'; favorite: boolean; onFavorite: () => void }) {
  const mine = source === 'my';
  return <article className="group relative overflow-hidden rounded-cards border border-border bg-card p-5 transition-transform hover:-translate-y-1 hover:shadow-[var(--shadow-md)]" data-testid={`word-card-${word.id}`}>
    <div className="absolute right-0 top-0 h-24 w-24 translate-x-8 -translate-y-8 rounded-full opacity-40" style={{ backgroundColor: levelColor[word.level] }} />
    <div className="relative flex items-start justify-between"><LevelPill level={word.level} /><button onClick={onFavorite} aria-label={favorite ? `Unfavorite ${word.expression}` : `Favorite ${word.expression}`} className={cx('rounded-lg p-1.5 transition-colors hover:bg-muted', favorite ? 'text-[hsl(var(--accent))]' : 'text-muted-foreground')} data-testid={`button-favorite-${word.id}`}><Heart size={17} fill={favorite ? 'currentColor' : 'none'} /></button></div>
    <p className="kanji-display mt-7 text-[2.7rem] leading-none">{word.expression}</p>{word.reading && <p className="mt-2 text-sm font-medium text-[hsl(var(--secondary))]">{word.reading}</p>}<p className="mt-4 line-clamp-2 min-h-10 text-sm leading-relaxed text-muted-foreground">{word.meaning || 'Meaning not added yet — edit in My words.'}</p>
    <div className="mt-5 flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">{mine ? <><BookPlus size={13} /> My words</> : <><BookOpen size={13} /> Original</>}</div>
  </article>;
}

// Personal drawer: form + rows + page for the user's own words. Everything
// below only reads/writes `CustomWord` data — never the built-in
// `vocabulary` array — so the two collections can't leak into each other.
const EMPTY_DRAFT: CustomWordDraft = { expression: '', reading: '', meaning: '', level: 'N5' };

function WordForm({ initial, submitLabel, testIdPrefix, onSubmit, onCancel }: {
  initial: CustomWordDraft;
  submitLabel: string;
  testIdPrefix: string;
  onSubmit: (draft: CustomWordDraft) => void;
  onCancel?: () => void;
}) {
  const [expression, setExpression] = useState(initial.expression);
  const [reading, setReading] = useState(initial.reading);
  const [meaning, setMeaning] = useState(initial.meaning);
  const [level, setLevel] = useState<Level>(initial.level);
  const [error, setError] = useState<string | null>(null);
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!expression.trim()) {
      setError('Japanese expression is required.');
      return;
    }
    onSubmit({ expression, reading, meaning, level });
    if (!onCancel) { setExpression(''); setReading(''); setMeaning(''); setLevel('N5'); }
  };
  return <form onSubmit={handleSubmit} className="space-y-4" data-testid={`${testIdPrefix}-form`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-xs font-bold text-muted-foreground">
        <span className="mb-1.5 block">Japanese <span className="text-[hsl(var(--accent))]">*</span></span>
        <input value={expression} onChange={(event) => { setExpression(event.target.value); setError(null); }} placeholder="e.g. ありがとう" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={`${testIdPrefix}-expression`} />
      </label>
      <label className="block text-xs font-bold text-muted-foreground">
        <span className="mb-1.5 block">Reading / furigana</span>
        <input value={reading} onChange={(event) => { setReading(event.target.value); setError(null); }} placeholder="e.g. ありがとう" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={`${testIdPrefix}-reading`} />
      </label>
    </div>
    <label className="block text-xs font-bold text-muted-foreground">
      <span className="mb-1.5 block">Meaning (optional; needed for quizzes)</span>
      <input value={meaning} onChange={(event) => { setMeaning(event.target.value); setError(null); }} placeholder="e.g. thank you" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={`${testIdPrefix}-meaning`} />
    </label>
    <div>
      <span className="mb-1.5 block text-xs font-bold text-muted-foreground">Level</span>
      <div className="grid grid-cols-5 gap-2">
        {CUSTOM_LEVELS.map((option) => <button key={option} type="button" onClick={() => { setLevel(option); setError(null); }} className={cx('rounded-xl border py-2.5 text-xs font-bold transition-colors', level === option ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border bg-background text-muted-foreground hover:bg-muted')} data-testid={`${testIdPrefix}-level-${option}`}>{option}</button>)}
      </div>
    </div>
    {error && <p className="rounded-lg bg-[hsl(var(--destructive)/.1)] px-3 py-2 text-xs font-semibold text-[hsl(var(--destructive))]" data-testid={`${testIdPrefix}-error`}>{error}</p>}
    <div className="flex gap-2">
      <button type="submit" className="flex flex-1 items-center justify-center gap-2 rounded-buttons bg-[hsl(var(--primary))] px-4 py-2.5 text-sm font-bold text-[hsl(var(--primary-foreground))] transition-transform hover:-translate-y-0.5" data-testid={`${testIdPrefix}-submit`}>{onCancel ? <Check size={15} /> : <Plus size={15} />} {submitLabel}</button>
      {onCancel && <button type="button" onClick={onCancel} className="rounded-buttons border border-border px-4 py-2.5 text-sm font-bold text-muted-foreground hover:bg-muted" data-testid={`${testIdPrefix}-cancel`}>Cancel</button>}
    </div>
  </form>;
}

function CustomWordRow({ word, isEditing, onEdit, onCancelEdit, onSave, onDelete }: {
  word: CustomWord;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: CustomWordDraft) => void;
  onDelete: () => void;
}) {
  if (isEditing) {
    return <div className="rounded-2xl border border-[hsl(var(--secondary))] bg-card p-4" data-testid={`custom-word-edit-${word.id}`}>
      <p className="mono-label mb-4 text-[hsl(var(--secondary))]">Editing entry</p>
      <WordForm initial={word} submitLabel="Save changes" testIdPrefix={`edit-${word.id}`} onSubmit={onSave} onCancel={onCancelEdit} />
    </div>;
  }
  return <article className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-4 transition-transform hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]" data-testid={`custom-word-${word.id}`}>
    <div className="grid size-12 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: `${levelColor[word.level]}1f` }}>
      <span className="kanji-display text-xl">{word.expression}</span>
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2"><p className="truncate font-semibold">{word.reading || word.expression}</p><LevelPill level={word.level} /></div>
      <p className="truncate text-sm text-muted-foreground">{word.meaning || 'Meaning not added yet — edit in My words.'}</p>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <button onClick={onEdit} aria-label={`Edit ${word.expression}`} className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" data-testid={`button-edit-custom-${word.id}`}><Pencil size={15} /></button>
      <button onClick={onDelete} aria-label={`Delete ${word.expression}`} className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-[hsl(var(--destructive)/.12)] hover:text-[hsl(var(--destructive))]" data-testid={`button-delete-custom-${word.id}`}><Trash2 size={15} /></button>
    </div>
  </article>;
}

function CustomWords() {
  const { words, add, update, remove } = useCustomWords();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return words;
    return words.filter((word) => `${word.expression} ${word.reading} ${word.meaning}`.toLowerCase().includes(q));
  }, [words, query]);
  const handleSave = (id: string, draft: CustomWordDraft) => { update(id, draft); setEditingId(null); };
  const handleDelete = (word: CustomWord) => {
    if (window.confirm(`Delete "${word.expression}" from your drawer? This cannot be undone.`)) remove(word.id);
  };
  return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="page-custom-words">
    <section className="relative overflow-hidden rounded-[1.75rem] bg-[hsl(var(--secondary))] px-6 py-8 text-[hsl(var(--secondary-foreground))] md:px-10 md:py-11">
      <div className="absolute -right-16 -top-24 size-72 rounded-full border-[28px] border-[hsl(var(--accent)/.9)] opacity-80" /><div className="absolute -bottom-16 right-24 size-36 rounded-full border-[18px] border-[hsl(var(--accent)/.4)]" />
      <div className="relative max-w-2xl">
        <p className="mono-label mb-5 text-[hsl(var(--secondary-foreground)/.55)]">Personal drawer / 002</p>
        <h1 className="font-serif text-5xl leading-[.96] tracking-[-.06em] md:text-7xl">A drawer of<br /><em className="text-[hsl(var(--accent))]">your own.</em></h1>
        <p className="mt-6 max-w-md text-sm leading-6 text-[hsl(var(--secondary-foreground)/.68)]">Words you add live here — and show up in the Cabinet too, clearly tagged as yours. Add a word, fix it when it changes, or clear it out any time.</p>
      </div>
      <span className="absolute bottom-6 right-8 hidden font-mono text-[10px] tracking-[.15em] text-[hsl(var(--secondary-foreground)/.38)] md:block">追加 / YOURS</span>
    </section>
    <div className="mt-8 grid gap-6 lg:grid-cols-[.85fr_1.15fr] lg:items-start">
      <section className="soft-shadow rounded-[1.75rem] border border-border bg-card p-6 md:p-8" data-testid="custom-add-card">
        <p className="mono-label mb-2 text-muted-foreground">Add an entry</p>
        <h2 className="font-serif text-3xl">A new word.</h2>
        <div className="mt-6"><WordForm initial={EMPTY_DRAFT} submitLabel="Add to drawer" testIdPrefix="add" onSubmit={add} /></div>
        <p className="mt-5 text-xs leading-5 text-muted-foreground">Stored in its own drawer, apart from the cabinet's built-in {vocabulary.length.toLocaleString()} words — and shown in the Cabinet too, tagged “My words”.</p>
      </section>
      <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-8" data-testid="custom-list-card">
        <div className="mb-5">
          <p className="mono-label mb-2 text-muted-foreground">In the drawer</p>
          <h2 className="font-serif text-3xl">{words.length === 0 ? 'Still empty.' : words.length === 1 ? 'One word, so far.' : `${words.length} words inside`}</h2>
        </div>
        <label className="relative mb-4 block"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your additions…" className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none transition-shadow focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid="input-custom-search" /></label>
        {words.length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center" data-testid="custom-empty-state"><BookPlus className="mx-auto text-muted-foreground" size={26} /><h3 className="mt-4 font-serif text-2xl">This drawer is empty.</h3><p className="mt-2 text-sm text-muted-foreground">Add your first word with the form and it will keep a seat here.</p></div> : filtered.length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center"><p className="font-serif text-xl">No matches in the drawer.</p><button onClick={() => setQuery('')} className="mt-2 text-xs font-bold text-[hsl(var(--secondary))] underline-offset-2 hover:underline" data-testid="button-custom-clear-search">Clear search</button></div> : <div className="max-h-[620px] space-y-3 overflow-y-auto pr-1">{filtered.map((word) => <CustomWordRow key={word.id} word={word} isEditing={editingId === word.id} onEdit={() => setEditingId(word.id)} onCancelEdit={() => setEditingId(null)} onSave={(draft) => handleSave(word.id, draft)} onDelete={() => handleDelete(word)} />)}</div>}
      </section>
    </div>
  </div>;
}

function SaveSlotBar({ wordLists }: { wordLists: ReturnType<typeof useWordLists> }) {
  const { lists, activeList, activeId, setActiveId, createList, renameList, deleteList, slotLimitReached, maxSlots } = wordLists;
  const [open, setOpen] = useState(false);
  if (!activeList) return null;
  const handleCreate = () => {
    if (slotLimitReached) {
      window.alert(`You can only have ${maxSlots} save slots. Delete one before creating a new one.`);
      return;
    }
    const name = window.prompt('Name your new save slot:', `Save ${lists.length + 1}`);
    if (name && name.trim()) createList(name);
  };
  const handleRename = (list: WordList) => {
    const name = window.prompt('Rename this save slot:', list.name);
    if (name && name.trim()) renameList(list.id, name);
  };
  const handleDelete = (list: WordList) => {
    if (lists.length <= 1) return;
    if (window.confirm(`Delete "${list.name}" and its ${list.wordIds.length} saved word${list.wordIds.length === 1 ? '' : 's'}? This cannot be undone.`)) deleteList(list.id);
  };
  return <div className="relative">
    <button onClick={() => setOpen(!open)} className="flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-semibold hover:bg-muted" data-testid="button-save-slot-menu">
      <FolderOpen size={16} className="text-[hsl(var(--accent))]" />
      <span className="max-w-[9rem] truncate">{activeList.name}</span>
      <span className="mono-label text-muted-foreground">{activeList.wordIds.length}</span>
      <ChevronDown size={14} className={cx('text-muted-foreground transition-transform', open && 'rotate-180')} />
    </button>
    {open && <>
      <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
      <div className="absolute left-0 top-[calc(100%+6px)] z-40 w-72 rounded-cards border border-border bg-card p-2 shadow-[var(--shadow-md)]" data-testid="menu-save-slots">
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <p className="mono-label text-muted-foreground">Save slots</p>
          <span className="mono-label text-muted-foreground">{lists.length}/{maxSlots}</span>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {lists.map((list) => <div key={list.id} className={cx('group flex items-center gap-1 rounded-lg px-2 py-2', list.id === activeId ? 'bg-[hsl(var(--secondary)/.13)]' : 'hover:bg-muted')}>
            <button onClick={() => { setActiveId(list.id); setOpen(false); }} className="flex flex-1 items-center justify-between gap-2 text-left" data-testid={`button-select-slot-${list.id}`}>
              <span className={cx('truncate text-sm', list.id === activeId ? 'font-bold text-[hsl(var(--secondary))]' : 'font-medium')}>{list.name}</span>
              <span className="mono-label shrink-0 text-muted-foreground">{list.wordIds.length}</span>
            </button>
            <button onClick={() => handleRename(list)} aria-label={`Rename ${list.name}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" data-testid={`button-rename-slot-${list.id}`}><Pencil size={13} /></button>
            {lists.length > 1 && <button onClick={() => handleDelete(list)} aria-label={`Delete ${list.name}`} className="rounded-md p-1.5 text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/.14)]" data-testid={`button-delete-slot-${list.id}`}><Trash2 size={13} /></button>}
          </div>)}
        </div>
        <button
          onClick={handleCreate}
          disabled={slotLimitReached}
          title={slotLimitReached ? `Limit of ${maxSlots} save slots reached` : undefined}
          className={cx(
            'mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed px-2 py-2 text-sm font-semibold',
            slotLimitReached
              ? 'cursor-not-allowed border-border/60 text-muted-foreground/50'
              : 'border-border text-muted-foreground hover:border-[hsl(var(--secondary))] hover:text-[hsl(var(--secondary))]',
          )}
          data-testid="button-create-slot"
        >
          <Plus size={15} /> {slotLimitReached ? `Limit reached (${maxSlots})` : 'New save slot'}
        </button>
      </div>
    </>}
  </div>;
}

function Cabinet() {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<Level | 'ALL' | 'FAVORITES'>('ALL');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const wordLists = useWordLists();
  const { activeList, toggleWord } = wordLists;
  const { words: myCustomWords } = useCustomWords();
  const { history, clearHistory } = useCabinetHistory();
  const { user } = useAuth();
  // How many word cards the shelf shows at once — the user picks, and the pick
  // is remembered for this account. Defaults to a calm 4.
  const [pageSize, setPageSize] = useState<number>(() => loadCabinetPageSize(user?.uid));
  const [page, setPage] = useState(0);
  const [ready, setReady] = useState(false);
  // Random shelf: the filtered list is shuffled with a per-mount seed, so the
  // order changes between visits but stays stable while paging (no repeats).
  const [shuffleOn, setShuffleOn] = useState<boolean>(() => loadCabinetShuffle(user?.uid));
  const [shuffleSeed, setShuffleSeed] = useState<number>(() => Math.floor(Math.random() * 2147483646) + 1);
  const choosePageSize = (size: number) => { setPageSize(size); saveCabinetPageSize(user?.uid, size); setPage(0); };
  const reshuffle = () => { setShuffleSeed(Math.floor(Math.random() * 2147483646) + 1); setPage(0); };
  const toggleShuffle = () => { const next = !shuffleOn; setShuffleOn(next); saveCabinetShuffle(user?.uid, next); if (next) reshuffle(); else setPage(0); };

  useEffect(() => { const id = window.setTimeout(() => setReady(true), 180); return () => window.clearTimeout(id); }, []);

  const bonus = useMemo(() => computeBonusSummary(history), [history]);
  const lastEntry = history[history.length - 1];
  const lastScorePct = lastEntry ? Math.round((lastEntry.score / lastEntry.total) * 100) : null;

  const resetProgress = () => {
    if (!window.confirm('Reset your score history and daily bonus points across devices? This cannot be undone.')) return;
    clearHistory();
  };

  const activeWordIds = activeList?.wordIds ?? [];
  const myWords = useMemo(() => customWordsToWords(myCustomWords), [myCustomWords]);
  const myWordIds = useMemo(() => new Set(myWords.map((word) => word.id)), [myWords]);
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const matches = (word: Word) =>
      `${word.expression} ${word.reading} ${word.meaning}`.toLowerCase().includes(q) &&
      (level === 'ALL' || word.level === level);
    if (favoritesOnly) {
      const savedMine = myWords.filter((word) => matches(word) && activeWordIds.includes(word.id));
      const savedOriginals = vocabulary.filter((word) => matches(word) && activeWordIds.includes(word.id));
      return [...savedMine, ...savedOriginals];
    }
    const mine = myWords.filter(matches);
    const originals = vocabulary.filter(matches);
    return [...mine, ...originals];
  }, [query, level, favoritesOnly, activeWordIds, myWords]);

  const ordered = useMemo(() => (shuffleOn ? seededShuffle(filtered, shuffleSeed) : filtered), [filtered, shuffleOn, shuffleSeed]);
  const pages = totalPagesFor(filtered.length, pageSize);
  const currentPage = clampPage(page, pages);          // survives filter results shrinking under us
  const shown = ordered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const rangeFrom = filtered.length === 0 ? 0 : currentPage * pageSize + 1;
  const rangeTo = Math.min((currentPage + 1) * pageSize, filtered.length);

  return <div className="mx-auto max-w-[1400px] px-5 py-8 pb-28 md:px-10 md:py-12 md:pb-12">
    <section className="relative overflow-hidden rounded-[1.75rem] bg-[hsl(var(--primary))] px-6 py-8 text-[hsl(var(--primary-foreground))] md:px-10 md:py-11">
      <div className="absolute -right-16 -top-24 size-72 rounded-full border-[28px] border-[hsl(var(--accent)/.9)] opacity-80" /><div className="absolute -bottom-16 right-24 size-36 rounded-full border-[18px] border-[hsl(var(--secondary)/.55)]" />
      <div className="relative max-w-2xl"><p className="mono-label mb-5 text-[hsl(var(--primary-foreground)/.55)]">Your vocabulary cabinet / 001</p><h1 className="font-serif text-5xl leading-[.96] tracking-[-.06em] md:text-7xl">A little room<br /><em className="text-[hsl(var(--accent))]">for new words.</em></h1><p className="mt-6 max-w-md text-sm leading-6 text-[hsl(var(--primary-foreground)/.66)]">A quiet, tactile place to browse the Japanese you want to remember — from N5 foundations to N1 nuance.</p></div>
      <div className="relative mt-8 flex flex-wrap gap-2">
        <Link href="/quiz" className="inline-flex items-center gap-3 rounded-buttons bg-[hsl(var(--accent))] px-4 py-3 text-sm font-bold text-[hsl(var(--foreground))] transition-transform hover:-translate-y-0.5" data-testid="button-hero-quiz">Start a quick round <ArrowRight size={16} /></Link>
        <Link href="/exam" className="inline-flex items-center gap-2 rounded-buttons border border-[hsl(var(--primary-foreground)/.2)] px-4 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))] transition-colors hover:bg-[hsl(var(--primary-foreground)/.1)]" data-testid="button-hero-jlpt"><GraduationCap size={16} /> Practice JLPT</Link>
      </div>
      <span className="absolute bottom-6 right-8 hidden font-mono text-[10px] tracking-[.15em] text-[hsl(var(--primary-foreground)/.38)] md:block">言葉 / WORDS</span>
    </section>
    <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4" data-testid="cabinet-stats">
      <StatCard icon={Layers3} label="In the cabinet" value={(vocabulary.length + myWords.length).toLocaleString()} note={myWords.length > 0 ? `${myWords.length} of them yours` : 'across five levels'} color="hsl(194 71% 42%)" />
      <StatCard icon={Heart} label="Kept close" value={activeWordIds.length.toString().padStart(2, '0')} note={activeList ? `in "${activeList.name}"` : 'your saved words'} color="hsl(11 77% 61%)" />
      <StatCard icon={Gift} label="Today's bonus" value={`${bonus.today.points} pts`} note={bonus.today.cleared ? `full clear · +${DAILY_CLEAR_BONUS} bonus` : `${bonus.tasksDone}/${bonus.tasksTotal} tasks done`} color="hsl(38 68% 59%)" />
      <StatCard icon={Target} label="Last score" value={lastScorePct !== null ? `${lastScorePct}%` : '—'} note={lastEntry ? `on ${lastEntry.date}` : 'no quizzes yet'} color="hsl(69 73% 45%)" />
    </section>
    {history.length > 0 && <div className="mt-3 flex justify-end"><button onClick={resetProgress} className="text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-testid="button-reset-progress">Reset history &amp; bonus points</button></div>}
    <section className="mt-12"><SectionTitle eyebrow="The cabinet" title="Browse your words" action={<span className="hidden text-xs text-muted-foreground sm:block">{filtered.length.toLocaleString()} entries found</span>} />
      <div className="mb-3 flex flex-wrap items-center gap-2"><span className="mono-label text-muted-foreground">Saving into</span><SaveSlotBar wordLists={wordLists} /><BulkWordImport originals={vocabulary} customWords={myCustomWords} ready={wordLists.importReady} slotLimitReached={wordLists.slotLimitReached} onImport={wordLists.importWords} onImported={() => { setFavoritesOnly(true); setLevel('ALL'); setQuery(''); setPage(0); }} /></div>
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search kanji, reading, or meaning…" className="h-11 w-full rounded-xl border border-border bg-card pl-10 pr-4 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid="input-search" /></label>
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar"><button onClick={() => { setFavoritesOnly(!favoritesOnly); setPage(0); }} className={cx('flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-semibold', favoritesOnly ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.16)]' : 'border-border bg-card')} data-testid="button-favorites-filter"><Heart size={15} fill={favoritesOnly ? 'currentColor' : 'none'} /> Saved</button><button onClick={toggleShuffle} aria-pressed={shuffleOn} title="Shuffle the order of the cards" className={cx('flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-colors', shuffleOn ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.14)] text-[hsl(var(--secondary))]' : 'border-border bg-card text-muted-foreground')} data-testid="button-shuffle-toggle"><Shuffle size={15} /> Random</button>{shuffleOn && <button onClick={reshuffle} title="New random mix" className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-muted" data-testid="button-reshuffle"><RefreshCw size={15} /></button>}<span className="h-11 w-px bg-border" />{levels.map((item) => <button key={item} onClick={() => { setLevel(item); setPage(0); }} className={cx('h-11 shrink-0 rounded-xl border px-3 text-xs font-bold', level === item ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border-border bg-card text-muted-foreground')} data-testid={`filter-${item}`}>{item === 'ALL' ? 'All levels' : item}</button>)}</div>
      </div>
      {!ready ? <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">{Array.from({ length: Math.min(8, pageSize) }, (_, i) => i + 1).map((item) => <div key={item} className="h-64 animate-pulse rounded-2xl bg-muted" />)}</div> : filtered.length === 0 ? <div className="ruled rounded-2xl border border-dashed border-border px-6 py-20 text-center"><CircleHelp className="mx-auto text-muted-foreground" size={27} /><h3 className="mt-4 font-serif text-2xl">Nothing in this drawer.</h3><p className="mt-2 text-sm text-muted-foreground">Try another search or put a few saved words back in view.</p><button onClick={() => { setQuery(''); setLevel('ALL'); setFavoritesOnly(false); setPage(0); }} className="mt-5 rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-sm font-semibold text-[hsl(var(--primary-foreground))]" data-testid="button-clear-filters">Clear filters</button></div> : <><div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4" data-testid="cabinet-grid">{shown.map((word, index) => <div key={word.id} className="animate-rise" style={{ animationDelay: `${Math.min(index, 7) * 45}ms` }}><WordCard word={word} source={myWordIds.has(word.id) ? 'my' : 'original'} favorite={activeWordIds.includes(word.id)} onFavorite={() => toggleWord(word.id)} /></div>)}</div>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3" data-testid="cabinet-pagination">
          <div className="flex flex-wrap items-center gap-1.5"><span className="mono-label mr-1 text-muted-foreground">Cards per page</span>{CABINET_PAGE_SIZES.map((size) => <button key={size} onClick={() => choosePageSize(size)} aria-pressed={size === pageSize} className={cx('h-9 w-11 rounded-lg border text-xs font-bold transition-colors', size === pageSize ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border-border bg-card text-muted-foreground hover:bg-muted')} data-testid={`button-page-size-${size}`}>{size}</button>)}</div>
          <div className="flex items-center gap-2">
            <span className="mono-label text-muted-foreground" data-testid="text-cabinet-page">{`${rangeFrom}\u2013${rangeTo} of ${filtered.length.toLocaleString()} \u00b7 page ${currentPage + 1}/${pages}`}</span>
            <button onClick={() => setPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0} aria-label="Previous page" className="grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-page-prev"><ChevronLeft size={16} /></button>
            <button onClick={() => setPage(Math.min(pages - 1, currentPage + 1))} disabled={currentPage >= pages - 1} aria-label="Next page" className="grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-page-next"><ChevronRight size={16} /></button>
          </div>
        </div></>}
    </section>
  </div>;
}

function QuizSetup() {
  return <div className="mx-auto grid max-w-[1500px] gap-6 px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12 lg:grid-cols-2 lg:items-start">
    <RankedSetup />
    <QuizSetupPanel title="Casual" />
  </div>;
}

function QuizSetupPanel({ title }: { title: 'Casual' | 'Ranked' }) {
  const testId = (id: string) => title === 'Casual' ? id : `ranked-${id}`;
  const fieldId = (id: string) => title === 'Casual' ? id : `ranked-${id}`;
  const search = useSearch();
  const { seen: discovered, ready: discoveryReady } = useCardProgress();
  const [discoveryFilter, setDiscoveryFilter] = useState<DiscoveryFilter>(() => parseDiscoveryFilter(new URLSearchParams(search).get('discovery')));
  const [, setLocation] = useLocation();
  const [count, setCount] = useState(10);
  const [customCount, setCustomCount] = useState('');
  const [decks, setDecks] = useState<Deck[]>(() => {
    const requested = (new URLSearchParams(search).get('decks') || 'ALL').split(',').filter((deck): deck is Deck => ALL_DECKS.includes(deck as Deck));
    return requested.length ? requested : ['ALL'];
  });
  const [direction, setDirection] = useState<'meaning' | 'word' | 'reading'>('meaning');
  const [timerMode, setTimerMode] = useState<'question' | 'session'>('question');
  const [cardSecondsInput, setCardSecondsInput] = useState('15');
  const [sessionMinutesInput, setSessionMinutesInput] = useState('3');
  const [lists] = useState<WordList[]>(() => loadWordLists());
  const [savedListId, setSavedListId] = useState<string>(() => loadActiveListId(loadWordLists()));
  const savedList = lists.find((item) => item.id === savedListId);
  const [myWords] = useState<Word[]>(() => customWordsToWords(loadCustomWords()));
  const cardSeconds = Math.min(Math.max(Math.round(Number(cardSecondsInput)) || 15, 3), 120);
  const sessionMinutes = Math.min(Math.max(Math.round(Number(sessionMinutesInput)) || 3, 1), 180);
  const totalSaved = lists.reduce((sum, item) => sum + item.wordIds.length, 0);

  const availableWords = useMemo(() => {
    if (decks.includes('ALL')) return vocabulary;
    const pool = new Map<string, Word>();
    const selectedLevels = decks.filter((deck): deck is Level => deck !== 'ALL' && deck !== 'FAVORITES' && deck !== 'MY_WORDS');
    for (const word of vocabulary) if (selectedLevels.includes(word.level)) pool.set(word.id, word);
    if (decks.includes('FAVORITES')) {
      for (const word of [...vocabulary, ...myWords]) if (savedList?.wordIds.includes(word.id)) pool.set(word.id, word);
    }
    if (decks.includes('MY_WORDS')) for (const word of myWords) pool.set(word.id, word);
    return [...pool.values()];
  }, [decks, savedList, myWords]);
  const eligibleWords = useMemo(() => filterDiscovered(availableWords.filter(isQuizReadyWord), wordProgressKey, discovered, discoveryFilter), [availableWords, discovered, discoveryFilter]);
  const available = eligibleWords.length;

  const toggleDeck = (deck: Deck) => {
    if (deck === 'ALL') { setDecks(['ALL']); return; }
    const rest = decks.filter((item) => item !== 'ALL');
    const isSelected = rest.includes(deck);
    if (isSelected && rest.length === 1) return;
    setDecks(isSelected ? rest.filter((item) => item !== deck) : [...rest, deck]);
  };
  useEffect(() => { setCount((current) => Math.min(Math.max(1, current), Math.max(available, 1))); }, [available]);
  return <div className="w-full">
    <div className="grid gap-8 lg:grid-cols-1 lg:items-start">
       <section className="animate-pop relative overflow-hidden rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_18px_50px_hsl(var(--primary)/.05)] md:p-8" data-testid={testId('quiz-setup')}>
        <div><h2 className="font-serif text-3xl">{title}</h2></div>
        <div className="mt-6"><DiscoverySummary keys={availableWords.map(wordProgressKey)} title="Your selected drawers" /><DiscoverySyncNote /><div className="mt-4"><DiscoveryFilterControl value={discoveryFilter} onChange={setDiscoveryFilter} disabled={!discoveryReady} /></div>
          {discoveryReady && available === 0 && <p className="mt-3 text-sm text-muted-foreground" role="status">No {discoveryFilter === 'all' ? 'matching' : discoveryFilter} cards in these drawers. Choose another filter or deck.</p>}
          {availableWords.some((word) => !isQuizReadyWord(word)) && <p className="mt-3 text-xs text-muted-foreground">{availableWords.filter((word) => !isQuizReadyWord(word)).length} {title === 'Ranked' ? 'Ranked ' : ''}cards need a meaning before quizzes. They remain saved and available for review. <Link href="/custom" className="font-bold underline">Edit My words</Link></p>}
          <Link href="/review" className="mt-3 inline-block text-xs font-bold underline">Browse and review cards</Link></div>
        <div className="mt-8 space-y-7">
           <div><label className="mb-3 block text-sm font-bold">How many cards?</label><div className="grid grid-cols-4 gap-2">{[5, 10, 20, 30].map((option) => <button key={option} onClick={() => { setCount(Math.min(option, Math.max(available, 1))); setCustomCount(''); }} className={cx(!customCount && count === option ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted', 'rounded-xl border py-3 text-sm font-bold')} data-testid={testId(`quiz-count-${option}`)}>{option}</button>)}</div><div className="mt-3 flex items-center gap-3"><label htmlFor={fieldId('quiz-custom-count')} className="text-xs font-semibold text-muted-foreground">Custom</label><input id={fieldId('quiz-custom-count')} type="number" min="1" max={available} value={customCount} onChange={(event) => { const raw = event.target.value; setCustomCount(raw); const next = Number(raw); if (raw && Number.isFinite(next)) setCount(Math.min(Math.max(Math.round(next), 1), Math.max(available, 1))); }} placeholder={`1–${available}`} className="h-10 w-28 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={testId('input-quiz-custom-count')} /><span className="text-xs text-muted-foreground">cards, up to {available.toLocaleString()}</span></div></div>
           <div><label className="mb-3 block text-sm font-bold">Open drawers</label><div className="grid grid-cols-3 gap-2">{levels.slice(1).map((option) => <button key={option} onClick={() => toggleDeck(option)} aria-pressed={decks.includes(option)} className={cx('rounded-xl border py-3 text-sm font-bold', decks.includes(option) ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={testId(`quiz-level-${option}`)}>{option}</button>)}<button onClick={() => toggleDeck('ALL')} aria-pressed={decks.length === 1 && decks[0] === 'ALL'} className={cx('rounded-xl border py-3 text-sm font-bold', decks.length === 1 && decks[0] === 'ALL' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-level-all')}>Mixed</button><button onClick={() => toggleDeck('FAVORITES')} disabled={totalSaved === 0} aria-pressed={decks.includes('FAVORITES')} className={cx('flex items-center justify-center gap-1.5 rounded-xl border py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40', decks.includes('FAVORITES') ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-level-favorites')}><Heart size={14} fill={decks.includes('FAVORITES') ? 'currentColor' : 'none'} /> Saved</button><button onClick={() => toggleDeck('MY_WORDS')} disabled={myWords.length === 0} title={myWords.length === 0 ? 'Add words in "My words" first' : undefined} aria-pressed={decks.includes('MY_WORDS')} className={cx('flex items-center justify-center gap-1.5 rounded-xl border py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40', decks.includes('MY_WORDS') ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-level-my-words')}><BookPlus size={14} /> My words</button></div>
             {decks.includes('FAVORITES') && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted p-2"><span className="mono-label px-1 text-muted-foreground">Which save slot?</span><div className="flex flex-1 flex-wrap gap-1.5">{lists.map((item) => <button key={item.id} onClick={() => setSavedListId(item.id)} className={cx('rounded-lg border px-2.5 py-1.5 text-xs font-bold', savedListId === item.id ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.16)]' : 'border-border bg-card text-muted-foreground hover:bg-muted')} data-testid={testId(`quiz-saved-list-${item.id}`)}>{item.name} <span className="opacity-60">({item.wordIds.length})</span></button>)}</div></div>}
             <p className="mt-2 text-xs text-muted-foreground">{available.toLocaleString()} cards available{discoveryFilter !== 'all' ? ` · ${discoveryFilter} only` : ''}{decks.includes('MY_WORDS') ? ` — including ${myWords.length} of your word${myWords.length === 1 ? '' : 's'}` : ''}</p><p className="mt-1 text-xs text-muted-foreground">Tip: combine drawers freely — e.g. N4 + My words. Mixed stays on its own.</p></div>
           <div><label className="mb-3 block text-sm font-bold">Quiz type</label><div className="grid grid-cols-3 gap-2"><button onClick={() => setDirection('meaning')} className={cx('flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold', direction === 'meaning' ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-direction-meaning')}><BookOpen size={15} /> Choose meaning</button><button onClick={() => setDirection('word')} className={cx('flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold', direction === 'word' ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-direction-word')}><Keyboard size={15} /> Choose Japanese</button><button onClick={() => setDirection('reading')} className={cx('flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold', direction === 'reading' ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-direction-reading')}><Volume2 size={15} /> Choose reading (読み方)</button></div><p className="mt-2 text-xs text-muted-foreground">Japanese choices include kanji and furigana.</p></div>
           <div><label className="mb-3 block text-sm font-bold">Timer</label><div className="grid grid-cols-2 gap-2"><button onClick={() => setTimerMode('question')} className={cx('flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold', timerMode === 'question' ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-timer-question')}><Clock3 size={15} /> Per question</button><button onClick={() => setTimerMode('session')} className={cx('flex items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold', timerMode === 'session' ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={testId('quiz-timer-session')}><Clock3 size={15} /> Whole session</button></div>
             {timerMode === 'question' ? <div className="mt-3 flex items-center gap-3"><label htmlFor={fieldId('quiz-card-seconds')} className="text-xs font-semibold text-muted-foreground">Seconds per card</label><input id={fieldId('quiz-card-seconds')} type="number" min="3" max="120" value={cardSecondsInput} onChange={(event) => setCardSecondsInput(event.target.value)} onBlur={() => setCardSecondsInput(String(cardSeconds))} className="h-10 w-24 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={testId('input-quiz-card-seconds')} /><span className="text-xs text-muted-foreground">seconds (3–120)</span></div> : <div className="mt-3 flex items-center gap-3"><label htmlFor={fieldId('quiz-session-minutes')} className="text-xs font-semibold text-muted-foreground">Minutes for the round</label><input id={fieldId('quiz-session-minutes')} type="number" min="1" max="180" value={sessionMinutesInput} onChange={(event) => setSessionMinutesInput(event.target.value)} onBlur={() => setSessionMinutesInput(String(sessionMinutes))} className="h-10 w-24 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid={testId('input-quiz-session-minutes')} /><span className="text-xs text-muted-foreground">minutes (1–180)</span></div>}
             <p className="mt-2 text-xs text-muted-foreground">{timerMode === 'question' ? `Each card gives you ${cardSeconds} second${cardSeconds === 1 ? '' : 's'} to answer.` : `The whole round ends after ${sessionMinutes} minute${sessionMinutes === 1 ? '' : 's'}, however many cards you get to.`}</p></div>
        </div>
        <div className="mt-8 flex items-center justify-between gap-4 rounded-2xl border border-border bg-muted/50 p-4" data-testid={testId('quiz-answer-sound-setting')}><span className="mono-label text-muted-foreground">Sounds</span><SoundSettings mode="quiz" /></div>
        <button onClick={() => setLocation(`/quiz?run=1&discovery=${discoveryFilter}&count=${Math.min(Math.max(1, Math.floor(count)), available)}&decks=${decks.join(',')}&direction=${direction}&timerMode=${timerMode}&cardSeconds=${cardSeconds}&sessionSeconds=${sessionMinutes * 60}${decks.includes('FAVORITES') ? `&listId=${savedListId}` : ''}`)} disabled={!discoveryReady || available === 0} className="mt-9 flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] py-3.5 text-sm font-bold text-[hsl(var(--primary-foreground))] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0" data-testid={testId('button-start-quiz')}><Play size={16} fill="currentColor" /> Start {Math.min(count, available)}-card round <ArrowRight size={16} /></button>
      </section>
    </div>
  </div>;
}

function QuizActive({ params }: { params: URLSearchParams }) {
  const { seen: discovered } = useCardProgress();
  const discoveryFilter = parseDiscoveryFilter(params.get('discovery'));
  const [, setLocation] = useLocation();
  const count = Number(params.get('count')) || 10;
  const rawDecks = (params.get('decks') || 'ALL').split(',').filter((item): item is Deck => (ALL_DECKS as string[]).includes(item));
  const decks: Deck[] = rawDecks.length > 0 ? rawDecks : ['ALL'];
  const directionParam = params.get('direction');
  const direction = directionParam === 'word' ? 'word' : directionParam === 'reading' ? 'reading' : 'meaning';
  const timerMode = params.get('timerMode') === 'session' ? 'session' : 'question';
  const cardSeconds = Number(params.get('cardSeconds')) || 15;
  const sessionSeconds = Number(params.get('sessionSeconds')) || 180;
  const listId = params.get('listId');
  
  const { recordHistory } = useCabinetHistory();
  const { user } = useAuth();
  const soundOwner = user?.uid ?? 'anonymous';

  const [savedWordIds] = useState<string[]>(() => {
    if (!listId) return [];
    return loadWordLists().find((item) => item.id === listId)?.wordIds ?? [];
  });
  const [myWords] = useState<Word[]>(() => customWordsToWords(loadCustomWords()));
  const [pool] = useState<Word[]>(() => {
    if (decks.includes('ALL')) return vocabulary;
    const seen = new Set<string>();
    const next: Word[] = [];
    const collect = (item: Word) => { if (!seen.has(item.id)) { seen.add(item.id); next.push(item); } };
    const selectedLevels = decks.filter((deck): deck is Level => deck !== 'ALL' && deck !== 'FAVORITES' && deck !== 'MY_WORDS');
    for (const item of vocabulary) if (selectedLevels.includes(item.level)) collect(item);
    if (decks.includes('FAVORITES')) {
      for (const item of vocabulary) if (savedWordIds.includes(item.id)) collect(item);
      for (const item of myWords) if (savedWordIds.includes(item.id)) collect(item);
    }
    if (decks.includes('MY_WORDS')) for (const item of myWords) collect(item);
    return next;
  });
  const [cards] = useState<Word[]>(() => shuffle(filterDiscovered(pool.filter(isQuizReadyWord), wordProgressKey, discovered, discoveryFilter)).slice(0, Math.max(1, Math.floor(count))));
  const [index, setIndex] = useState(0);
  const [sessionSeed] = useState(() => Math.floor(Math.random() * 2147483646) + 1);
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<QuizResult['answers']>([]);
  const [combo, setCombo] = useState(0);
  const [timeLeft, setTimeLeft] = useState(cardSeconds);
  const [sessionTimeLeft, setSessionTimeLeft] = useState(sessionSeconds);
  const finishedRef = useRef(false);

  const word = cards[index];
  const choiceSeed = (sessionSeed + (index + 1) * 7919) % 2147483646 || 1;
  const distractorSource = useMemo(
    () => (decks.includes('MY_WORDS') && myWords.length > 0 ? [...vocabulary, ...myWords] : vocabulary).filter(isQuizReadyWord),
    [myWords],
  );
  const choices = useMemo(() => {
    if (!word) return [];
    // Several different kanji can share a reading (e.g. 公立/効率 = こうりつ), so for the
    // reading quiz the distractors must also have distinct readings from each other and
    // from the answer — otherwise two choices could look identical to the player.
    const label = (item: Word) => direction === 'reading' ? item.reading.normalize('NFKC').trim().toLowerCase() : null;
    const seen = new Set<string>();
    const answerLabel = label(word);
    if (answerLabel) seen.add(answerLabel);
    const distractors: Word[] = [];
    for (const item of seededShuffle(distractorSource.filter((candidate) => wordProgressKey(candidate) !== wordProgressKey(word)), choiceSeed)) {
      if (distractors.length >= 3) break;
      const itemLabel = label(item);
      if (itemLabel && seen.has(itemLabel)) continue;
      if (itemLabel) seen.add(itemLabel);
      distractors.push(item);
    }
    return seededShuffle([word, ...distractors], choiceSeed + 1);
  }, [word, distractorSource, choiceSeed, direction]);
  const finish = (finalResults: QuizResult['answers']) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const score = finalResults.filter((item) => item.correct).length;
    sessionStorage.setItem('kotoba-last-result', JSON.stringify({ score, total: cards.length, answers: finalResults, level: formatDecks(decks), finishedAt: new Date().toISOString() } satisfies QuizResult));
    recordHistory({ date: toDateKey(new Date()), score, total: cards.length, level: formatDecks(decks) });
    setLocation('/results');
  };
  const answer = (choice: Word) => {
    if (!word || selected) return;
    const choiceLabel = direction === 'meaning' ? choice.meaning : direction === 'reading' ? choice.reading : choice.expression;
    const correct = choice.id === word.id;
    const comboSlot = `quizCombo${Math.min(combo + 1, 5)}` as SoundSlot;
    setSelected(choice.id);
    void playUserSound(soundOwner, correct ? comboSlot : 'quizIncorrect', () => playFeedback(correct ? feedbackAudio.combo[Math.min(combo, 4)] : feedbackAudio.wrong));
    setCombo((current) => correct ? current + 1 : 0);
    setResults((current) => [...current, { word, choice: choiceLabel, correct }]);
  };
  const timeout = () => {
    if (!word || selected) return;
    setSelected('TIMEOUT');
    void playUserSound(soundOwner, 'quizIncorrect', () => playFeedback(feedbackAudio.wrong));
    setCombo(0);
    setResults((current) => [...current, { word, choice: '(no answer)', correct: false }]);
  };

  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => {
    if (timerMode !== 'question') return;
    setTimeLeft(cardSeconds);
    if (selected) return;
    let remaining = cardSeconds;
    const id = window.setInterval(() => {
      if (selectedRef.current) { window.clearInterval(id); return; }
      remaining -= 1;
      setTimeLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(id);
        timeout();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [index, timerMode, cardSeconds]);

  useEffect(() => {
    if (timerMode !== 'session' || cards.length === 0) return;
    if (sessionTimeLeft <= 0) {
      const withCurrent = word ? (selected ? results : [...results, { word, choice: '(no answer)', correct: false }]) : results;
      finish(withCurrent);
      return;
    }
    const id = setTimeout(() => setSessionTimeLeft((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [sessionTimeLeft, timerMode]);

  const [canAdvance, setCanAdvance] = useState(false);
  useEffect(() => {
    setCanAdvance(false);
    if (!selected) return;
    const id = window.setTimeout(() => setCanAdvance(true), 350);
    return () => window.clearTimeout(id);
  }, [selected]);

  const advancingRef = useRef(false);
  useEffect(() => { advancingRef.current = false; }, [index]);
  const next = () => {
    if (advancingRef.current || !canAdvance) return;
    advancingRef.current = true;
    if (index + 1 >= cards.length) {
      finish(results);
    } else { setIndex((value) => value + 1); setSelected(null); }
  };

  const handlersRef = useRef({ answer, next, choices, selected });
  useEffect(() => {
    handlersRef.current = { answer, next, choices, selected };
  }, [answer, next, choices, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { answer, next, choices, selected } = handlersRef.current;
      const key = Number(event.key);
      if (key >= 1 && key <= choices.length) answer(choices[key - 1]);
      if (event.key === 'Enter' && selected) next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!word) return <div className="p-10"><p>No {discoveryFilter === 'all' ? 'matching' : discoveryFilter} cards with meanings available. Add missing meanings in My words or choose another filter.</p><Link href="/quiz" className="mt-3 inline-block font-bold underline">Change practice filters</Link></div>;

  const progress = ((index + (selected ? 1 : 0)) / cards.length) * 100;
  return <div className="mx-auto max-w-[900px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12">
     <div className="mb-8 flex items-center justify-between"><div><p className="mono-label text-muted-foreground">Live round / {formatDecks(decks)}</p><p className="mt-2 text-sm font-bold">Card {String(index + 1).padStart(2, '0')} <span className="font-normal text-muted-foreground">of {cards.length}</span></p></div><div className="flex items-center gap-2">{timerMode === 'question' ? <span className={cx('mono-label flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold', selected ? 'border-border text-muted-foreground' : timeLeft <= 5 ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground')} data-testid="quiz-timer"><Clock3 size={14} /> {timeLeft}s</span> : <span className={cx('mono-label flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold', sessionTimeLeft <= 30 ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground')} data-testid="quiz-timer"><Clock3 size={14} /> {String(Math.floor(sessionTimeLeft / 60)).padStart(2, '0')}:{String(sessionTimeLeft % 60).padStart(2, '0')}</span>}<SoundMuteButton mode="quiz" /><Link href="/quiz" className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted" data-testid="button-quit-quiz"><X size={15} /> Exit</Link></div></div>
    <div className="mb-10 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[hsl(var(--accent))] transition-[width] duration-500" style={{ width: `${Math.max(progress, 5)}%` }} /></div>
    <section className="animate-pop rounded-[1.75rem] border border-border bg-card p-6 md:p-12" data-testid="quiz-card">
       <div className="mb-4"><DiscoverySyncNote /></div>
       <div className="flex items-center justify-between"><div className="flex flex-wrap items-center gap-2"><LevelPill level={word.level} /><OpenedCardBadge key={wordProgressKey(word)} cardKey={wordProgressKey(word)} /></div><span className="mono-label flex items-center gap-2 text-muted-foreground"><Volume2 size={14} /> {direction === 'meaning' ? 'choose the meaning' : direction === 'reading' ? 'choose the reading (読み方)' : 'choose the Japanese word'}</span></div>
       <div className="py-14 text-center">{direction === 'meaning' ? <><p className="kanji-display text-7xl md:text-8xl">{word.expression}</p>{word.reading && <p className="mt-4 text-lg text-[hsl(var(--secondary))]">{word.reading}</p>}</> : direction === 'reading' ? <><p className="kanji-display text-7xl md:text-8xl">{word.expression}</p><p className="mono-label mt-5 text-muted-foreground">Which reading (読み方) matches?</p></> : <><p className="mx-auto max-w-2xl text-3xl font-semibold leading-tight md:text-5xl">{word.meaning || 'Meaning not added yet — edit in My words.'}</p><p className="mono-label mt-5 text-muted-foreground">Which Japanese word matches?</p></>}</div>
       <div className="grid gap-3 md:grid-cols-2">{choices.map((choice, choiceIndex) => { const right = choice.id === word.id; return <button key={choice.id} onClick={() => answer(choice)} disabled={!!selected} className={cx('group flex min-h-14 items-center gap-4 rounded-xl border p-3 text-left text-sm font-medium transition-all', !selected && 'hover:-translate-y-0.5 hover:border-[hsl(var(--secondary))]', selected && 'cursor-default', selected && right && 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.13)]', selected && choice.id === selected && !right && 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]')} data-testid={`quiz-answer-${choiceIndex + 1}`}><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted font-mono text-xs text-muted-foreground group-hover:bg-[hsl(var(--secondary)/.15)]">{choiceIndex + 1}</span><span className="flex flex-1 flex-col">{direction === 'meaning' ? choice.meaning : direction === 'reading' ? <span className="text-lg text-[hsl(var(--secondary))]">{choice.reading}</span> : <><span className="kanji-display text-xl leading-tight">{choice.expression}</span>{choice.reading && <span className="mt-1 text-xs text-[hsl(var(--secondary))]">{choice.reading}</span>}</>}</span>{selected && right && <Check size={17} className="text-[hsl(var(--secondary))]" />}{selected && choice.id === selected && !right && <X size={17} className="text-[hsl(var(--accent))]" />}</button>; })}</div>
       {selected && (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-xl bg-muted p-3 text-center">
    {/* correct answer → no message; wrong answer / timeout → explanation */}
    {selected !== word.id && (
      <p className="text-sm font-semibold">
        {selected === 'TIMEOUT' ? (
          <>
           {direction === 'word' && word.reading && <span className="ml-1 font-normal text-muted-foreground">({word.reading})</span>}
          </>
        ) : (
          <>
            {direction === 'word' && word.reading && <span className="ml-1 font-normal text-muted-foreground">({word.reading})</span>}
          </>
        )}
      </p>
    )}
    <button
      onClick={next}
      disabled={!canAdvance}
      data-testid="button-next-card"
      className="inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-[hsl(var(--primary))] px-6 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))] shadow-[var(--shadow-sm)] transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--muted))] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
    >
      {index + 1 === cards.length ? 'See results' : 'Next card'} <ArrowRight size={17} />
    </button>
    </div>)}
    </section>
  </div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// JLPT practice exam — imported from the standalone JLPT_exam question bank.
// The bank is original practice material, not an archive of official past papers.
// ─────────────────────────────────────────────────────────────────────────────
type JlptFilterLevel = JlptLevel | 'all';
type JlptFilterSection = JlptSection | 'all';
type JlptResponse = {
  question: JlptQuestion;
  selected: JlptQuestion['answer'] | null;
  correct: boolean;
};
type StoredJlptResult = {
  results: JlptResponse[];
  filterName: string;
  finishedAt: string;
};

function loadStoredJlptResult(): StoredJlptResult | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(JLPT_RESULT_KEY) || 'null') as Partial<StoredJlptResult> | null;
    if (!parsed || !Array.isArray(parsed.results) || typeof parsed.filterName !== 'string') return null;
    const results = parsed.results.filter((item): item is JlptResponse => Boolean(
      item && item.question && typeof item.question.id === 'string' &&
      (item.selected === null || ['A', 'B', 'C', 'D'].includes(item.selected)) &&
      typeof item.correct === 'boolean',
    ));
    return results.length > 0 ? { results, filterName: parsed.filterName, finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : '' } : null;
  } catch {
    return null;
  }
}

function JlptExam() {
  const { ready: discoveryReady, seen: discovered } = useCardProgress();
  const { recordHistory } = useCabinetHistory();
  const { user } = useAuth();
  const soundOwner = user?.uid ?? 'anonymous';
  const { showFinish } = useFinishPopup();
  const search = useSearch();
  const [discoveryFilter, setDiscoveryFilter] = useState<DiscoveryFilter>(() => parseDiscoveryFilter(new URLSearchParams(search).get('discovery')));
  const reviewRequested = new URLSearchParams(search).get('review') === '1';
  const storedResult = useMemo(() => reviewRequested ? loadStoredJlptResult() : null, [reviewRequested]);
  const [phase, setPhase] = useState<'setup' | 'run' | 'review' | 'results'>(storedResult ? 'results' : 'setup');
  const [levelFilter, setLevelFilter] = useState<JlptFilterLevel>(() => {
    const requested = new URLSearchParams(search).get('level');
    return ['N4', 'N3', 'N2', 'N1'].includes(requested ?? '') ? requested as JlptLevel : 'all';
  });
  const [sectionFilter, setSectionFilter] = useState<JlptFilterSection>('all');
  const [count, setCount] = useState(10);
  const [customCount, setCustomCount] = useState('');
  const [timeLimit, setTimeLimit] = useState(0);
  const [customMinutes, setCustomMinutes] = useState('');
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [bookmarkedQuestions, setBookmarkedQuestions] = useState<Record<string, boolean>>({});
  const [questions, setQuestions] = useState<JlptQuestion[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responses, setResponses] = useState<Record<string, JlptQuestion['answer']>>({});
  const [results, setResults] = useState<JlptResponse[]>(storedResult?.results ?? []);
  const [resultFilterName, setResultFilterName] = useState<string | null>(storedResult?.filterName ?? null);
  const [timeLeft, setTimeLeft] = useState(0);
  const finishedRef = useRef(false);

  const matchingQuestions = useMemo(() => jlptQuestions.filter((question) =>
    (levelFilter === 'all' || question.level === levelFilter) &&
    (sectionFilter === 'all' || question.section === sectionFilter),
  ), [levelFilter, sectionFilter]);
  const availableQuestions = useMemo(() => filterDiscovered(matchingQuestions, jlptProgressKey, discovered, discoveryFilter), [matchingQuestions, discovered, discoveryFilter]);
  const currentQuestion = questions[questionIndex];
  const selected = currentQuestion ? responses[currentQuestion.id] ?? null : null;
  const shuffledChoices = useMemo(
    () => currentQuestion ? shuffleJlpt([...jlptChoices]) : [],
    [currentQuestion],
  );
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrl = currentQuestion?.section === 'listening' ? jlptAudioUrl(currentQuestion.id) : null;

  useEffect(() => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setAudioPlaying(false);
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [currentQuestion]);

  const audioAvailable = Boolean(audioUrl) || (typeof window !== 'undefined' && 'speechSynthesis' in window);
  const speakListeningQuestion = () => {
    if (!currentQuestion || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (audioPlaying) {
      window.speechSynthesis.cancel();
      setAudioPlaying(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(currentQuestion.question);
    utterance.lang = 'ja-JP';
    utterance.onend = () => setAudioPlaying(false);
    utterance.onerror = () => setAudioPlaying(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setAudioPlaying(true);
  };

  const filterName = `${discoveryFilter === 'all' ? 'All cards' : discoveryFilter === 'seen' ? 'Seen only' : 'New only'} · ${levelFilter === 'all' ? 'Mixed levels' : levelFilter} · ${formatJlptSection(sectionFilter)}`;
  const finishExam = () => {
    if (finishedRef.current || questions.length === 0) return;
    finishedRef.current = true;
    const finalResults = questions.map((question) => {
      const answer = responses[question.id] ?? null;
      return { question, selected: answer, correct: answer === question.answer };
    });
    const score = finalResults.filter((item) => item.correct).length;
    setResults(finalResults);
    setResultFilterName(filterName);
    try {
      sessionStorage.setItem(JLPT_RESULT_KEY, JSON.stringify({
        results: finalResults,
        filterName,
        finishedAt: new Date().toISOString(),
      } satisfies StoredJlptResult));
    } catch {
      /* Review can still be shown in the current session if storage is unavailable. */
    }
    setPhase('results');
    recordHistory({
      date: toDateKey(new Date()),
      score,
      total: finalResults.length,
      level: `JLPT ${levelFilter === 'all' ? 'Mixed' : levelFilter}`,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    if ((phase !== 'run' && phase !== 'review') || timeLimit === 0) return;
    if (timeLeft <= 0) {
      finishExam();
      return;
    }
    const timer = window.setTimeout(() => setTimeLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, timeLimit, timeLeft]);

  // Hand the finished score to the global card when the scorecard lands.
  // The card lives above the router, so it keeps floating if the user
  // wanders off to other pages before closing it.
  useEffect(() => {
    if (phase === 'results' && results.length > 0) {
      const correct = results.filter((item) => item.correct).length;
      showFinish('jlpt', correct, results.length);
    }
  }, [phase, results, showFinish]);

  const startExam = () => {
    if (!discoveryReady) return;
    const nextQuestions = shuffleJlpt(availableQuestions).slice(0, Math.min(count, availableQuestions.length));
    if (nextQuestions.length === 0) return;
    setQuestions(nextQuestions);
    setResponses({});
    setResults([]);
    setResultFilterName(null);
    setEditingQuestion(false);
    setBookmarkedQuestions({});
    setQuestionIndex(0);
    setTimeLeft(timeLimit * 60);
    finishedRef.current = false;
    setPhase('run');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleBookmark = (questionId: string) => {
    setBookmarkedQuestions((current) => ({ ...current, [questionId]: !current[questionId] }));
  };

  // Answers stay changeable for the whole run: tapping another option replaces
  // what was picked earlier (the review drawer's "Change answer" does the same,
  // it just jumps back to the question). Only an actual change plays the
  // confirmation sound, so re-tapping the chosen option stays quiet.
  const chooseAnswer = (answer: JlptQuestion['answer']) => {
    if (!currentQuestion || selected === answer) return;
    void playUserSound(soundOwner, 'jlptAnswer', () => playFeedback(feedbackAudio.answer));
    setResponses((current) => ({ ...current, [currentQuestion.id]: answer }));
  };

  const nextQuestion = () => {
    setEditingQuestion(false);
    if (questionIndex + 1 >= questions.length) {
      setPhase('review');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setQuestionIndex((value) => value + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Step back so an earlier answer can be revisited and changed without
  // detouring through the review drawer.
  const previousQuestion = () => {
    if (questionIndex === 0) return;
    setEditingQuestion(false);
    setQuestionIndex((value) => Math.max(0, value - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetToSetup = () => {
    setPhase('setup');
    setQuestions([]);
    setResponses({});
    setResults([]);
    setQuestionIndex(0);
    setEditingQuestion(false);
    setBookmarkedQuestions({});
    finishedRef.current = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (phase === 'setup') {
    const questionCount = Math.min(count, availableQuestions.length);
    return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="page-jlpt-exam">
      <div className="grid gap-8 lg:grid-cols-[1.05fr_.95fr] lg:items-start">
        <section className="relative overflow-hidden rounded-[1.75rem] bg-[hsl(var(--primary))] p-7 text-[hsl(var(--primary-foreground))] md:p-10">
          <div className="absolute -right-20 -top-20 size-64 rounded-full border-[26px] border-[hsl(var(--accent)/.85)]" />
          <div className="absolute -bottom-20 right-20 size-40 rounded-full border-[18px] border-[hsl(var(--secondary)/.55)]" />
          <div className="relative">
            <p className="mono-label mb-5 text-[hsl(var(--primary-foreground)/.55)]">JLPT practice / 003</p>
            <h1 className="font-serif text-5xl leading-[.96] tracking-[-.06em] md:text-7xl"><br /><span className="italic text-[hsl(var(--accent))]">Sit the full mock.</span></h1>
            <p className="mt-6 max-w-md text-sm leading-6 text-[hsl(var(--primary-foreground)/.68)]">A focused practice room for vocabulary, grammar, reading, and listening-style questions from N4 through N1.</p>
            <div className="mt-10 flex flex-wrap gap-2 text-xs font-bold">
              {(['N4', 'N3', 'N2', 'N1'] as const).map((level) => <span key={level} className="rounded-full border border-[hsl(var(--primary-foreground)/.18)] px-3 py-2">{level}</span>)}
              <span className="rounded-full bg-[hsl(var(--accent))] px-3 py-2 text-[hsl(var(--foreground))]">{jlptQuestions.length.toLocaleString()} questions</span>
            </div>
          </div>
          <span className="absolute bottom-6 right-8 hidden font-mono text-[10px] tracking-[.15em] text-[hsl(var(--primary-foreground)/.35)] md:block">試験 / PRACTICE</span>
        </section>

        <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-8" data-testid="jlpt-exam-setup">
          <p className="mono-label mb-2 text-muted-foreground">Set the table</p>
          <h2 className="font-serif text-3xl">Build a practice test.</h2>
          <div className="mt-6"><DiscoverySummary keys={matchingQuestions.map(jlptProgressKey)} title="Your selected JLPT questions" /><DiscoverySyncNote />
            <div className="mt-4"><DiscoveryFilterControl value={discoveryFilter} onChange={setDiscoveryFilter} disabled={!discoveryReady} /></div>
            {discoveryReady && availableQuestions.length === 0 && <p className="mt-3 text-sm text-muted-foreground" role="status">No {discoveryFilter === 'all' ? 'matching' : discoveryFilter} questions. Choose another filter, level or section.</p>}
            <Link href="/review" className="mt-3 inline-block text-xs font-bold underline">Browse and review cards</Link></div>
          <div className="mt-8 space-y-7">
            <div>
              <label className="mb-3 block text-sm font-bold">JLPT level</label>
              <div className="grid grid-cols-5 gap-2">
                <button onClick={() => setLevelFilter('all')} className={cx('rounded-xl border py-3 text-xs font-bold', levelFilter === 'all' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid="jlpt-level-all">Mix</button>
                {(['N4', 'N3', 'N2', 'N1'] as const).map((level) => <button key={level} onClick={() => setLevelFilter(level)} className={cx('rounded-xl border py-3 text-sm font-bold', levelFilter === level ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={`jlpt-level-${level}`}>{level}</button>)}
              </div>
            </div>
            <div>
              <label className="mb-3 block text-sm font-bold">Section</label>
              <div className="grid grid-cols-2 gap-2">
                {(['all', 'vocabulary', 'grammar', 'reading', 'listening'] as const).map((section) => <button key={section} onClick={() => setSectionFilter(section)} className={cx('rounded-xl border py-3 text-xs font-bold', sectionFilter === section ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={`jlpt-section-${section}`}>{section === 'all' ? 'All sections' : formatJlptSection(section)}</button>)}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{availableQuestions.length.toLocaleString()} matching practice questions.</p>
            </div>
            <div>
              <label className="mb-3 block text-sm font-bold">How many questions?</label>
              <div className="grid grid-cols-4 gap-2">
                {[10, 20, 30, 50].map((option) => <button key={option} onClick={() => { setCount(option); setCustomCount(''); }} disabled={availableQuestions.length < option} className={cx('rounded-xl border py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-35', !customCount && count === option ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={`jlpt-count-${option}`}>{option}</button>)}
              </div>
              <div className="mt-3 flex items-center gap-3"><label htmlFor="jlpt-custom-count" className="text-xs font-semibold text-muted-foreground">Custom</label><input id="jlpt-custom-count" type="number" min="1" max={availableQuestions.length} value={customCount} onChange={(event) => { const raw = event.target.value; setCustomCount(raw); const next = Number(raw); if (raw && Number.isFinite(next)) setCount(Math.min(Math.max(Math.round(next), 1), Math.max(availableQuestions.length, 1))); }} onBlur={() => { if (customCount) setCustomCount(String(count)); }} placeholder={`1–${availableQuestions.length}`} className="h-10 w-28 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid="input-jlpt-custom-count" /><span className="text-xs text-muted-foreground">questions, up to {availableQuestions.length.toLocaleString()}</span></div>
              <p className="mt-2 text-xs text-muted-foreground">This test will use {questionCount} question{questionCount === 1 ? '' : 's'}.</p>
            </div>
            <div>
              <label className="mb-3 block text-sm font-bold">Time limit</label>
              <div className="grid grid-cols-4 gap-2">
                {([[0, 'No limit'], [15, '15 min'], [30, '30 min'], [60, '60 min']] as const).map(([minutes, label]) => <button key={minutes} onClick={() => { setTimeLimit(minutes); setCustomMinutes(''); }} className={cx('rounded-xl border py-3 text-xs font-bold', !customMinutes && timeLimit === minutes ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]' : 'border-border hover:bg-muted')} data-testid={`jlpt-time-${minutes}`}>{label}</button>)}
              </div>
              <div className="mt-3 flex items-center gap-3"><label htmlFor="jlpt-custom-minutes" className="text-xs font-semibold text-muted-foreground">Custom</label><input id="jlpt-custom-minutes" type="number" min="1" max="180" value={customMinutes} onChange={(event) => { const raw = event.target.value; setCustomMinutes(raw); const next = Number(raw); if (raw && Number.isFinite(next)) setTimeLimit(Math.min(Math.max(Math.round(next), 1), 180)); }} onBlur={() => { if (customMinutes) setCustomMinutes(String(timeLimit)); }} placeholder="1–180" className="h-10 w-24 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid="input-jlpt-custom-minutes" /><span className="text-xs text-muted-foreground">minutes (1–180)</span></div>
              <p className="mt-2 text-xs text-muted-foreground">{timeLimit === 0 ? 'The test will run without a countdown.' : `The test will end after ${timeLimit} minute${timeLimit === 1 ? '' : 's'}.`}</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-muted/50 p-4" data-testid="jlpt-answer-sound-setting"><span className="mono-label text-muted-foreground">Sounds</span><SoundSettings mode="jlpt" /></div>
          </div>
          <button onClick={startExam} disabled={!discoveryReady || availableQuestions.length === 0} className="mt-9 flex w-full items-center justify-center gap-2 rounded-xl bg-[hsl(var(--primary))] py-3.5 text-sm font-bold text-[hsl(var(--primary-foreground))] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-start-jlpt"><GraduationCap size={17} /> Start practice test <ArrowRight size={16} /></button>
        </section>
      </div>
      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {([['Vocabulary', jlptQuestions.filter((question) => question.section === 'vocabulary').length], ['Grammar', jlptQuestions.filter((question) => question.section === 'grammar').length], ['Reading', jlptQuestions.filter((question) => question.section === 'reading').length], ['Listening', jlptQuestions.filter((question) => question.section === 'listening').length]] as const).map(([label, total]) => <div key={label} className="rounded-2xl border border-border bg-card p-5"><p className="mono-label text-muted-foreground">{label}</p><p className="mt-2 font-serif text-3xl">{total}</p><p className="mt-1 text-xs text-muted-foreground">practice questions</p></div>)}
      </section>
      <p className="mt-6 text-xs leading-5 text-muted-foreground">This is an original practice bank in JLPT format. Listening transcripts stay hidden during the test and are revealed in the review after you finish.</p>
    </div>;
  }

  if (phase === 'run' && currentQuestion) {
    const progress = ((questionIndex + (selected ? 1 : 0)) / questions.length) * 100;
    const timeLabel = `${String(Math.floor(timeLeft / 60)).padStart(2, '0')}:${String(timeLeft % 60).padStart(2, '0')}`;
    const isPaperQuestion = currentQuestion.section !== 'listening';
    return <div className="mx-auto max-w-[900px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="jlpt-exam-run">
      <div className="mb-8 flex items-center justify-between gap-4"><div><p className="mono-label text-muted-foreground">JLPT practice / {currentQuestion.level} · {formatJlptSection(currentQuestion.section)}</p><p className="mt-2 text-sm font-bold">Question {String(questionIndex + 1).padStart(2, '0')} <span className="font-normal text-muted-foreground">of {questions.length}</span></p></div><div className="flex items-center gap-2"><button onClick={() => { setEditingQuestion(false); setPhase('review'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="flex items-center gap-2 rounded-full border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted" data-testid="button-review-answers"><ListChecks size={14} /><span className="hidden sm:inline">Review</span></button><button onClick={() => toggleBookmark(currentQuestion.id)} aria-pressed={!!bookmarkedQuestions[currentQuestion.id]} aria-label={bookmarkedQuestions[currentQuestion.id] ? 'Remove bookmark from this question' : 'Bookmark this question'} title={bookmarkedQuestions[currentQuestion.id] ? 'Remove bookmark' : 'Bookmark question'} className={cx('grid size-9 place-items-center rounded-full border', bookmarkedQuestions[currentQuestion.id] ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground hover:bg-muted')} data-testid="toggle-jlpt-bookmark"><Bookmark size={15} fill={bookmarkedQuestions[currentQuestion.id] ? 'currentColor' : 'none'} /></button><span className={cx('mono-label flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold', timeLimit > 0 && timeLeft <= 60 ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground')}><Clock3 size={14} /> {timeLimit > 0 ? timeLabel : 'No limit'}</span><SoundMuteButton mode="jlpt" /><button onClick={resetToSetup} className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted" data-testid="button-exit-jlpt"><X size={15} /> Exit</button></div></div>
      <div className="mb-10 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[hsl(var(--accent))] transition-[width] duration-500" style={{ width: `${Math.max(progress, 4)}%` }} /></div>
      <section className={cx('border p-5 md:p-10', isPaperQuestion ? 'jlpt-paper rounded-lg border-[hsl(var(--foreground)/.28)] shadow-[0_3px_12px_rgba(44,37,24,.08)]' : 'rounded-[1.75rem] border-border bg-card')} data-testid="jlpt-question-card">
        <div className="mb-4"><OpenedCardBadge key={jlptProgressKey(currentQuestion)} cardKey={jlptProgressKey(currentQuestion)} /><DiscoverySyncNote /></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="mono-label inline-flex rounded-full bg-[hsl(var(--secondary)/.12)] px-2 py-1 text-[10px] font-bold text-[hsl(var(--secondary))]">{currentQuestion.level} / {formatJlptSection(currentQuestion.section)}</span><span className="mono-label text-muted-foreground">{currentQuestion.questionType.replaceAll('_', ' ')}</span></div>
        {currentQuestion.section === 'listening' && <div className="mt-7 flex flex-wrap items-center gap-3 rounded-2xl border border-[hsl(var(--secondary)/.25)] bg-[hsl(var(--secondary)/.08)] p-3"><audio ref={audioRef} src={audioUrl ?? undefined} preload="none" onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} onEnded={() => setAudioPlaying(false)} onError={speakListeningQuestion} /><button onClick={() => { const player = audioRef.current; if (audioUrl && player) { if (player.paused) void player.play(); else player.pause(); return; } speakListeningQuestion(); }} disabled={!audioAvailable} className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--secondary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--secondary-foreground))] disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-play-jlpt-audio"><Volume2 size={16} /> {audioPlaying ? 'Pause audio' : 'Play audio'}</button><span className="text-xs text-muted-foreground">{audioUrl ? 'Uploaded Japanese audio.' : 'Japanese browser voice fallback.'}</span></div>}
        {currentQuestion.section === 'listening' ? <div className="ruled mt-7 flex min-h-40 items-center justify-center rounded-2xl border border-border/70 px-5 py-7 text-center md:px-8"><div><Headphones className="mx-auto text-[hsl(var(--secondary))]" size={28} /><p className="mt-3 font-serif text-2xl">Listen carefully.</p><p className="mt-1 text-xs text-muted-foreground">The transcript will be revealed after you finish the exam.</p></div></div> : <div className="jlpt-paper-question mt-7 border-y border-[#cfc8b9] px-2 py-6 md:px-4" data-testid="jlpt-paper-question">{currentQuestion.question.split(/\n\s*\n/).map((block, blockIndex) => <p key={`${currentQuestion.id}-block-${blockIndex}`} className={cx('whitespace-pre-line', blockIndex === 0 ? 'text-sm font-bold md:text-base' : 'mt-5 text-lg md:text-xl')}>{block}</p>)}</div>}
        <div className={cx('mt-7 grid gap-y-1', isPaperQuestion ? 'grid-cols-1' : 'gap-3 md:grid-cols-2')}>{shuffledChoices.map((label, choicePosition) => { const optionIndex = jlptChoices.indexOf(label); const isSelected = label === selected; return <button key={label} onClick={() => chooseAnswer(label)} aria-pressed={isSelected} className={cx(isPaperQuestion ? 'jlpt-paper-choice group flex min-h-14 items-start gap-2 border-b border-[#d8d1c4] px-2 py-3 text-left text-base transition-colors' : 'group flex min-h-16 items-start gap-3 rounded-xl border p-4 text-left text-sm transition-all', !isSelected && 'hover:-translate-y-0.5', isSelected && 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.13)]')} data-testid={`jlpt-answer-${label}`}><span className={isPaperQuestion ? 'w-6 shrink-0 text-lg font-bold' : 'grid size-7 shrink-0 place-items-center rounded-lg bg-muted font-mono text-xs font-bold text-muted-foreground'}>{isPaperQuestion ? `${choicePosition + 1}.` : label}</span><span className="whitespace-pre-line leading-6">{currentQuestion.options[optionIndex]}</span></button>; })}</div>
        {selected && <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-muted p-4 md:p-5"><p className="text-sm font-semibold">{editingQuestion ? `Answer ${selected} saved. Return to review when ready.` : `Answer ${selected} saved — tap another option any time to change it.`}</p><div className="flex shrink-0 items-center gap-2">{questionIndex > 0 && <button onClick={previousQuestion} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-background" data-testid="button-previous-jlpt"><ArrowRight className="rotate-180" size={14} /> Previous</button>}{editingQuestion ? <button onClick={() => { setEditingQuestion(false); setPhase('review'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-back-to-jlpt-review">Back to review <ArrowRight size={14} /></button> : <button onClick={nextQuestion} className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-next-jlpt">{questionIndex + 1 === questions.length ? 'Review answers' : 'Next question'} <ArrowRight size={14} /></button>}</div></div>}
        {!selected && <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><button onClick={nextQuestion} className="text-xs font-bold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-testid="button-skip-jlpt">Skip this question</button>{questionIndex > 0 && <button onClick={previousQuestion} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted" data-testid="button-previous-jlpt"><ArrowRight className="rotate-180" size={14} /> Previous</button>}</div>}
      </section>
    </div>;
  }

  if (phase === 'review') {
    const answeredCount = questions.filter((question) => responses[question.id] !== undefined).length;
    const unansweredCount = questions.length - answeredCount;
    const markedCount = questions.filter((question) => bookmarkedQuestions[question.id]).length;
    const reviewTimeLabel = `${String(Math.floor(timeLeft / 60)).padStart(2, '0')}:${String(timeLeft % 60).padStart(2, '0')}`;
    const answerText = (question: JlptQuestion) => {
      const answer = responses[question.id];
      return answer ? `${answer}. ${question.options[jlptChoices.indexOf(answer)]}` : 'No response selected';
    };
    return <div className="mx-auto max-w-[900px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="jlpt-exam-review">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4"><div><p className="mono-label text-muted-foreground">JLPT practice / review before submitting</p><h1 className="mt-2 font-serif text-4xl tracking-[-.04em]">Review your test.</h1><p className="mt-2 text-sm text-muted-foreground">Change an answer or mark a question to revisit. Correct answers stay hidden until you submit.</p></div><div className="flex items-center gap-2"><span className={cx('mono-label flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold', timeLimit > 0 && timeLeft <= 60 ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground')}><Clock3 size={14} /> {timeLimit > 0 ? reviewTimeLabel : 'No limit'}</span><button onClick={() => { setEditingQuestion(false); setPhase('run'); }} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-bold text-muted-foreground hover:bg-muted" data-testid="button-back-to-jlpt-test"><ArrowRight className="rotate-180" size={14} /> Back to test</button></div></div>
      <div className="mb-6 grid gap-3 sm:grid-cols-4"><div className="rounded-2xl border border-border bg-card p-4"><p className="mono-label text-muted-foreground">Answered</p><p className="mt-1 font-serif text-3xl">{answeredCount}<span className="ml-1 text-base text-muted-foreground">/ {questions.length}</span></p></div><div className="rounded-2xl border border-border bg-card p-4"><p className="mono-label text-muted-foreground">Unanswered</p><p className={cx('mt-1 font-serif text-3xl', unansweredCount > 0 ? 'text-[hsl(var(--accent))]' : 'text-[hsl(var(--secondary))]')}>{unansweredCount}</p></div><div className="rounded-2xl border border-border bg-card p-4"><p className="mono-label text-muted-foreground">Marked</p><p className="mt-1 font-serif text-3xl">{markedCount}</p></div><div className="rounded-2xl border border-border bg-card p-4"><p className="mono-label text-muted-foreground">Mode</p><p className="mt-1 truncate text-sm font-bold">{filterName}</p></div></div>
      {unansweredCount > 0 && <div className="mb-6 rounded-2xl border border-[hsl(var(--accent)/.45)] bg-[hsl(var(--accent)/.09)] p-4 text-sm"><strong>{unansweredCount} question{unansweredCount === 1 ? '' : 's'} unanswered.</strong> You can change answers below; anything left unanswered will be scored as incorrect.</div>}
      <div className="space-y-2">{questions.map((question, index) => { const answered = responses[question.id] !== undefined; const bookmarked = !!bookmarkedQuestions[question.id]; return <article key={question.id} className={cx('rounded-2xl border bg-card p-4 md:p-5', answered ? 'border-border' : 'border-[hsl(var(--accent)/.45)]')} data-testid={`jlpt-review-question-${index + 1}`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-mono text-sm font-bold">{index + 1}</span><div className="min-w-0"><p className="text-sm font-bold">Question {index + 1} <span className="font-normal text-muted-foreground">· {question.id}</span></p><p className="mono-label mt-1 text-muted-foreground">{question.level} · {formatJlptSection(question.section)}</p></div></div><span className={cx('text-xs font-bold', answered ? 'text-[hsl(var(--secondary))]' : 'text-[hsl(var(--accent))]')}>{answered ? 'Answered' : 'Needs an answer'}</span></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3"><p className={cx('min-w-0 flex-1 text-sm', answered ? '' : 'text-[hsl(var(--accent))]')}><span className="mono-label mr-2 text-muted-foreground">Your response</span><strong>{answerText(question)}</strong></p><div className="flex shrink-0 items-center gap-2"><button onClick={() => toggleBookmark(question.id)} aria-pressed={bookmarked} className={cx('inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold', bookmarked ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)] text-[hsl(var(--accent))]' : 'border-border text-muted-foreground hover:bg-muted')} data-testid={`toggle-jlpt-review-bookmark-${index + 1}`}><Bookmark size={14} fill={bookmarked ? 'currentColor' : 'none'} /> {bookmarked ? 'Marked' : 'Mark'}</button><button onClick={() => { setQuestionIndex(index); setEditingQuestion(true); setPhase('run'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid={`button-edit-jlpt-question-${index + 1}`}><Pencil size={13} /> Change answer</button></div></div></article>; })}</div>
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3"><button onClick={() => { setEditingQuestion(false); setPhase('run'); }} className="rounded-xl border border-border px-4 py-3 text-sm font-bold text-muted-foreground hover:bg-muted">Continue test</button><button onClick={finishExam} className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-submit-jlpt"><ListChecks size={16} /> Submit test <ArrowRight size={16} /></button></div>
    </div>;
  }

  const score = results.filter((item) => item.correct).length;
  const percent = results.length ? Math.round((score / results.length) * 100) : 0;
  const missed = results.filter((item) => !item.correct);
  const nonListeningMissed = missed.filter((item) => item.question.section !== 'listening');
  const listeningResults = results.filter((item) => item.question.section === 'listening');
  const optionText = (question: JlptQuestion, label: JlptQuestion['answer'] | null) => label ? question.options[jlptChoices.indexOf(label)] : 'No answer';
  return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12" data-testid="jlpt-exam-results">
    <div className="grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
      <section className={cx('relative overflow-hidden rounded-[1.75rem] p-7 md:p-10', percent >= 80 ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]' : 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]')}><div className="absolute -right-10 -top-10 size-44 rounded-full border-[22px] border-[hsl(var(--accent)/.75)]" /><p className="mono-label relative mb-6 opacity-60">Practice complete / scorecard</p><div className="relative"><div className="flex items-end gap-3"><span className="font-serif text-8xl leading-none tracking-[-.08em]">{percent}</span><span className="mb-2 font-mono text-2xl">%</span></div><h1 className="mt-7 font-serif text-4xl tracking-[-.04em]">{percent >= 80 ? 'A strong showing.' : 'Keep the practice room open.'}</h1><p className="mt-3 max-w-sm text-sm leading-6 opacity-70">{score} correct out of {results.length}. {missed.length ? `${missed.length} question${missed.length === 1 ? '' : 's'} worth another look.` : 'Clean sweep.'}</p></div><div className="relative mt-10 flex gap-2"><button onClick={resetToSetup} className="flex items-center gap-2 rounded-xl bg-[hsl(var(--accent))] px-4 py-3 text-sm font-bold text-[hsl(var(--foreground))]" data-testid="button-retry-jlpt"><RotateCcw size={15} /> Try another</button><Link href="/" className="rounded-xl border border-current/20 px-4 py-3 text-sm font-bold opacity-80 hover:opacity-100">Cabinet</Link></div></section>
      <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-9"><div className="flex items-start justify-between"><div><p className="mono-label text-muted-foreground">Your practice report</p><h2 className="mt-2 font-serif text-3xl">A tidy debrief.</h2><p className="mt-2 text-sm text-muted-foreground">{resultFilterName ?? filterName} · {results.length} questions</p></div><div className="grid size-12 place-items-center rounded-xl bg-[hsl(var(--accent)/.15)] text-[hsl(var(--accent))]"><GraduationCap size={22} /></div></div><div className="mt-8 grid grid-cols-3 gap-3"><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Correct</p><p className="mt-2 font-serif text-2xl">{score}</p></div><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Missed</p><p className="mt-2 font-serif text-2xl">{missed.length}</p></div><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Questions</p><p className="mt-2 font-serif text-2xl">{results.length}</p></div></div><div className="mt-8"><div className="mb-3 flex justify-between text-xs font-bold"><span>Recall strength</span><span className="text-[hsl(var(--secondary))]">{score} of {results.length}</span></div><div className="flex h-3 gap-1 overflow-hidden rounded-full bg-muted">{results.map((item) => <span key={item.question.id} className={cx('flex-1 rounded-sm', item.correct ? 'bg-[hsl(var(--secondary))]' : 'bg-[hsl(var(--accent))')} />)}</div></div></section>
    </div>
    <section className="mt-12"><div className="flex items-end justify-between gap-4"><div><p className="mono-label text-muted-foreground">Review drawer</p><h2 className="mt-2 font-serif text-3xl">{nonListeningMissed.length ? 'Questions to revisit' : listeningResults.length ? 'No other questions to revisit' : 'Nothing slipped through'}</h2></div><span className="text-xs text-muted-foreground">{results.length} reviewed</span></div>{nonListeningMissed.length ? <div className="mt-5 space-y-3">{nonListeningMissed.map(({ question, selected: answer }) => <article key={question.id} className="rounded-2xl border border-border bg-card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><span className="mono-label text-muted-foreground">{question.id} · {question.level} · {formatJlptSection(question.section)}</span><span className="text-xs font-bold text-[hsl(var(--accent))]">Answer {question.answer}</span></div><p className="mt-4 whitespace-pre-line text-sm font-medium leading-7">{question.question}</p><div className="mt-4 grid gap-2 text-xs md:grid-cols-2"><p className="rounded-lg bg-[hsl(var(--accent)/.11)] p-3"><strong>Your answer:</strong> {optionText(question, answer)}</p><p className="rounded-lg bg-[hsl(var(--secondary)/.11)] p-3"><strong>Correct answer:</strong> {optionText(question, question.answer)}</p></div><p className="mt-4 text-sm leading-6 text-muted-foreground">{question.explanation}</p></article>)}</div> : <div className="mt-5 rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center"><Sparkles className="mx-auto text-[hsl(var(--accent))]" size={24} /><p className="mt-3 font-serif text-2xl">{listeningResults.length ? 'Listening review is below.' : 'Clean sweep.'}</p><p className="mt-2 text-sm text-muted-foreground">{listeningResults.length ? 'Your listening transcripts are revealed after the test.' : 'Your JLPT practice set did not catch you out.'}</p></div>}</section>
    {listeningResults.length > 0 && <section className="mt-12" data-testid="jlpt-listening-review"><div className="flex items-end justify-between gap-4"><div><p className="mono-label text-muted-foreground">Listening transcripts</p><h2 className="mt-2 font-serif text-3xl">Now read what you heard.</h2></div><span className="text-xs text-muted-foreground">{listeningResults.length} listening question{listeningResults.length === 1 ? '' : 's'}</span></div><div className="mt-5 space-y-3">{listeningResults.map(({ question, selected: answer, correct }) => <article key={question.id} className="rounded-2xl border border-border bg-card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><span className="mono-label text-muted-foreground">{question.id} · {question.level} · {formatJlptSection(question.section)}</span><span className={cx('text-xs font-bold', correct ? 'text-[hsl(var(--secondary))]' : 'text-[hsl(var(--accent))]')}>{correct ? 'Correct' : `Correct answer: ${question.answer}`}</span></div><p className="mt-4 whitespace-pre-line text-sm font-medium leading-7">{question.question}</p><div className="mt-4 grid gap-2 text-xs md:grid-cols-2"><p className="rounded-lg bg-[hsl(var(--accent)/.11)] p-3"><strong>Your answer:</strong> {optionText(question, answer)}</p><p className="rounded-lg bg-[hsl(var(--secondary)/.11)] p-3"><strong>Correct answer:</strong> {optionText(question, question.answer)}</p></div><p className="mt-4 text-sm leading-6 text-muted-foreground">{question.explanation}</p></article>)}</div></section>}
  </div>;
}

function Quiz() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const { ready } = useCardProgress();
  if (params.get('run') && !ready) return <p className="p-10" role="status">Loading your card progress…</p>;
  if (params.get('run') && params.get('mode') === 'ranked') return <RankedActive count={Number(params.get('count')) || 10} />;
  return params.get('run') ? <QuizActive params={params} /> : <QuizSetup />;
}

function Results() {
  const [, setLocation] = useLocation();
  const { showFinish } = useFinishPopup();
  const { history } = useCabinetHistory();
  const bonus = useMemo(() => computeBonusSummary(history), [history]);
  const [result] = useState<QuizResult | null>(() => { try { return JSON.parse(sessionStorage.getItem('kotoba-last-result') || 'null'); } catch { return null; } });
  const [jlptResult] = useState<StoredJlptResult | null>(() => loadStoredJlptResult());
  // Hand the finished score to the global card once per visit. The card
  // lives above the router, so it keeps floating if the user wanders off
  // to other pages before closing it.
  useEffect(() => {
    if (result) showFinish('quiz', result.score, result.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jlptScore = jlptResult?.results.filter((item) => item.correct).length ?? 0;
  const jlptPercent = jlptResult && jlptResult.results.length > 0 ? Math.round((jlptScore / jlptResult.results.length) * 100) : 0;
  if (!result && jlptResult) return <div className="mx-auto max-w-[720px] px-5 py-20 pb-28 md:pb-12"><section className="rounded-[1.75rem] border border-border bg-card p-7 text-center md:p-10"><div className="mx-auto grid size-16 place-items-center rounded-2xl bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent))]"><GraduationCap /></div><p className="mono-label mt-6 text-muted-foreground">Latest JLPT practice</p><h1 className="mt-2 font-serif text-4xl">{jlptPercent}% on your last test.</h1><p className="mt-3 text-sm text-muted-foreground">{jlptScore} correct out of {jlptResult.results.length} · {jlptResult.filterName}</p><div className="mt-7 flex flex-wrap justify-center gap-2"><Link href="/exam?review=1" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-review-jlpt"><GraduationCap size={16} /> Review JLPT exam <ArrowRight size={16} /></Link><Link href="/quiz" className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-bold hover:bg-muted">Choose a deck</Link></div></section></div>;
  if (!result) return <div className="mx-auto max-w-[720px] px-5 py-20 pb-28 text-center md:pb-12"><div className="mx-auto grid size-16 place-items-center rounded-2xl bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent))]"><Trophy /></div><h1 className="mt-6 font-serif text-4xl">No round on the desk yet.</h1><p className="mt-3 text-sm text-muted-foreground">Take a quiz or a JLPT practice test and your report will land here.</p><div className="mt-7 flex flex-wrap justify-center gap-2"><Link href="/quiz" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]">Choose a deck <ArrowRight size={16} /></Link><Link href="/exam" className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-bold hover:bg-muted"><GraduationCap size={16} /> JLPT exam</Link></div></div>;
  const percent = Math.round((result.score / result.total) * 100);
  const passed = percent >= 80;
  const missed = result.answers.filter((answer) => !answer.correct);
  return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:px-10 md:py-14 md:pb-12">
    <div className="grid gap-6 lg:grid-cols-[.82fr_1.18fr]">
      <section className={cx('relative overflow-hidden rounded-[1.75rem] p-7 md:p-10', passed ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]' : 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]')}><div className="absolute -right-10 -top-10 size-44 rounded-full border-[22px] border-[hsl(var(--accent)/.75)]" /><p className="mono-label relative mb-6 opacity-60">Round complete / report</p><div className="relative"><div className="flex items-end gap-3"><span className="font-serif text-8xl leading-none tracking-[-.08em]">{percent}</span><span className="mb-2 font-mono text-2xl">%</span></div><h1 className="mt-7 font-serif text-4xl tracking-[-.04em]">{passed ? 'The words are landing.' : 'Keep the drawer open.'}</h1><p className="mt-3 max-w-sm text-sm leading-6 opacity-70">{passed ? 'That was a strong little session. Your next recall will have more to hold onto.' : 'A missed word is not a lost word. It is simply asking for another visit.'}</p></div><div className="relative mt-10 flex gap-2"><button onClick={() => setLocation('/quiz')} className="flex items-center gap-2 rounded-xl bg-[hsl(var(--accent))] px-4 py-3 text-sm font-bold text-[hsl(var(--foreground))]" data-testid="button-retry-quiz"><RotateCcw size={15} /> Try again</button><button onClick={() => setLocation('/')} className="rounded-xl border border-current/20 px-4 py-3 text-sm font-bold opacity-80 hover:opacity-100" data-testid="button-back-cabinet">Cabinet</button></div>
    <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-current/20 bg-[hsl(var(--foreground)/.06)] p-4" data-testid="results-bonus-strip"><p className="text-xs leading-5">Daily bonus: <strong>{bonus.today.points} pts</strong> today · {bonus.tasksDone}/{bonus.tasksTotal} tasks done{bonus.today.cleared ? ' · full clear earned ✨' : ''}</p><Link href="/bonus" className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-results-open-bonus"><Gift size={13} /> Daily bonus <ArrowRight size={13} /></Link></div></section>
      <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-9"><div className="flex items-start justify-between"><div><p className="mono-label text-muted-foreground">Your scorecard</p><h2 className="mt-2 font-serif text-3xl">A tidy debrief.</h2></div><div className="grid size-12 place-items-center rounded-xl bg-[hsl(var(--accent)/.15)] text-[hsl(var(--accent))]"><Trophy size={22} /></div></div><div className="mt-8 grid grid-cols-3 gap-3"><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Correct</p><p className="mt-2 font-serif text-2xl">{result.score}</p></div><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Missed</p><p className="mt-2 font-serif text-2xl">{result.total - result.score}</p></div><div className="rounded-xl bg-muted p-3"><p className="mono-label text-muted-foreground">Deck</p><p className="mt-2 font-serif text-2xl">{result.level === 'ALL' ? 'Mix' : result.level}</p></div></div><div className="mt-8"><div className="mb-3 flex justify-between text-xs font-bold"><span>Recall strength</span><span className="text-[hsl(var(--secondary))]">{result.score} of {result.total}</span></div><div className="flex h-3 gap-1 overflow-hidden rounded-full bg-muted">{result.answers.map((answer, index) => <span key={`${answer.word.id}-${index}`} className={cx('flex-1 rounded-sm', answer.correct ? 'bg-[hsl(var(--secondary))]' : 'bg-[hsl(var(--accent))]')} />)}</div></div></section>
    </div>
    <section className="mt-12"><SectionTitle eyebrow="Review drawer" title={missed.length ? 'Words to revisit' : 'Nothing slipped through'} action={missed.length ? <span className="text-xs text-muted-foreground">{missed.length} card{missed.length === 1 ? '' : 's'} marked</span> : undefined} />{missed.length ? <div className="divide-y divide-border rounded-2xl border border-border bg-card">{missed.map(({ word }) => <div key={word.id} className="flex items-center gap-4 p-4 md:p-5"><div className="grid size-12 shrink-0 place-items-center rounded-xl bg-muted"><span className="kanji-display text-2xl">{word.expression}</span></div><div className="min-w-0 flex-1"><p className="font-semibold">{word.reading || word.expression}</p><p className="truncate text-sm text-muted-foreground">{word.meaning || 'Meaning not added yet — edit in My words.'}</p></div><LevelPill level={word.level} /></div>)}</div> : <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center"><Sparkles className="mx-auto text-[hsl(var(--accent))]" size={24} /><p className="mt-3 font-serif text-2xl">Clean sweep.</p><p className="mt-2 text-sm text-muted-foreground">Your cabinet is very proud of you.</p></div>}</section>
    {jlptResult && <section className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5 md:p-6" data-testid="jlpt-review-link"><div><p className="mono-label text-muted-foreground">Latest JLPT practice</p><p className="mt-2 text-sm font-bold">{jlptPercent}% · {jlptScore}/{jlptResult.results.length} correct</p><p className="mt-1 text-xs text-muted-foreground">{jlptResult.filterName}</p></div><Link href="/exam?review=1" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--secondary))] px-4 py-3 text-xs font-bold text-[hsl(var(--secondary-foreground))]" data-testid="button-review-jlpt"><GraduationCap size={16} /> Review JLPT exam <ArrowRight size={15} /></Link></section>}
  </div>;
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress page — "how far is my study progress?"
// ─────────────────────────────────────────────────────────────────────────────
function DiscoverySyncNote() {
  const { status } = useCardProgress();
  return <p className="mt-2 text-xs text-muted-foreground" role="status">{status}</p>;
}

function ReviewLibrary() {
  const { words: customWords } = useCustomWords();
  const words = useMemo(() => [...vocabulary, ...customWordsToWords(customWords)], [customWords]);
  return <CardReview words={words} />;
}

function WordDiscoveryProgress() {
  const { words: customWords } = useCustomWords();
  const allWords = useMemo(() => [...vocabulary, ...customWordsToWords(customWords)], [customWords]);
  return <section className="mt-8 rounded-[1.75rem] border border-border bg-muted/30 p-5 text-left md:p-7" data-testid="word-discovery-progress">
    <p className="mono-label text-[hsl(var(--secondary))]">One new card at a time</p>
    <h2 className="mt-2 font-serif text-3xl">Your discoveries</h2>
    <Link href="/review" className="mt-3 inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-sm font-bold text-[hsl(var(--primary-foreground))]"><BookOpen size={16} /> Review cards & manage progress</Link>
    <p className="mt-3 text-sm leading-6 text-muted-foreground">New means not yet opened, or marked as New again. Seen means you've opened it since its last reset—not necessarily mastered it. Shuffling, changing decks, or resetting score history won't reset these counts.</p>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <DiscoverySummary keys={allWords.map(wordProgressKey)} title="Quiz Deck · unique words" />
      <DiscoverySummary keys={jlptQuestions.map(jlptProgressKey)} title="JLPT Exam · unique questions" />
    </div>
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-bold">Explore progress by level</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(['N5', 'N4', 'N3', 'N2', 'N1'] as const).map((level) => <DiscoverySummary key={`word-${level}`} keys={vocabulary.filter((word) => word.level === level).map(wordProgressKey)} title={`${level} vocabulary`} />)}
        {customWords.length > 0 && <DiscoverySummary keys={customWords.map(wordProgressKey)} title="My words" />}
        {(['N4', 'N3', 'N2', 'N1'] as const).map((level) => <DiscoverySummary key={`jlpt-${level}`} keys={jlptQuestions.filter((question) => question.level === level).map(jlptProgressKey)} title={`${level} JLPT questions`} />)}
      </div>
    </details>
    <p className="mt-4 text-xs leading-5 text-muted-foreground">Tracks the current Quiz Deck and JLPT Exam banks, not full mock simulations. Only an active practice or library review card counts; unopened cards, answer choices and result lists do not. Tracking starts with this feature; earlier scores cannot tell us which cards you opened.</p>
    <DiscoverySyncNote />
  </section>;
}

function Progress() {
  const { history } = useCabinetHistory();
  const p = useMemo(() => computeProgress(history), [history]);
  const jlptHistory = useMemo(() => history.filter(isJlptHistoryEntry), [history]);
  const jlptTotal = jlptHistory.reduce((sum, item) => sum + item.total, 0);
  const jlptScore = jlptHistory.reduce((sum, item) => sum + item.score, 0);
  const jlptAverage = jlptTotal === 0 ? 0 : Math.round((jlptScore / jlptTotal) * 100);
  const bonus = useMemo(() => computeBonusSummary(history), [history]);

  if (history.length === 0) {
    return <div className="mx-auto max-w-[720px] px-5 py-20 pb-28 text-center md:pb-12">
      <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-[hsl(var(--accent)/.17)] text-[hsl(var(--accent))]"><TrendingUp /></div>
      <h1 className="mt-6 font-serif text-4xl">Your discovery starts here.</h1>
      <p className="mt-3 text-sm text-muted-foreground">Open cards to build discovery progress. Finish a quiz to add score statistics.</p>
      <WordDiscoveryProgress />
      <div className="mt-7 flex flex-wrap justify-center gap-2"><Link href="/quiz" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-5 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]">Start a round <ArrowRight size={16} /></Link><Link href="/exam" className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-bold hover:bg-muted"><GraduationCap size={16} /> JLPT exam</Link></div>
    </div>;
  }

  const trendNote = p.trend === null ? 'need 10+ quizzes' : p.trend > 0 ? `up vs previous 5` : p.trend < 0 ? `down vs previous 5` : 'steady';

  return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:pb-12" data-testid="progress-page">
    <p className="mono-label text-muted-foreground">Progress / analysis</p>
    <h1 className="mt-2 font-serif text-4xl tracking-[-.04em]">How far you've come.</h1>
    <WordDiscoveryProgress />

    <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard icon={Target} label="Average score" value={`${p.average}%`} note={`${p.totalQuizzes} quizzes · ${p.totalCards} cards`} color="hsl(69 73% 45%)" />
      <StatCard icon={Trophy} label="Best round" value={`${p.best}%`} note="personal record" color="hsl(38 68% 50%)" />
      <StatCard icon={Coins} label="Bonus points" value={bonus.lifetime.toLocaleString()} note={bonus.bestDay ? `best day ${bonus.bestDay.points} pts · ${bonus.bestDay.date}` : 'finish daily tasks to earn'} color="hsl(11 77% 55%)" />
      <StatCard icon={TrendingUp} label="Trend" value={p.trend === null ? '—' : `${p.trend > 0 ? '+' : ''}${p.trend}%`} note={trendNote} color="hsl(194 71% 42%)" />
    </div>

    <section className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[hsl(var(--secondary)/.3)] bg-[hsl(var(--secondary)/.07)] p-5" data-testid="jlpt-progress-summary">
      <div><p className="mono-label text-[hsl(var(--secondary))]">JLPT practice</p><p className="mt-1 text-sm font-bold">{jlptHistory.length ? `${jlptAverage}% average across ${jlptHistory.length} test${jlptHistory.length === 1 ? '' : 's'} · ${jlptTotal} questions` : 'No JLPT tests completed yet.'}</p><p className="mt-1 text-xs text-muted-foreground">JLPT tests are included in your overall progress, daily bonus, and activity.</p></div><Link href="/exam" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--secondary))] px-4 py-3 text-xs font-bold text-[hsl(var(--secondary-foreground))]" data-testid="button-progress-jlpt"><GraduationCap size={16} /> Practice JLPT <ArrowRight size={15} /></Link>
    </section>

    <section className="mt-6 rounded-[1.75rem] border border-border bg-card p-6 md:p-8">
      <p className="mono-label text-muted-foreground">Last 20 rounds</p>
      <h2 className="mt-2 font-serif text-2xl">Score over time</h2>
      <div className="mt-6 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={p.chart} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" fontSize={11} tickLine={false} />
            <YAxis domain={[0, 100]} fontSize={11} unit="%" tickLine={false} />
            <Tooltip formatter={(v: number) => [`${v}%`, 'Score']} labelFormatter={(_, payload) => (payload?.[0]?.payload as { date?: string } | undefined)?.date ?? ''} />
            <Line type="monotone" dataKey="pct" stroke="hsl(69 73% 40%)" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>

    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-8">
        <p className="mono-label text-muted-foreground">By drawer</p>
        <h2 className="mt-2 font-serif text-2xl">Where you're strong</h2>
        <ul className="mt-6 space-y-4">
          {Object.entries(p.byLevel).sort((a, b) => b[1].total - a[1].total).map(([level, s]) => {
            const pct = Math.round((s.score / s.total) * 100);
            return <li key={level}>
              <div className="mb-1.5 flex justify-between text-sm font-bold"><span>{level}</span><span className="text-muted-foreground">{pct}% · {s.total} cards</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[hsl(var(--secondary))] transition-all" style={{ width: `${pct}%` }} /></div>
            </li>;
          })}
        </ul>
      </section>

      <section className="rounded-[1.75rem] border border-border bg-card p-6 md:p-8">
        <p className="mono-label text-muted-foreground">Last 14 days</p>
        <h2 className="mt-2 font-serif text-2xl">Consistency</h2>
        <div className="mt-6 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={p.activity} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
              <XAxis dataKey="day" fontSize={10} tickLine={false} />
              <YAxis allowDecimals={false} fontSize={11} tickLine={false} />
              <Tooltip formatter={(v: number) => [v, 'Quizzes']} />
              <Bar dataKey="quizzes" fill="hsl(38 68% 59%)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  </div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaderboard page — global ranking on lifetime daily-bonus points (opt-in,
// nickname required). Rows refresh as learners finish rounds.
// ─────────────────────────────────────────────────────────────────────────────
type LeaderRow = { uid: string; displayName: string; totalQuizzes: number; avgPct: number; bestPct: number; bonusPoints?: number; bestDay?: number; jlptQuizzes?: number; jlptAvgPct?: number; updatedAt: string };

function Leaderboard() {
  const { user } = useAuth();
  const { history, shareScores, toggleShareScores, nickname, saveNickname } = useCabinetHistory();
  const [draft, setDraft] = useState(nickname);
  const [nickMsg, setNickMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [sortBy, setSortBy] = useState<'bonusPoints' | 'avgPct'>('bonusPoints');
  const [tab, setTab] = useState<'global' | 'rank' | 'casual'>('global');

  useEffect(() => { setDraft(nickname); }, [nickname]);

  useEffect(() => {
    if (tab !== 'casual') return;
    let cancelled = false;
    setRows(null);
    api.leaderboard(sortBy)
      .then((list) => { if (!cancelled) setRows(list as LeaderRow[]); })
      .catch((err) => { console.error(err); if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [tab, sortBy, shareScores, nickname, history.length]);

  const hasNickname = nickname.trim().length > 0;
  const canSave = draft.trim().length > 0 && draft.trim() !== nickname;
  const medal = (i: number) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;

  return <div className="mx-auto max-w-[980px] px-5 py-8 pb-28 md:pb-12" data-testid="leaderboard-page">
    <p className="mono-label text-muted-foreground">Community / global boards</p>
    <h1 className="mt-2 font-serif text-4xl tracking-[-.04em]">{tab === 'casual' ? "Who's been studying." : tab === 'rank' ? 'Highest ranks.' : 'Top of the ladder.'}</h1>
    <p className="mt-3 text-sm text-muted-foreground">{tab === 'casual'
      ? <>The casual board ranks <strong>lifetime bonus points</strong> from daily tasks, Quiz Deck sessions and JLPT practice. <Link href="/bonus" className="font-bold text-[hsl(var(--secondary))] underline-offset-2 hover:underline">Today's tasks</Link> · <Link href="/exam" className="font-bold text-[hsl(var(--secondary))] underline-offset-2 hover:underline">Practice JLPT</Link></>
      : <><strong>Ranked mode only.</strong> {tab === 'global' ? 'Top Global ranks players by ranked points earned in solo rounds and won in party duels.' : 'Top Rank orders players by tier — N1 at the top — then by how close they are to promotion.'} Every ranked player with a nickname is listed automatically. <Link href="/quiz" className="font-bold text-[hsl(var(--secondary))] underline-offset-2 hover:underline">Play ranked</Link></>}</p>

    <div className="mt-6 grid grid-cols-3 gap-2" role="tablist" aria-label="Leaderboards">
      {([['global', 'Top Global', Trophy], ['rank', 'Top Rank', Crown], ['casual', 'Casual Study', BookOpen]] as const).map(([key, label, Icon]) =>
        <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cx('flex items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-bold', tab === key ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={`leaderboard-tab-${key}`}><Icon size={15} /> {label}</button>)}
    </div>

    <form onSubmit={async (e) => { e.preventDefault(); if (!canSave || saving) return; setSaving(true); setNickMsg(null); const err = await saveNickname(draft); setSaving(false); setNickMsg(err ? { kind: 'err', text: err } : { kind: 'ok', text: 'Nickname saved.' }); }} className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="min-w-[180px] flex-1">
        <label htmlFor="nickname" className="block text-sm font-bold">Your nickname</label>
        <span className="text-xs text-muted-foreground">{hasNickname ? 'This is the name other learners see.' : 'Required before you can appear on the board.'}</span>
      </div>
      <input id="nickname" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30} placeholder="e.g. Wowok" className="h-10 w-44 rounded-xl border border-border bg-background px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)]" data-testid="input-nickname" />
      <button type="submit" disabled={!canSave || saving} className="rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-save-nickname">{saving ? '…' : 'Save'}</button>
      {nickMsg && <p className={cx('w-full text-xs font-semibold', nickMsg.kind === 'ok' ? 'text-[hsl(var(--secondary))]' : 'text-[hsl(var(--destructive))]')} data-testid="text-nickname-msg">{nickMsg.text}</p>}
    </form>

    {tab !== 'casual' && <RankedLeaderboard by={tab === 'global' ? 'points' : 'tier'} currentUid={user?.uid} />}

    {tab === 'casual' && <>
      <label className={cx('mt-3 flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4', hasNickname ? 'cursor-pointer' : 'opacity-50')}>
        <span>
          <span className="block text-sm font-bold">Share my casual scores</span>
          <span className="text-xs text-muted-foreground">Only your nickname, lifetime bonus points and average score are shown. Turn off any time. (Ranked boards do not use this switch.)</span>
        </span>
        <input type="checkbox" checked={shareScores} disabled={!hasNickname} onChange={(e) => toggleShareScores(e.target.checked)} className="size-5 accent-[hsl(var(--accent))]" data-testid="toggle-share-scores" />
      </label>

      <div className="mt-6 flex gap-2">
        {([['bonusPoints', 'Bonus points'], ['avgPct', 'Average %']] as const).map(([key, label]) =>
          <button key={key} onClick={() => setSortBy(key)} className={cx('rounded-xl border px-3 py-2 text-xs font-bold', sortBy === key ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.14)]' : 'border-border hover:bg-muted')} data-testid={`leaderboard-sort-${key}`}>{label}</button>)}
      </div>

      <section className="mt-4 overflow-hidden rounded-[1.75rem] border border-border bg-card">
        {rows === null && <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>}
        {rows?.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">Nobody is sharing yet. Set a nickname and flip the switch above to be first.</p>}
        {rows && rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="bg-muted text-left"><tr>
            <th className="mono-label p-3">#</th><th className="mono-label p-3">Learner</th>
            <th className="mono-label p-3 text-right">Points accumulated</th>
            <th className="mono-label p-3 text-right">Avg %</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={r.uid} className={cx('border-t border-border', r.uid === user?.uid && 'bg-[hsl(var(--accent)/.10)] font-bold')} data-testid={`leaderboard-row-${i + 1}`}>
              <td className="p-3 font-mono text-muted-foreground">{sortBy === 'bonusPoints' ? medal(i) : i + 1}</td>
              <td className="p-3">{r.displayName}{r.uid === user?.uid && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}</td>
              <td className="p-3 text-right"><span className="inline-flex items-center gap-1.5 font-bold"><Coins size={14} className="text-[hsl(var(--accent))]" />{(r.bonusPoints ?? 0).toLocaleString()}</span></td>
              <td className="p-3 text-right">{r.avgPct}%</td>
            </tr>)}
          </tbody>
        </table></div>}
        <p className="border-t border-border bg-muted/40 px-4 py-2.5 text-[11px] text-muted-foreground">Rows show what each learner last published — totals refresh automatically as they finish rounds.</p>
      </section>
    </>}
  </div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Friends page — invite by code, confirm invitations, keep score with your
// study buddies (lifetime bonus points side by side)
// ─────────────────────────────────────────────────────────────────────────────
type Pair = { id: string; members: string[]; names: Record<string, string>; createdAt?: string };

function Friends() {
  const { user } = useAuth();
  const {
    history, nickname, friendCode, generateFriendCode, addFriendByCode,
    confirmFriendRequest, declineFriendRequest, cancelFriendRequest, removeFriend, friendRequests,
  } = useCabinetHistory();
  const bonus = useMemo(() => computeBonusSummary(history), [history]);
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [friendBonus, setFriendBonus] = useState<Record<string, number | null>>({});
  const [codeInput, setCodeInput] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null); // pairId awaiting the "sure?" click
  const [resettingRanked, setResettingRanked] = useState(false);

  // Friendships + each buddy's public bonus points in ONE call. It used to be a
  // listener for the pairs plus one listener per friend.
  usePoll(
    () => api.pairs(true),
    (list) => {
      const myId = user?.uid ?? '';
      setPairs(list.map((p) => ({ id: p.id, members: p.members, names: p.names, createdAt: p.createdAt })));
      const bonuses: Record<string, number | null> = {};
      for (const pair of list) {
        const other = pair.members.find((m) => m !== myId);
        if (other) bonuses[other] = pair.friendBonus ?? null;
      }
      setFriendBonus(bonuses);
    },
    20_000,
    !!user,
  );

  const me = user?.uid ?? '';
  const invites = friendRequests.filter((r) => r.to === me);  // waiting for MY confirmation
  const sent = friendRequests.filter((r) => r.from === me);   // waiting for THEIR confirmation
  const hasNickname = nickname.trim().length > 0;
  const jlptSessions = history.filter(isJlptHistoryEntry).length;
  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const res = await addFriendByCode(codeInput).catch((x): FriendActionResult => ({ ok: false, text: (x?.message as string) || 'Something went wrong.' }));
    setBusy(false);
    setMsg({ kind: res.ok ? 'ok' : 'err', text: res.text });
    if (res.ok) setCodeInput('');
  };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(friendCode); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  const resetRanked = async () => {
    if (!window.confirm('Reset Ranked points, tier, and mastered cards? This cannot be undone. You will start again at N5 with 0 Ranked points.')) return;
    setResettingRanked(true);
    try { await api.resetRanked(); localStorage.removeItem('kotoba-ranked-v1'); window.location.reload(); }
    catch (error) { setMsg({ kind: 'err', text: error instanceof Error ? error.message : 'Could not reset ranked progress.' }); setResettingRanked(false); }
  };

  // Shared error surface for the confirm / decline / cancel / remove buttons.
  const act = async (fn: () => Promise<string | null>) => {
    const err = await fn();
    if (err) setMsg({ kind: 'err', text: err });
  };

  return <div className="mx-auto max-w-[900px] px-5 py-8 pb-28 md:pb-12" data-testid="friends-page">
    <p className="mono-label text-muted-foreground">Friends / bonus buddies</p>
    <h1 className="mt-2 font-serif text-4xl tracking-[-.04em]">Study buddies.</h1>
    <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
      Swap invite codes and each other's <strong>lifetime bonus points</strong> show up right here — a friendly rival is worth more than any reminder notification. Points come from finishing daily tasks by playing, never from simply opening the app.
    </p>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[hsl(var(--secondary)/.3)] bg-[hsl(var(--secondary)/.07)] p-4" data-testid="friends-jlpt-summary"><p className="text-xs leading-5 text-muted-foreground">JLPT practice also feeds your daily tasks and points. <strong>{jlptSessions} JLPT test{jlptSessions === 1 ? '' : 's'} completed.</strong></p><Link href="/exam" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--secondary))] px-3 py-2 text-xs font-bold text-[hsl(var(--secondary-foreground))]" data-testid="button-friends-jlpt"><GraduationCap size={15} /> Practice JLPT</Link></div>

    {!hasNickname && <div className="mt-6 rounded-2xl border border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.1)] p-4 text-sm">
      Set a nickname on the <Link href="/leaderboard" className="font-bold underline">Leaderboard</Link> page first — buddies need to know who you are.
    </div>}

    {/* My bonus at a glance */}
    <section className="mt-6 flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-border bg-card p-5" data-testid="friends-bonus-summary">
      <div className="flex flex-wrap gap-8">
        <div><p className="mono-label text-muted-foreground">Lifetime points</p><p className="mt-1 flex items-center gap-2 font-serif text-3xl"><Coins size={22} className="text-[hsl(var(--secondary))]" />{bonus.lifetime.toLocaleString()}</p><p className="text-xs text-muted-foreground">what ranks you globally</p></div>
        <div><p className="mono-label text-muted-foreground">Today</p><p className="mt-1 font-serif text-3xl">{bonus.today.points}<span className="text-base text-muted-foreground"> pts</span></p><p className="text-xs text-muted-foreground">{bonus.tasksDone}/{bonus.tasksTotal} tasks done{bonus.today.cleared ? ' · full clear!' : ''}</p></div>
      </div>
      <Link href="/bonus" className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-friends-open-bonus"><Gift size={14} /> Open daily bonus <ArrowRight size={13} /></Link>
    </section>

    <div className="mt-6 grid gap-4 md:grid-cols-2">
      {/* My code */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="mono-label text-muted-foreground">Your invite code</p>
        {friendCode
          ? <div className="mt-3 flex items-center gap-2"><span className="rounded-xl bg-muted px-4 py-2.5 font-mono text-xl font-bold tracking-widest" data-testid="text-friend-code">{friendCode}</span><button onClick={copyCode} className="rounded-xl border border-border px-3 py-2.5 text-xs font-bold hover:bg-muted">{copied ? 'Copied!' : 'Copy'}</button></div>
          : <button onClick={async () => { const err = await generateFriendCode(); if (err) setMsg({ kind: 'err', text: err }); }} disabled={!hasNickname} className="mt-3 rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40" data-testid="button-generate-code">Generate my code</button>}
        <p className="mt-3 text-xs text-muted-foreground">Send this to a friend. Anyone who enters it sends you an invitation — you confirm it on this page, and only then are you friends. Share it only with people you know.</p>
      </section>

      {/* Enter a code */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="mono-label text-muted-foreground">Add a friend</p>
        <form onSubmit={submitCode} className="mt-3 flex gap-2">
          <input value={codeInput} onChange={(e) => setCodeInput(normalizeCode(e.target.value))} placeholder={`${CODE_PREFIX}-XXXX`} disabled={!hasNickname} className="h-11 flex-1 rounded-xl border border-border bg-background px-3 font-mono text-sm font-bold uppercase tracking-widest outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)] disabled:opacity-40" data-testid="input-friend-code" />
          <button type="submit" disabled={busy || !hasNickname || codeInput.length < CODE_LEN} className="rounded-xl bg-[hsl(var(--primary))] px-4 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40" data-testid="button-add-friend">{busy ? '…' : 'Send'}</button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">Entering their code sends them an invitation — they confirm it, then you can compare points below.</p>
      </section>
    </div>

    {msg && <p className={cx('mt-4 text-xs font-semibold', msg.kind === 'ok' ? 'text-[hsl(var(--secondary))]' : 'text-[hsl(var(--destructive))]')} data-testid="text-friend-msg">{msg.text}</p>}

    {/* Invitations waiting for MY confirmation */}
    {invites.length > 0 && <>
      <h2 className="mt-10 font-serif text-2xl">Friend invitations</h2>
      <p className="mt-1 text-xs text-muted-foreground">These people entered your code. Confirm to become friends, decline to dismiss.</p>
      <div className="mt-4 space-y-3">
        {invites.map((req) => <article key={req.id} className="rounded-2xl border border-[hsl(var(--secondary)/.45)] bg-[hsl(var(--secondary)/.06)] p-5" data-testid={`invite-${req.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold">{req.fromName || 'Friend'} <span className="font-normal text-muted-foreground">wants to be your friend</span></p>
              {Date.parse(req.createdAt) ? <p className="text-xs text-muted-foreground">sent {new Date(req.createdAt).toLocaleDateString()}</p> : null}
            </div>
            <div className="flex gap-2">
              <button onClick={() => act(() => confirmFriendRequest(req))} className="flex items-center gap-1.5 rounded-xl bg-[hsl(var(--primary))] px-4 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid={`button-confirm-${req.id}`}><Check size={13} /> Confirm</button>
              <button onClick={() => act(() => declineFriendRequest(req))} className="flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-xs font-bold hover:bg-muted" data-testid={`button-decline-${req.id}`}><X size={13} /> Decline</button>
            </div>
          </div>
        </article>)}
      </div>
    </>}

    {/* Pairs */}
    <h2 className="mt-10 font-serif text-2xl">Your buddies</h2>
    <div className="mt-4 space-y-3">
      {pairs === null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {pairs?.length === 0 && sent.length === 0 && <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No friends yet. Swap codes with someone and keep each other honest.</p>}

      {/* Invitations I sent — still waiting for the other side to confirm */}
      {sent.map((req) => <article key={`sent-${req.id}`} className="rounded-2xl border border-dashed border-border bg-card/60 p-5" data-testid={`sent-invite-${req.id}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="font-bold">{req.toName || 'Friend'}</p><p className="text-xs text-muted-foreground">invitation sent — waiting for them to confirm</p></div>
          <button onClick={() => act(() => cancelFriendRequest(req))} className="rounded-xl border border-border px-3 py-2 text-xs font-bold hover:bg-muted" data-testid={`button-cancel-${req.id}`}>Cancel invite</button>
        </div>
      </article>)}

      {pairs?.map((pair) => {
        const other = pair.members.find((m) => m !== me)!;
        const theirs = friendBonus[other];
        const lead = theirs === null || theirs === undefined ? null : bonus.lifetime - theirs;
        const bar = (a: number) => { const max = Math.max(a, theirs ?? 0, bonus.lifetime, 1); return Math.round((a / max) * 100); };
        return <article key={pair.id} className="rounded-2xl border border-border bg-card p-5" data-testid={`pair-${pair.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold">{pair.names?.[other] || 'Friend'}</p>
              <p className="text-xs text-muted-foreground">
                {theirs === null || theirs === undefined ? 'not sharing points yet — they need a nickname + sharing on the Leaderboard'
                  : lead === 0 ? 'dead even with you today'
                  : lead !== null && lead > 0 ? `you lead by ${lead.toLocaleString()} pts`
                  : `they lead by ${Math.abs(lead ?? 0).toLocaleString()} pts — finish your tasks!`}
              </p>
            </div>
            <div className="flex gap-2">
              {removing === pair.id
                ? <>
                  <span className="hidden self-center text-xs font-semibold text-muted-foreground sm:inline">Remove friend?</span>
                  <button onClick={() => { act(() => removeFriend(pair.id)); setRemoving(null); }} className="rounded-xl bg-[hsl(var(--destructive))] px-3 py-2 text-xs font-bold text-white" data-testid={`button-remove-sure-${pair.id}`}>Yes, remove</button>
                  <button onClick={() => setRemoving(null)} className="rounded-xl border border-border px-3 py-2 text-xs font-bold hover:bg-muted" data-testid={`button-remove-keep-${pair.id}`}>Keep</button>
                </>
                : <button onClick={() => setRemoving(pair.id)} title="Remove this friend" className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-bold text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/.1)]" data-testid={`button-remove-${pair.id}`}><Trash2 size={13} /> Remove</button>}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div><div className="mb-1 flex justify-between font-semibold"><span>You</span><span className="text-muted-foreground">{bonus.lifetime.toLocaleString()} pts</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-[hsl(var(--secondary))]" style={{ width: `${bar(bonus.lifetime)}%` }} /></div></div>
            <div><div className="mb-1 flex justify-between font-semibold"><span>{pair.names?.[other] || 'Friend'}</span><span className="text-muted-foreground">{theirs === null || theirs === undefined ? '—' : theirs.toLocaleString()}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-[hsl(var(--accent))]" style={{ width: `${theirs === null || theirs === undefined ? 0 : bar(theirs)}%` }} /></div></div>
          </div>
        </article>;
      })}
    </div>

    <details className="mt-10 rounded-2xl border border-border bg-card p-5 text-sm">
      <summary className="cursor-pointer font-bold">How the daily bonus & buddies work</summary>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
        <li><strong>Tasks, not login streaks:</strong> every day ships {DAILY_TASK_COUNT} missions (a warm-up + rotating ones). Merely opening the app pays nothing — points come from finishing tasks by playing.</li>
        <li><strong>Full clear:</strong> finish every mission of the day and you earn the <strong>+{DAILY_CLEAR_BONUS} pts</strong> completion bonus on top of the task points.</li>
        <li><strong>Points are forever:</strong> daily points add up to your lifetime total — that total ranks you on the global leaderboard and here against your buddies. Nothing "breaks" when you miss a day; you just start fresh tomorrow.</li>
        <li><strong>Invitations:</strong> entering someone's code sends them an invitation — the friendship starts only after they confirm it on their Friends page (and vice versa). Change your mind? Hit <em>Remove</em> on a buddy card.</li>
        <li>Buddies only appear with their points if they opted into sharing on the Leaderboard page — nothing about your decks or answers is ever visible.</li>
      </ul>
    </details>
    <div className="mt-8 flex justify-start">
      <button onClick={resetRanked} disabled={resettingRanked} className="text-xs font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50" data-testid="button-reset-ranked">
        {resettingRanked ? 'Resetting Ranked…' : 'Reset Ranked progress'}
      </button>
    </div>
  </div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily Bonus page — MOBA-style rotating missions. Points for playing, never
// for merely showing up; the lifetime total ranks you globally.
// ─────────────────────────────────────────────────────────────────────────────
function DailyBonus() {
  const { history } = useCabinetHistory();
  const bonus = useMemo(() => computeBonusSummary(history), [history]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(id); }, []);
  const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
  const remain = Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000));
  const timeLabel = `${String(Math.floor(remain / 3600)).padStart(2, '0')}:${String(Math.floor((remain % 3600) / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
  const maxDay = Math.max(DAILY_CLEAR_BONUS, ...bonus.last7.map((d) => d.points), 1);
  const todayKey = toDateKey(now);

  return <div className="mx-auto max-w-[900px] px-5 py-8 pb-28 md:pb-12" data-testid="daily-bonus-page">
    <p className="mono-label text-muted-foreground">Daily bonus / missions</p>
    <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
      <h1 className="font-serif text-4xl tracking-[-.04em]">Today's tasks.</h1>
      <span className="mono-label flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground" data-testid="bonus-reset-timer"><Clock3 size={13} /> Resets in {timeLabel}</span>
    </div>
    <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">No reward for just opening the app — points come from actually playing. Clear all {bonus.tasksTotal} of today's tasks for the full-clear bonus, and your lifetime points climb the global leaderboard.</p>

    <section className="mt-6 grid gap-3 sm:grid-cols-3" data-testid="bonus-summary-cards">
      <div className="soft-shadow rounded-2xl border border-[hsl(var(--accent)/.5)] bg-[hsl(var(--accent)/.1)] p-5">
        <p className="mono-label text-muted-foreground">Today · {todayKey}</p>
        <p className="mt-2 flex items-end gap-2 font-serif text-4xl"><Gift size={26} className="mb-1 text-[hsl(var(--accent))]" />{bonus.today.points}<span className="mb-1 text-sm text-muted-foreground">pts</span></p>
        <p className="mt-1 text-xs text-muted-foreground">{bonus.tasksDone}/{bonus.tasksTotal} tasks · {bonus.today.cleared ? 'full-clear bonus earned' : `+${DAILY_CLEAR_BONUS} if you clear them all`}</p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="mono-label text-muted-foreground">Lifetime</p>
        <p className="mt-2 flex items-end gap-2 font-serif text-4xl"><Coins size={24} className="mb-1 text-[hsl(var(--secondary))]" />{bonus.lifetime.toLocaleString()}<span className="mb-1 text-sm text-muted-foreground">pts</span></p>
        <p className="mt-1 text-xs text-muted-foreground">this is what ranks you on the <Link href="/leaderboard" className="font-bold underline-offset-2 hover:underline">global board</Link></p>
      </div>
      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="mono-label text-muted-foreground">Best day</p>
        <p className="mt-2 font-serif text-4xl">{bonus.bestDay ? bonus.bestDay.points : '—'}<span className="ml-1 text-sm text-muted-foreground">{bonus.bestDay ? 'pts' : ''}</span></p>
        <p className="mt-1 text-xs text-muted-foreground">{bonus.bestDay ? `on ${bonus.bestDay.date}` : 'set your first record today'}</p>
      </div>
    </section>

    <section className="mt-10">
      <SectionTitle eyebrow="Missions" title="Play them, earn them." />
      <div className="space-y-3">
        {bonus.today.tasks.map((task) => {
          const pct = task.target > 0 ? Math.min(100, Math.round((task.progress / task.target) * 100)) : 0;
          return <article key={task.key} className={cx('rounded-2xl border p-5 transition-colors', task.done ? 'border-[hsl(var(--secondary)/.6)] bg-[hsl(var(--secondary)/.07)]' : 'border-border bg-card')} data-testid={`bonus-task-${task.key}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className={cx('grid size-9 shrink-0 place-items-center rounded-xl', task.done ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]' : 'bg-muted text-muted-foreground')}>{task.done ? <Check size={17} strokeWidth={3} /> : <Target size={16} />}</span>
                <div><p className="text-sm font-bold">{task.title}</p><p className="text-xs text-muted-foreground">{task.done ? `Complete — +${task.earned} pts banked` : `${task.progress}/${task.target} — worth +${task.unitPts} pts per step`}</p></div>
              </div>
              <div className="flex items-center gap-3">
                <span className="mono-label rounded-full bg-[hsl(var(--accent)/.14)] px-3 py-1 text-xs font-bold text-[hsl(var(--accent))]">{task.earned}/{task.target * task.unitPts} pts</span>
                {!task.done && <Link href={task.goto} className="inline-flex items-center gap-1.5 rounded-xl bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid={`button-task-${task.key}`}>Challenge <ArrowRight size={13} /></Link>}
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className={cx('h-full rounded-full transition-all', task.done ? 'bg-[hsl(var(--secondary))]' : 'bg-[hsl(var(--accent))]')} style={{ width: `${pct}%` }} /></div>
          </article>;
        })}
      </div>
    </section>

    <section className="mt-10 rounded-[1.75rem] border border-border bg-card p-6 md:p-8">
      <p className="mono-label text-muted-foreground">Last 7 days</p>
      <h2 className="mt-2 font-serif text-2xl">Points, not promises.</h2>
      <div className="mt-6 flex items-end gap-2" data-testid="bonus-last7">
        {bonus.last7.map((day) => <div key={day.day} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="h-4 text-[10px] font-bold text-muted-foreground">{day.points > 0 ? day.points : ''}</span>
          <span className={cx('w-full rounded-t-md', day.cleared ? 'bg-[hsl(var(--accent))]' : day.points > 0 ? 'bg-[hsl(var(--secondary)/.55)]' : 'bg-muted')} style={{ height: `${Math.max(4, Math.round((day.points / maxDay) * 72))}px` }} />
          <span className="mono-label text-[9px] text-muted-foreground">{day.day}</span>
        </div>)}
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">Days are scored retroactively from your finished rounds, so a session synced from another device completes the same tasks. Your total is built from the last 300 recorded rounds — consistent everywhere, nothing to claim, nothing to lose to a missed day. Gold bars are full-clear days.</p>
    </section>
  </div>;
}


function Router() {
  return <RoutedErrorBoundary><Shell><Switch>
    <Route path="/" component={() => <ProtectedRoute><Cabinet /></ProtectedRoute>} />
    <Route path="/quiz" component={() => <ProtectedRoute><Quiz /></ProtectedRoute>} />
    <Route path="/ranked/room/:matchId" component={() => <ProtectedRoute><RankedRoomPage /></ProtectedRoute>} />
    <Route path="/ranked/battle/:matchId" component={() => <ProtectedRoute><RankedBattlePage /></ProtectedRoute>} />
    <Route path="/exam" component={() => <ProtectedRoute><JlptExam /></ProtectedRoute>} />
    {/* JLPT Simulation hub — groups the real N3 and N4 exam simulations. */}
    <Route path="/jlpt-simulation" component={() => <ProtectedRoute><JlptSimulationHub /></ProtectedRoute>} />
    <Route path="/jlpt-simulation/n3" component={() => <ProtectedRoute><RealJlptSimulation /></ProtectedRoute>} />
    {/* Full exam day: 110-min written paper -> break -> 聴解 (60/55 min) -> one 合否 */}
    <Route path="/jlpt-simulation/n1/exam-day" component={() => <ProtectedRoute><RealN1ExamDay /></ProtectedRoute>} />
    <Route path="/jlpt-simulation/n1" component={() => <ProtectedRoute><RealN1Simulation /></ProtectedRoute>} />
    {/* Full exam day: 105-min written paper -> break -> 50-min 聴解 -> one 合否 */}
    <Route path="/jlpt-simulation/n2/exam-day" component={() => <ProtectedRoute><RealN2ExamDay /></ProtectedRoute>} />
    <Route path="/jlpt-simulation/n2" component={() => <ProtectedRoute><RealN2Simulation /></ProtectedRoute>} />
    <Route path="/jlpt-simulation/n4" component={() => <ProtectedRoute><RealN4Simulation /></ProtectedRoute>} />
    {/* Legacy path kept so old links/bookmarks to the N3 simulation keep working. */}
    <Route path="/real-simulation" component={() => <ProtectedRoute><RealJlptSimulation /></ProtectedRoute>} />
    <Route path="/custom" component={() => <ProtectedRoute><CustomWords /></ProtectedRoute>} />
    <Route path="/results" component={() => <ProtectedRoute><Results /></ProtectedRoute>} />
    <Route path="/review" component={() => <ProtectedRoute><ReviewLibrary /></ProtectedRoute>} />
    <Route path="/progress" component={() => <ProtectedRoute><Progress /></ProtectedRoute>} />
    <Route path="/bonus" component={() => <ProtectedRoute><DailyBonus /></ProtectedRoute>} />
    <Route path="/leaderboard" component={() => <ProtectedRoute><Leaderboard /></ProtectedRoute>} />
    <Route path="/friends" component={() => <ProtectedRoute><Friends /></ProtectedRoute>} />
    <Route path="/login" component={Login} />
    {/* No self sign-up: learner accounts are created by the administrator (see Login.tsx).
        Old sign-up URLs and bookmarked links just go to the log-in page, which explains
        how to request an account. */}
    <Route path="/signup"><Redirect to="/login" /></Route>
    <Route path="/sign-up"><Redirect to="/login" /></Route>
    <Route path="/register"><Redirect to="/login" /></Route>
    <Route path="/forgot-password" component={ForgotPassword} />
    {/* Landing page for the Firebase password-reset email link (?oobCode=...). */}
    <Route path="/reset-password" component={ResetPassword} />
    <Route path="/terms" component={TermsOfService} />
    <Route path="/privacy" component={PrivacyPolicy} />
    <Route component={NotFound} />
  </Switch></Shell></RoutedErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <DataProvider>
              <CardProgressProvider>
                <FinishPopupProvider>
                  <Router />
                </FinishPopupProvider>
              </CardProgressProvider>
            </DataProvider>
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
