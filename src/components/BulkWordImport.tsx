import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { FileUp, Check, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCardProgress } from '@/components/CardProgress';
import { matchWordImport, MAX_IMPORT_BYTES, parseWordImport, type BulkImportRequest, type BulkImportResult, type ParsedWordImport } from '@/lib/bulkWordImport';
import type { CustomWord } from '@/lib/customWords';
import type { Level, Word } from '@/lib/vocabulary';

export function BulkWordImport({ originals, customWords, ready, slotLimitReached, onImport, onImported }: {
  originals: Word[]; customWords: CustomWord[]; ready: boolean; slotLimitReached: boolean;
  onImport: (request: BulkImportRequest) => Promise<BulkImportResult>;
  onImported: () => void;
}) {
  const { seen, ready: progressReady } = useCardProgress();
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedWordImport | null>(null);
  const [fileName, setFileName] = useState('');
  const [name, setName] = useState('');
  const [defaultLevel, setDefaultLevel] = useState<Level>('N5');
  const [previewSource, setPreviewSource] = useState('all');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const generation = useRef(0);
  const importId = useRef('');
  const savingRef = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);
  const matches = useMemo(() => matchWordImport(parsed?.rows ?? [], originals, customWords), [parsed, originals, customWords]);
  const originalsCount = matches.filter((item) => item.source === 'original').length;
  const existingCount = matches.filter((item) => item.source === 'existing').length;
  const newCount = matches.filter((item) => item.source === 'new').length;
  const seenCount = matches.filter((item) => seen.has(item.key)).length;
  const preview = matches.filter((item) => previewSource === 'all' || item.source === previewSource);

  const readFile = async (file: File) => {
    const token = ++generation.current;
    setParsed(null); setResult(null); setError(''); setReading(true); setFileName(file.name); setPreviewSource('all');
    setName(file.name.replace(/\.csv$/i, '').slice(0, 120));
    importId.current = globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('CSV is too large. The limit is 1 MiB.');
      const buffer = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new Error('Use a UTF-8 CSV file (Excel: CSV UTF-8). The file could not be decoded.'); }
      const next = parseWordImport(text);
      if (token !== generation.current) return;
      setParsed(next);
      if (!next.rows.length) setError('No valid words to import. Check the row issues or add expression and reading values.');
    } catch (cause) {
      if (token === generation.current) setError((cause as Error).message || 'The CSV could not be read.');
    } finally { if (token === generation.current) setReading(false); }
  };
  const submit = async () => {
    if (savingRef.current || !parsed?.rows.length || !ready || slotLimitReached || !name.trim()) return;
    const token = generation.current;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const imported = await onImport({ rows: parsed.rows, name, defaultLevel, importId: importId.current });
      if (token !== generation.current) return;
      setResult(imported);
      onImported();
    } catch (cause) {
      if (token === generation.current) {
        // ApiError.status, not Firestore's error codes: 0 = never reached the
        // Worker (offline / API down), 401/403 = the login token was rejected.
        const status = (cause as { status?: number }).status;
        setError(status === 0 ? 'Import needs an online connection. Nothing was partially saved. Reconnect and retry.'
          : status === 401 || status === 403 ? 'Import was not saved: your session expired. Sign in again, then retry the same preview.'
          : (cause as Error).message || 'Import could not be saved. Retry with the same preview.');
      }
    } finally {
      savingRef.current = false;
      if (token === generation.current) setSaving(false);
    }
  };
  const close = () => {
    generation.current += 1; setOpen(false); setParsed(null); setResult(null); setError(''); setReading(false);
  };

  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-bold hover:bg-muted" data-testid="button-import-csv"><FileUp size={15} /> Import CSV</button>
    <Dialog open={open} onOpenChange={(value) => { if (!savingRef.current) { if (value) setOpen(true); else close(); } }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="bulk-import-dialog" onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}>
        <DialogTitle className="font-serif text-3xl">Bring a word list into your Cabinet.</DialogTitle>
        <DialogDescription>Upload expression + reading, or kanji + furigana. Matches reuse original meanings and levels. Unmatched entries go into My words. Everything is saved into one new, active save slot.</DialogDescription>
        {result ? <section className="space-y-4 py-4" data-testid="bulk-import-success">
          <h3 className="flex items-center gap-2 text-lg font-bold"><Check className="text-[hsl(var(--secondary))]" /> Saved to “{result.list.name}”</h3>
          <p>{result.list.wordIds.length.toLocaleString()} words saved · {result.originalCount} originals · {result.reusedCount} existing My words · {result.createdCount} new My words.</p>
          <p className="text-sm text-muted-foreground">This slot is now selected in “Saving into”. The Cabinet behind this dialog is showing its saved words. Existing Seen/New progress is unchanged.</p>
          {result.createdCount > 0 && <p className="text-sm text-muted-foreground">New entries have no invented meanings. You can review their expression and reading now, or add meanings in My words to use them in meaning-based quizzes.</p>}
          {result.cacheWarning && <p role="alert" className="text-sm text-[hsl(var(--destructive))]">Saved in the cloud, but browser caching was unavailable. Stay online to reload your data.</p>}
          <div className="flex gap-3"><button onClick={close} className="rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]">View imported slot</button><Link href="/custom" onClick={close} className="rounded-xl border px-4 py-3 text-sm font-bold">Go to My words</Link></div>
        </section> : <>
          <div className="rounded-xl bg-muted p-4 text-xs leading-6"><p className="font-bold">Required CSV format (UTF-8)</p><pre className="whitespace-pre-wrap">{'expression,reading\n猫,ねこ\n犬,いぬ'}</pre><p>Only these two columns are needed. Additional columns, including meaning and level, are ignored so they cannot overwrite your data. Up to 5,000 data rows / 1 MiB.</p></div>
          <label className="block text-sm font-bold">Choose CSV<input type="file" accept=".csv,text/csv" disabled={saving} onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); event.target.value = ''; }} className="mt-2 block w-full rounded-xl border border-border p-3 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2" data-testid="input-bulk-csv" /></label>
          {reading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" /> Reading and matching your CSV…</p>}
          {!ready && <p role="status" className="text-sm text-muted-foreground">Waiting for your account's saved lists and custom words. Import requires an online connection.</p>}
          {slotLimitReached && <p role="alert" className="text-sm text-[hsl(var(--destructive))]">All 10 save slots are in use. Delete a slot before importing; no existing slot will be overwritten.</p>}
          {parsed && <>
            <label className="text-sm font-bold">New save slot name<input maxLength={120} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} className="mt-2 block h-11 w-full rounded-xl border border-border bg-background px-3 font-normal" data-testid="input-import-slot-name" /></label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="bulk-import-counts">
              {[['Original matches', originalsCount], ['Reuse My words', existingCount], ['New My words', newCount], ['Unique words', matches.length]].map(([label, count]) => <div key={label} className="rounded-xl border border-border p-3"><p className="text-xl font-bold">{count}</p><p className="text-xs text-muted-foreground">{label}</p></div>)}
            </div>
            <p className="text-xs text-muted-foreground">{fileName} · {parsed.dataRows} data rows · {parsed.duplicates} duplicates skipped · {parsed.issues.length} invalid rows skipped.</p>
            <p className="rounded-xl bg-muted p-3 text-sm" data-testid="bulk-import-seen-summary">{progressReady ? `${seenCount} already Seen · ${matches.length - seenCount} New. Importing preserves this progress; it does not open cards.` : 'Loading Seen/New status. Importing will not change discovery progress.'}</p>
            {parsed.ignoredColumns.length > 0 && <p className="text-xs text-muted-foreground">Ignored columns: {parsed.ignoredColumns.join(', ')}.</p>}
            {newCount > 0 && <div className="rounded-xl border border-border p-3 text-sm"><label className="font-bold">Drawer level for unmatched words<select value={defaultLevel} disabled={saving} onChange={(event) => setDefaultLevel(event.target.value as Level)} className="ml-3 rounded-lg border border-border bg-background px-2 py-1" data-testid="select-import-level">{(['N5', 'N4', 'N3', 'N2', 'N1'] as const).map((level) => <option key={level}>{level}</option>)}</select></label><p className="mt-2 text-xs leading-5 text-muted-foreground">Defaults to N5 as an organizing label, not an inferred JLPT level. New words keep their expression/reading with a blank meaning; add meanings later in My words if you want them in quizzes.</p></div>}
            {parsed.issues.length > 0 && <details className="rounded-xl border border-border p-3 text-sm"><summary className="cursor-pointer font-bold">View skipped row issues ({parsed.issues.length})</summary><ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">{parsed.issues.map((issue) => <li key={issue.line}>Line {issue.line}: {issue.message}</li>)}</ul></details>}
            <div><label className="text-sm font-bold">Preview<select value={previewSource} onChange={(event) => setPreviewSource(event.target.value)} className="ml-3 rounded-lg border border-border bg-background px-2 py-1"><option value="all">All matches</option><option value="original">Original matches</option><option value="existing">Existing My words</option><option value="new">New My words</option></select></label>
              <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted"><tr><th className="p-2">Expression</th><th className="p-2">Reading</th><th className="p-2">Destination</th><th className="p-2">Progress</th></tr></thead><tbody>{preview.slice(0, 25).map((item) => <tr key={item.key} className="border-t border-border"><td className="p-2">{item.expression}</td><td className="p-2">{item.reading}</td><td className="p-2 text-xs">{item.source === 'original' ? 'Reuse original' : item.source === 'existing' ? 'Reuse My words' : 'Create in My words'}</td><td className="p-2 text-xs">{progressReady ? seen.has(item.key) ? 'Seen' : 'New' : '…'}</td></tr>)}</tbody></table></div>
              <p className="mt-2 text-xs text-muted-foreground">Showing {Math.min(25, preview.length)} of {preview.length} in this preview filter. All {matches.length} unique valid words will be imported. Final matches are checked again against your latest cloud data.</p>
            </div>
          </>}
          {error && <p role="alert" className="rounded-xl bg-[hsl(var(--destructive)/.1)] p-3 text-sm text-[hsl(var(--destructive))]" data-testid="bulk-import-error">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button onClick={close} disabled={saving} className="rounded-xl border px-4 py-3 text-sm font-bold disabled:opacity-40">Cancel</button><button onClick={() => void submit()} disabled={saving || reading || !ready || slotLimitReached || !parsed?.rows.length || !name.trim()} className="inline-flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-4 py-3 text-sm font-bold text-[hsl(var(--primary-foreground))] disabled:opacity-40" data-testid="button-confirm-csv-import">{saving && <Loader2 size={15} className="animate-spin" />}{saving ? 'Saving to your account…' : `Import ${matches.length} words into new slot`}</button></div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
