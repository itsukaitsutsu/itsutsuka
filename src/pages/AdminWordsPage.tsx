import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type AdminWordsPayload } from '@/lib/api';
import { parseWordImport, MAX_IMPORT_BYTES } from '@/lib/bulkWordImport';
import { CUSTOM_LEVELS, type CustomWordDraft } from '@/lib/customWords';
import { PART_OF_SPEECH_OPTIONS, vocabulary, type PartOfSpeechKey, type WordLevel } from '@/lib/vocabulary';
import { PartOfSpeechBadge } from '@/components/PartOfSpeech';
import { Button } from '@/components/ui/button';
import { AdminPublishDecks } from '@/components/AdminPublishDecks';

const key = (word: { expression: string; reading: string }) => `${word.expression.normalize('NFKC').trim()}\u0000${word.reading.normalize('NFKC').trim()}`;
const originalLevels = new Map(vocabulary.map(word => [key(word), word.level]));
const originalPartOfSpeech = new Map(vocabulary.map(word => [key(word), { partOfSpeechEn: word.partOfSpeechEn, partOfSpeechJp: word.partOfSpeechJp }]));
const empty: CustomWordDraft = { expression: '', reading: '', meaning: '', level: 'Custom', partOfSpeechEn: 'Other', partOfSpeechJp: 'Other' };

