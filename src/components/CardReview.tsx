import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { BookOpen, ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { DiscoveryFilterControl, OpenedCardBadge, useCardProgress } from '@/components/CardProgress';
import { filterDiscovered, wordProgressKey, type DiscoveryFilter } from '@/lib/cardProgress';
import type { Word } from '@/lib/vocabulary';

type ReviewItem = { key: string; title: string; subtitle: string; level: string; search: string; word: Word };
const PAGE_SIZE = 12;

export function CardReview({ words }: { words: Word[] }) {
  const { seen, ready, status, markAsNew } = useCardProgress();
  const [filter, setFilter] = useState<DiscoveryFilter>('seen');
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<{ items: ReviewItem[]; index: number } | null>(null);
  const catalogue = useMemo<ReviewItem[]>(() => words.map((word) => ({
    key: wordProgressKey(word), title: word.expression, subtitle: word.reading, level: word.level,
    search: `${word.expression} ${word.reading} ${word.meaning}`, word,
  })), [words]);
  const matching = useMemo(() => filterDiscovered(catalogue, (item) => item.key, seen, filter).filter((item) =>
    (level === 'all' || item.level === level) && item.search.normalize('NFKC').toLowerCase().includes(search.normalize('NFKC').trim().toLowerCase()),
  ), [catalogue, seen, filter, level, search]);
  const lastPage = Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageItems = matching.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const active = review?.items[review.index];
  const reset = (item: ReviewItem) => {
    if (!window.confirm(`Mark “${item.title}” as New again? Its content stays in the app. Its Seen progress will be reset across devices, and opening it again will count as a new discovery.`)) return;
    markAsNew(item.key);
    setReview(null);
    setMessage(`${item.title} marked as New. Open it again to build progress.`);
  };
  const practiceUrl = `/quiz?discovery=${filter}${level === 'all' ? '' : `&decks=${level}`}`;

  return <div className="mx-auto max-w-[1100px] px-5 py-8 pb-28 md:px-10 md:py-14" data-testid="card-review-page">
    <p className="mono-label text-[hsl(var(--secondary))]">Your personal review library</p>
    <h1 className="mt-2 font-serif text-4xl tracking-[-.04em]">Meet your words again.</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Browse vocabulary without changing progress. Open a card to review it. Mark a Seen card as New to start its discovery again—without deleting the card or changing your scores.</p>
    <div className="mt-6 flex flex-wrap gap-2">
      <span className="rounded-xl border border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] px-4 py-3 text-sm font-bold">Vocabulary cards</span>
      <Link href={practiceUrl} className="ml-auto inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]" data-testid="review-practice-link"><BookOpen size={16} /> Practice {filter === 'all' ? 'all' : filter} cards</Link>
    </div>
    <div className="mt-5 grid gap-5 rounded-2xl border border-border bg-card p-5 md:grid-cols-2">
      <DiscoveryFilterControl value={filter} onChange={(value) => { setFilter(value); setPage(0); }} disabled={!ready} />
      <div className="flex items-end gap-3">
        <label className="flex-1 text-sm font-bold"><span className="mb-2 flex items-center gap-1"><Search size={14} /> Search cards</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Word, reading or meaning" className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-normal" /></label>
        <label className="text-sm font-bold">Level<select value={level} onChange={(event) => { setLevel(event.target.value); setPage(0); }} className="mt-2 block h-11 rounded-xl border border-border bg-background px-3"><option value="all">All</option>{['N5', 'N4', 'N3', 'N2', 'N1'].map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
    </div>
    <p className="mt-3 text-xs text-muted-foreground">{status}</p>
    <p className="mt-2 text-sm font-semibold" role="status">{message}</p>
    {!ready ? <p className="mt-6">Loading your cards…</p> : <>
      <p className="my-5 text-sm text-muted-foreground" data-testid="review-matching-count">{matching.length.toLocaleString()} matching vocabulary cards · {filter === 'all' ? 'All cards' : filter === 'seen' ? 'Seen only' : 'New only'}</p>
      {matching.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center" data-testid="review-empty"><h2 className="font-serif text-2xl">No matching cards yet.</h2><p className="mt-2 text-sm text-muted-foreground">Try another filter or open some cards in practice.</p></div> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{pageItems.map((item) => <article key={item.key} className="flex flex-col rounded-2xl border border-border bg-card p-5" data-testid="review-card-row">
        <div className="flex justify-between gap-2 text-xs font-bold text-muted-foreground"><span>{item.level}</span><span>{seen.has(item.key) ? 'Seen before' : 'New to you'}</span></div>
        <h2 className="kanji-display mt-4 break-words text-3xl">{item.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{item.subtitle}</p>
        <div className="mt-auto flex flex-wrap gap-2 pt-5"><button onClick={() => setReview({ items: matching, index: matching.findIndex((entry) => entry.key === item.key) })} className="rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))]" data-testid="review-open-card">Open card</button>{seen.has(item.key) && <button onClick={() => reset(item)} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-bold hover:bg-muted" data-testid="review-reset-card"><RotateCcw size={13} /> Mark as New</button>}</div>
      </article>)}</div>}
      {lastPage > 0 && <nav aria-label="Review library pages" className="mt-6 flex items-center justify-center gap-4"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded-lg border p-2 disabled:opacity-40" aria-label="Previous page"><ChevronLeft size={18} /></button><span className="text-sm">Page {currentPage + 1} of {lastPage + 1}</span><button disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)} className="rounded-lg border p-2 disabled:opacity-40" aria-label="Next page"><ChevronRight size={18} /></button></nav>}
    </>}
    <p className="mt-6 text-xs text-muted-foreground">This library contains vocabulary cards only. JLPT questions remain available in the separate JLPT Exam page.</p>
    <Dialog open={!!active} onOpenChange={(open) => { if (!open) setReview(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="review-card-dialog">
        {active && review && <>
          <DialogTitle className="font-serif text-2xl">{active.title}</DialogTitle>
          <DialogDescription>{active.level} · Vocabulary review · Card {review.index + 1} of {review.items.length}</DialogDescription>
          <div><OpenedCardBadge key={active.key} cardKey={active.key} /></div>
          <div className="space-y-4 py-5"><p className="kanji-display break-words text-5xl">{active.word.expression}</p><p className="text-lg text-[hsl(var(--secondary))]">{active.word.reading}</p><p className="whitespace-pre-line text-lg">{active.word.meaning || 'No meaning added yet. You can add one in My words.'}</p></div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><button onClick={() => reset(active)} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-bold" data-testid="review-reset-active"><RotateCcw size={13} /> Mark as New & close</button><div className="flex gap-2"><button disabled={review.index === 0} onClick={() => setReview({ ...review, index: review.index - 1 })} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40">Previous card</button><button disabled={review.index + 1 === review.items.length} onClick={() => setReview({ ...review, index: review.index + 1 })} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40">Next card</button></div></div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
