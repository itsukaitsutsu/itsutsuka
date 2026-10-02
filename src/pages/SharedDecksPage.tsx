import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import { PartOfSpeechBadge } from '@/components/PartOfSpeech';
import { api, type SharedDeck, type SharedDeckSummary } from '@/lib/api';

export function SharedDecksPage() {
  const [decks, setDecks] = useState<SharedDeckSummary[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let requestNumber = 0;
    const refresh = async () => {
      const currentRequest = ++requestNumber;
      try {
        const pages = [];
        for (let i = 0; i <= page; i++) pages.push(await api.sharedDecks(i));
        if (!active || currentRequest !== requestNumber) return;
        setDecks([...new Map(pages.flatMap(result => result.decks).map(deck => [deck.id, deck])).values()]);
        setHasMore(pages.at(-1)?.hasMore ?? false); setError('');
      } catch (err) {
        if (active && currentRequest === requestNumber) { setDecks([]); setHasMore(false); setError(err instanceof Error ? err.message : 'Could not load shared decks.'); }
      } finally { if (active && currentRequest === requestNumber) setLoading(false); }
    };
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 20_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [page]);
  return <div className="mx-auto max-w-5xl space-y-6 px-5 py-8 pb-24 md:px-10" data-testid="shared-decks">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Study together</p><h1 className="font-serif text-4xl">Shared decks</h1><p className="mt-2 text-sm text-muted-foreground">Decks your administrator has published for everyone or for your account. Open a deck to review its current cards; your own saved-list slots are not used.</p></header>
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}
    {loading && <p role="status">Loading shared decks…</p>}
    {!loading && !error && !decks.length && <div className="rounded-2xl border border-dashed p-8"><p className="font-serif text-xl">Nothing shared with you yet.</p><p className="mt-2 text-sm text-muted-foreground">When an admin publishes a deck for your account, it will show up here.</p></div>}
    <div className="grid gap-4 sm:grid-cols-2">{decks.map(deck => <Link href={`/shared/${encodeURIComponent(deck.id)}`} key={deck.id} className="rounded-2xl border border-border bg-card p-5 transition-colors hover:bg-muted" data-testid="shared-deck-link"><span className="text-xs font-bold text-muted-foreground">{deck.visibility === 'public' ? 'Everyone' : 'Shared with you'}</span><h2 className="mt-2 font-serif text-2xl">{deck.name}</h2><p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground"><BookOpen size={16} /> {deck.cardCount} saved words</p></Link>)}</div>
    {hasMore && <button onClick={() => setPage(current => current + 1)} className="rounded-lg border px-4 py-2 text-sm font-bold">Load more decks</button>}
  </div>;
}

export function SharedDeckPage({ id }: { id: string }) {
  const [deck, setDeck] = useState<SharedDeck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [studying, setStudying] = useState(false);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    let active = true;
    let requestNumber = 0;
    setDeck(null); setLoading(true); setStudying(false);
    const refresh = async () => {
      const currentRequest = ++requestNumber;
      try {
        const current = await api.sharedDeck(id);
        if (active && currentRequest === requestNumber) { setDeck(current); setError(''); }
      } catch (err) {
        // Clear the cards if access was revoked or the publication was removed.
        if (active && currentRequest === requestNumber) { setDeck(null); setError(err instanceof Error ? err.message : 'This deck is not available.'); }
      } finally { if (active && currentRequest === requestNumber) setLoading(false); }
    };
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 20_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [id]);
  const cards = deck?.cards ?? [];
  const currentIndex = Math.min(index, Math.max(0, cards.length - 1));
  const current = cards[currentIndex];
  const filtered = cards.filter(card => `${card.expression} ${card.reading} ${card.meaning} ${card.partOfSpeechEn ?? ''} ${card.partOfSpeechJp ?? ''}`.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').trim().toLowerCase()));
  const next = (step: number) => { setIndex(Math.max(0, Math.min(currentIndex + step, cards.length - 1))); setRevealed(false); };
  return <div className="mx-auto max-w-5xl space-y-6 px-5 py-8 pb-24 md:px-10" data-testid="shared-deck">
    <Link href="/shared" className="inline-flex items-center gap-2 text-sm font-bold hover:underline"><ChevronLeft size={16} /> All shared decks</Link>
    {loading && <p role="status">Loading deck…</p>}
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}
    {deck && <><header><span className="text-xs font-bold text-muted-foreground">{deck.visibility === 'public' ? 'For everyone' : 'Shared privately with you'} · {cards.length} cards</span><h1 className="mt-2 font-serif text-4xl">{deck.name}</h1><p className="mt-2 text-sm text-muted-foreground">Read-only; follows the publisher's saved list. Changes may take up to 20 seconds to appear. Your personal slots are not changed.</p></header>
      {!cards.length ? <p className="rounded-xl border p-5 text-sm">This deck has no available cards right now.</p> : <>
        <button onClick={() => { setStudying(value => !value); setRevealed(false); }} className="rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">{studying ? 'Back to word list' : 'Practice flashcards'}</button>
        {studying ? <section className="space-y-4 rounded-2xl border bg-card p-6 text-center" aria-label="Shared deck flashcards"><p className="text-xs text-muted-foreground">Card {currentIndex + 1} / {cards.length} · {current.level}</p><h2 className="kanji-display break-words text-5xl">{current.expression}</h2><p className="text-lg text-[hsl(var(--secondary))]">{current.reading}</p><PartOfSpeechBadge partOfSpeechEn={current.partOfSpeechEn} partOfSpeechJp={current.partOfSpeechJp} className="mx-auto" />{revealed ? <p className="border-t pt-5 text-xl">{current.meaning || 'Meaning not added yet'}</p> : <button className="rounded-lg border px-5 py-2 text-sm font-bold" onClick={() => setRevealed(true)}>Show meaning</button>}<div className="flex justify-center gap-3 pt-4"><button aria-label="Previous card" disabled={!currentIndex} onClick={() => next(-1)} className="rounded-lg border p-2 disabled:opacity-40"><ChevronLeft /></button><button aria-label="Next card" disabled={currentIndex + 1 >= cards.length} onClick={() => next(1)} className="rounded-lg border p-2 disabled:opacity-40"><ChevronRight /></button></div></section> : <><label className="block text-sm font-bold">Search words<input value={query} onChange={e => setQuery(e.target.value)} className="mt-2 block w-full rounded-xl border bg-background px-3 py-2 font-normal" placeholder="Expression, reading, part of speech or meaning" /></label><div className="grid gap-3 sm:grid-cols-2">{filtered.slice(0, 200).map(card => <article key={card.id} className="rounded-xl border bg-card p-4"><span className="text-xs text-muted-foreground">{card.level}</span><h2 className="kanji-display mt-2 text-2xl">{card.expression}</h2><p className="text-sm text-muted-foreground">{card.reading}</p><PartOfSpeechBadge partOfSpeechEn={card.partOfSpeechEn} partOfSpeechJp={card.partOfSpeechJp} className="mt-2" /><p className="mt-3 text-sm">{card.meaning || 'Meaning not added yet'}</p></article>)}</div>{filtered.length > 200 && <p className="text-sm text-muted-foreground">Showing 200 matches. Narrow the search to see more.</p>}</>}
      </>}
    </>}
  </div>;
}