export default function AdminWordsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [uid, setUid] = useState('');
  const [account, setAccount] = useState<AdminWordsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomWordDraft>(empty);
  const [query, setQuery] = useState('');
  const [csv, setCsv] = useState<{ name: string; rows: ReturnType<typeof parseWordImport>['rows'] } | null>(null);
  const [slotId, setSlotId] = useState('');

  useEffect(() => { void api.wordAdminStatus().then(value => setAllowed(value.isAdmin)).catch(() => setAllowed(false)); }, []);
  const load = async (target = uid.trim()) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const data = await api.adminWords(target);
      setAccount(data); setUid(target); setSelected([]); setEditId(null); setCsv(null); setSlotId('');
    } catch (err) { setAccount(null); setError(err instanceof Error ? err.message : 'Could not load account.'); }
    finally { setBusy(false); }
  };
  const mutate = async (change: Parameters<typeof api.changeAdminWords>[1]) => {
    if (!account) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.changeAdminWords(account.uid, change);
      const refreshed = await api.adminWords(account.uid);
      setAccount(refreshed); setSelected([]); setEditId(null); setCsv(null);
      setNotice(`Saved: ${saved.created} added, ${saved.updated} updated, ${saved.deleted} deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      if (err instanceof ApiError && err.isStale) {
        setAccount(null); setSelected([]); setCsv(null);
        setNotice('Reload this account before making any more changes.');
      }
    } finally { setBusy(false); }
  };
  const readCsv = async (file: File) => {
    setCsv(null); setError('');
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('CSV must be at most 1 MiB.');
      const parsed = parseWordImport(await file.text());
      if (parsed.issues.length) throw new Error(`${parsed.issues.length} invalid row(s); fix them before importing. First: line ${parsed.issues[0].line}: ${parsed.issues[0].message}`);
      if (!parsed.rows.length) throw new Error('No valid cards in CSV.');
      if (parsed.duplicates) throw new Error(`${parsed.duplicates} duplicate row(s). Remove duplicates before importing.`);
      setCsv({ name: file.name, rows: parsed.rows });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not read CSV.'); }
  };
  const existing = new Map(account?.customWords.map(word => [key(word), word]) ?? []);
  const matches = csv?.rows.filter(row => existing.has(key(row))).length ?? 0;
  const shown = (account?.customWords ?? []).filter(word => `${word.expression} ${word.reading} ${word.meaning} ${word.partOfSpeechEn ?? ''} ${word.partOfSpeechJp ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  if (allowed === null) return <main className="mx-auto max-w-5xl p-6">Checking admin access…</main>;
  if (!allowed) return <main className="mx-auto max-w-5xl p-6"><h1 className="font-serif text-3xl">Admin access required</h1><p className="mt-2">Only Firebase UIDs configured on the server can manage other users’ cards.</p><Link href="/cabinet" className="underline">Back to Cabinet</Link></main>;
  return <main className="mx-auto max-w-5xl space-y-6 p-4 pb-20 sm:p-8" data-testid="admin-words">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Administration</p><h1 className="font-serif text-3xl">Personal card manager</h1><p className="mt-2 text-sm text-muted-foreground">Edit another account’s My words. Built-in JLPT words, history, and discovery are not changed. You need the account’s exact Firebase UID; this page does not list users.</p></header>
    <form onSubmit={event => { event.preventDefault(); void load(); }} className="flex flex-wrap gap-2"><label className="flex-1 text-sm font-bold">Target Firebase UID<input required value={uid} onChange={e => setUid(e.target.value)} placeholder="Paste the user's Firebase UID" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label><Button type="submit" disabled={busy || !uid.trim()} className="self-end">Load account</Button></form>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{notice}</p>}
    {account && <>
      <p className="text-sm">Account: <strong>{account.nickname || account.uid}</strong> · {account.customWords.length} personal cards · {account.lists.length} save slots · revision {account.version}</p>
      <AdminPublishDecks key={account.uid} sourceUid={account.uid} sourceVersion={account.version} />
      <section className="space-y-3 rounded-xl border border-border p-4"><h2 className="font-serif text-xl">Import or update from CSV</h2><p className="text-sm text-muted-foreground">UTF-8 CSV: <code>expression,reading,part_of_speech_jp,part_of_speech_en,meaning</code>. Part-of-speech columns are optional and sync onto personal cards. Exact expression + reading updates any supplied meaning/POS values; other rows add cards. Existing personal cards keep their levels; new cards matching an original use its N1–N5 level and POS when omitted, while unmatched cards use Custom. This does not change built-in cards. Max 5,000 rows / 1 MiB. Review before committing.</p>
        <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) void readCsv(file); e.target.value = ''; }} aria-label="Import CSV" className="block w-full text-sm" />
        {csv && <><p className="text-sm font-semibold">{csv.name}: {csv.rows.length} unique rows · {matches} existing updates · {csv.rows.length - matches} additions</p>
          <div className="flex flex-wrap gap-4"><p className="text-sm text-muted-foreground">New cards matching original expression + reading use their original N1–N5 level; unmatched cards use Custom.</p><label className="text-sm">Add imported cards to save slot (optional) <select value={slotId} onChange={e => setSlotId(e.target.value)} className="ml-2 rounded border bg-background p-2"><option value="">None</option>{account.lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label></div>
          <Button disabled={busy} onClick={() => {
            if (!window.confirm(`Import ${csv.rows.length} rows for ${account.uid}? Matching personal cards may have supplied meaning or part-of-speech values updated.`)) return;
            const entries = csv.rows.map(row => {
              const identity = key(row);
              const hasPersonalMatch = existing.has(identity);
              const originalPos = originalPartOfSpeech.get(identity);
              return {
                expression: row.expression,
                reading: row.reading,
                ...(row.meaning === undefined ? {} : { meaning: row.meaning }),
                ...(row.partOfSpeechEn !== undefined ? { partOfSpeechEn: row.partOfSpeechEn } : !hasPersonalMatch && originalPos?.partOfSpeechEn ? { partOfSpeechEn: originalPos.partOfSpeechEn } : {}),
                ...(row.partOfSpeechJp !== undefined ? { partOfSpeechJp: row.partOfSpeechJp } : !hasPersonalMatch && originalPos?.partOfSpeechJp ? { partOfSpeechJp: originalPos.partOfSpeechJp } : {}),
                ...(!hasPersonalMatch ? { level: (originalLevels.get(identity) ?? 'Custom') as WordLevel } : {}),
              };
            });
            void mutate({ version: account.version, entries, ...(slotId ? { listId: slotId } : {}) });
          }}>Confirm import</Button></>}
      </section>
      <section className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-3"><h2 className="font-serif text-xl">Cards</h2><label className="text-sm">Search<input value={query} onChange={e => setQuery(e.target.value)} className="ml-2 rounded border bg-background p-2" /></label></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { setEditId('new'); setDraft(empty); }}>Add card</Button><Button variant="outline" disabled={busy || !shown.length} onClick={() => setSelected(prev => [...new Set([...prev, ...shown.slice(0, 500).map(word => word.id)])])}>Select visible ({Math.min(shown.length, 500)})</Button><Button variant="outline" disabled={busy || !selected.length} onClick={() => setSelected([])}>Clear selection</Button><Button variant="destructive" disabled={busy || !selected.length} onClick={() => { if (window.confirm(`Permanently delete ${selected.length} personal card(s) from ${account.uid} and remove them from saved lists?`)) void mutate({ version: account.version, deleteIds: selected }); }}>Delete selected ({selected.length})</Button></div>
        {editId && <form onSubmit={e => {
          e.preventDefault();
          if (!draft.expression.trim() || !draft.reading.trim()) { setError('Expression and reading are required.'); return; }
          void mutate({ version: account.version, entries: [{ ...(editId === 'new' ? {} : { id: editId }), ...draft }] });
        }} className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
          <h3 className="sm:col-span-2 font-bold">{editId === 'new' ? 'New card' : 'Edit card'}</h3>
          {(['expression', 'reading', 'meaning'] as const).map(field => <label key={field} className="text-sm capitalize">{field}<input required={field !== 'meaning'} maxLength={field === 'meaning' ? 500 : 200} value={draft[field]} onChange={e => setDraft(prev => ({ ...prev, [field]: e.target.value }))} className="mt-1 w-full rounded border bg-background p-2" /></label>)}
          <label className="text-sm">Part of speech (English)<select value={draft.partOfSpeechEn ?? 'Other'} onChange={e => setDraft(prev => ({ ...prev, partOfSpeechEn: e.target.value as PartOfSpeechKey }))} className="mt-1 w-full rounded border bg-background p-2">{PART_OF_SPEECH_OPTIONS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          <label className="text-sm">Part of speech (Japanese)<input maxLength={80} lang="ja" value={draft.partOfSpeechJp ?? ''} onChange={e => setDraft(prev => ({ ...prev, partOfSpeechJp: e.target.value }))} placeholder="e.g. 名詞" className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="text-sm">Level<select value={draft.level} onChange={e => setDraft(prev => ({ ...prev, level: e.target.value as WordLevel }))} className="mt-1 w-full rounded border bg-background p-2">{CUSTOM_LEVELS.map(level => <option key={level}>{level}</option>)}</select></label>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={busy}>Save card</Button><Button type="button" variant="outline" onClick={() => setEditId(null)}>Cancel</Button></div>
        </form>}
        <div className="max-h-[620px] overflow-auto rounded-xl border border-border"><table className="w-full min-w-[720px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-3">Select</th><th>Expression / reading</th><th>Part of speech</th><th>Meaning</th><th>Level</th><th>Action</th></tr></thead><tbody>{shown.slice(0, 500).map(word => <tr key={word.id} className="border-t border-border"><td className="p-3"><input type="checkbox" checked={selected.includes(word.id)} onChange={e => setSelected(prev => e.target.checked ? [...prev, word.id] : prev.filter(id => id !== word.id))} aria-label={`Select ${word.expression}`} /></td><td><strong>{word.expression}</strong><br /><span className="text-muted-foreground">{word.reading}</span></td><td><PartOfSpeechBadge partOfSpeechEn={word.partOfSpeechEn} partOfSpeechJp={word.partOfSpeechJp} /></td><td>{word.meaning || '—'}</td><td>{word.level}</td><td><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditId(word.id); setDraft({ expression: word.expression, reading: word.reading, meaning: word.meaning, level: word.level, partOfSpeechEn: word.partOfSpeechEn ?? 'Other', partOfSpeechJp: word.partOfSpeechJp ?? 'Other' }); }}>Edit</Button></td></tr>)}</tbody></table></div>{shown.length > 500 && <p className="text-sm text-muted-foreground">Showing first 500 matching cards. Narrow your search to reach others.</p>}
      </section>
    </>}
  </main>;
}
