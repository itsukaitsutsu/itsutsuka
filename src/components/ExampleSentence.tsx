import { useEffect, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { loadExampleSet, sectorsForDeck, sentencePieces, type ExampleMatch, type ExampleSet } from '@/lib/exampleSentences';

/** Loads the static example files for an SSW deck (nothing is fetched for any other deck). */
export function useExampleSets(deckName: string | null | undefined): ExampleSet[] {
  const key = sectorsForDeck(deckName).join(',');
  const [sets, setSets] = useState<ExampleSet[]>([]);
  useEffect(() => {
    if (!key) { setSets([]); return; }
    let live = true;
    void Promise.all(key.split(',').map(sector => loadExampleSet(sector)))
      .then(loaded => { if (live) setSets(loaded.filter((set): set is ExampleSet => !!set)); });
    return () => { live = false; };
  }, [key]);
  return sets;
}

function Sentence({ match, furigana }: { match: ExampleMatch; furigana: boolean }) {
  return <p className="example-sentence-text text-lg md:text-xl" data-testid="example-sentence-text">
    {sentencePieces(match.markup, match.start, match.end).map((piece, i) => {
      const body = piece.ruby && furigana
        ? <ruby>{piece.text}<rp>(</rp><rt>{piece.ruby}</rt><rp>)</rp></ruby>
        : piece.text;
      return piece.hit ? <mark key={i} className="example-hit">{body}</mark> : <span key={i}>{body}</span>;
    })}
  </p>;
}

/** Collapsed by default. Only rendered when the current word has at least one exact match. */
export function ExampleSentenceBox({ examples }: { examples: ExampleMatch[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [furigana, setFurigana] = useState(true);
  if (!examples.length) return null;
  const match = examples[position % examples.length];
  const hasRuby = /\([ぁ-ゖァ-ヺーｰ]+\)/.test(match.markup);
  return <div className="example-sentence mx-auto mb-6 max-w-2xl text-center" data-testid="example-sentence-box">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} data-testid="example-sentence-toggle"
      className="mono-label inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-[11px] font-bold text-muted-foreground hover:bg-muted">
      <BookOpen size={13} /> 例文 Example sentence{examples.length > 1 ? ` (${examples.length})` : ''}
    </button>
    {open && <div className="mt-3 rounded-2xl bg-muted/60 px-5 py-4" data-testid="example-sentence">
      <Sentence match={match} furigana={furigana} />
      <p className="mt-1 text-xs text-muted-foreground" data-testid="example-sentence-source">{match.source}{match.page ? ` · p.${match.page}` : ''}</p>
      <div className="mt-2 flex items-center justify-center gap-2">
        {examples.length > 1 && <>
          <button type="button" aria-label="Previous example" onClick={() => setPosition(value => (value + examples.length - 1) % examples.length)} className="rounded-full border border-border p-1 text-muted-foreground hover:bg-card"><ChevronLeft size={14} /></button>
          <span className="mono-label text-[10px] text-muted-foreground" data-testid="example-sentence-position">{(position % examples.length) + 1} / {examples.length}</span>
          <button type="button" aria-label="Next example" onClick={() => setPosition(value => (value + 1) % examples.length)} data-testid="example-sentence-next" className="rounded-full border border-border p-1 text-muted-foreground hover:bg-card"><ChevronRight size={14} /></button>
        </>}
        {hasRuby && <button type="button" onClick={() => setFurigana(value => !value)} aria-pressed={furigana} className="mono-label inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] font-bold text-muted-foreground hover:bg-card">
          {furigana ? <Eye size={12} /> : <EyeOff size={12} />} ふりがな
        </button>}
      </div>
    </div>}
  </div>;
}
