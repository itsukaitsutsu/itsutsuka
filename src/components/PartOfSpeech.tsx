import {
  PART_OF_SPEECH_OPTIONS,
  type PartOfSpeechFilter,
  type PartOfSpeechKey,
} from '@/lib/vocabulary';

export function PartOfSpeechBadge({
  partOfSpeechEn,
  partOfSpeechJp,
  className = '',
}: {
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
  className?: string;
}) {
  const english = partOfSpeechEn?.trim();
  const japanese = partOfSpeechJp?.trim();
  if (!english && !japanese) return null;

  return <span
    className={`inline-flex max-w-full items-center gap-1 rounded-full border border-[hsl(var(--secondary)/.25)] bg-[hsl(var(--secondary)/.07)] px-2.5 py-1 text-[10px] font-semibold leading-4 text-[hsl(var(--secondary))] ${className}`}
    aria-label={`Part of speech: ${english || 'not specified'}${japanese ? `, ${japanese}` : ''}`}
    data-testid="part-of-speech-badge"
  >
    {english && <span>{english}</span>}
    {english && japanese && <span aria-hidden="true" className="opacity-60">·</span>}
    {japanese && <span lang="ja">{japanese}</span>}
  </span>;
}

export function PartOfSpeechFilterControl({
  value,
  onChange,
  counts,
  disabled = false,
  testIdPrefix = 'quiz-pos',
  showLegend = true,
}: {
  value: PartOfSpeechFilter;
  onChange: (value: PartOfSpeechFilter) => void;
  counts?: Partial<Record<PartOfSpeechKey, number>>;
  disabled?: boolean;
  testIdPrefix?: string;
  showLegend?: boolean;
}) {
  const options: Array<{ key: PartOfSpeechFilter; label: string; japanese: string; count?: number }> = [
    { key: 'all', label: 'All types', japanese: 'すべて' },
    ...PART_OF_SPEECH_OPTIONS.map((option) => ({ ...option, count: counts?.[option.key] })),
  ];

  return <fieldset className="min-w-0" data-testid={`${testIdPrefix}-filter`} disabled={disabled}>
    {showLegend && <legend className="mb-3 text-sm font-bold">Part of speech</legend>}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="Filter by part of speech">
      {options.map((option) => {
        const selected = value === option.key;
        return <button
          key={option.key}
          type="button"
          aria-pressed={selected}
          onClick={() => onChange(option.key)}
          className={`flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${selected
            ? 'border-[hsl(var(--secondary))] bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]'
            : 'border-border bg-background hover:bg-muted'}`}
          data-testid={`${testIdPrefix}-${option.key}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-bold">{option.label}</span>
            <span className="truncate text-[10px] text-muted-foreground" lang="ja">{option.japanese}</span>
          </span>
          {option.count !== undefined && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{option.count.toLocaleString()}</span>}
        </button>;
      })}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Filter applies to your chosen level drawers, Mixed, saved words, My words, and published shared decks.</p>
  </fieldset>;
}
