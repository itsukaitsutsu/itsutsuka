import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type AdminWordsPayload } from '@/lib/api';
import { parseWordImport, MAX_IMPORT_BYTES } from '@/lib/bulkWordImport';
import { CUSTOM_LEVELS, sanitizeCustomWords, type CustomWordDraft } from '@/lib/customWords';
import { sanitizeAdminCardGroups } from '@/lib/adminCardGroups';
import { sortAdminCards, type CardSortOrder } from '@/lib/adminWordSort';
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
  const [groupFilter, setGroupFilter] = useState('all');
  const [importGroupId, setImportGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupName, setRenameGroupName] = useState('');
  const [sortOrder, setSortOrder] = useState<CardSortOrder>('asc');
  const [csv, setCsv] = useState<{ name: string; rows: ReturnType<typeof parseWordImport>['rows'] } | null>(null);
  const dragSelectValue = useRef<boolean | null>(null);
  const dragResetTimer = useRef<number | null>(null);
  const previousUserSelect = useRef('');

  const setCardSelected = (id: string, checked: boolean) => {
    setSelected(current => {
      const isSelected = current.includes(id);
      if (checked && !isSelected) return [...current, id];
      if (!checked && isSelected) return current.filter(selectedId => selectedId !== id);
      return current;
    });
  };

  useEffect(() => {
    const clearDrag = () => {
      if (dragResetTimer.current !== null) window.clearTimeout(dragResetTimer.current);
      dragResetTimer.current = null;
      if (dragSelectValue.current !== null) {
        dragSelectValue.current = null;
        document.body.style.userSelect = previousUserSelect.current;
      }
    };
    const finishAfterClick = () => {
      if (dragSelectValue.current === null) return;
      if (dragResetTimer.current !== null) window.clearTimeout(dragResetTimer.current);
      // Keep the drag state through the click event that follows mouseup, so
      // the browser's native checkbox toggle cannot undo the drag selection.
      dragResetTimer.current = window.setTimeout(clearDrag, 0);
    };
    window.addEventListener('mouseup', finishAfterClick);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('mouseup', finishAfterClick);
      window.removeEventListener('blur', clearDrag);
      clearDrag();
    };
  }, []);

  useEffect(() => { void api.wordAdminStatus().then(value => setAllowed(value.isAdmin)).catch(() => setAllowed(false)); }, []);
  const load = async (target = uid.trim()) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const data = await api.adminWords(target);
      setAccount(data); setUid(target); setSelected([]); setEditId(null); setCsv(null);
      setGroupFilter('all'); setImportGroupId(''); setNewGroupName(''); setRenameGroupName('');
    } catch (err) { setAccount(null); setError(err instanceof Error ? err.message : 'Could not load account.'); }
    finally { setBusy(false); }
  };
  const mutate = async (
    change: Parameters<typeof api.changeAdminWords>[1],
    options: {
      notice?: string;
      clearCsv?: boolean;
      onSaved?: (saved: Awaited<ReturnType<typeof api.changeAdminWords>>) => void;
    } = {},
  ) => {
    if (!account) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.changeAdminWords(account.uid, change);
      const refreshed = await api.adminWords(account.uid);
      setAccount(refreshed); setSelected([]); setEditId(null);
      if (options.clearCsv !== false) setCsv(null);
      setNotice(options.notice ?? `Saved: ${saved.created} added, ${saved.updated} updated, ${saved.deleted} deleted.`);
      options.onSaved?.(saved);
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
  const accountWords = sanitizeCustomWords(account?.customWords ?? []);
  const groups = sanitizeAdminCardGroups(account?.groups ?? []);
  const existing = new Map(accountWords.map(word => [key(word), word]));
  const matches = csv?.rows.filter(row => existing.has(key(row))).length ?? 0;
  const groupedWordIds = new Set(groups.flatMap(group => group.wordIds));
  const selectedGroup = groups.find(group => group.id === groupFilter);
  const groupWords = groupFilter === 'all'
    ? accountWords
    : groupFilter === 'ungrouped'
      ? accountWords.filter(word => !groupedWordIds.has(word.id))
      : selectedGroup
        ? accountWords.filter(word => selectedGroup.wordIds.includes(word.id))
        : [];
  const shown = groupWords.filter(word => `${word.expression} ${word.reading} ${word.meaning} ${word.partOfSpeechEn ?? ''} ${word.partOfSpeechJp ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const sortedShown = sortAdminCards(shown, sortOrder);
  const createGroup = () => {
    if (!account) return;
    const name = newGroupName.trim();
    if (!name) { setError('Enter a name for the new group.'); return; }
    void mutate({ version: account.version, groupAction: { type: 'create', name } }, {
      notice: `Created group “${name}”. Import CSV into this group to keep its cards separate.`,
      clearCsv: false,
      onSaved: saved => {
        if (saved.createdGroupId) {
          setGroupFilter(saved.createdGroupId);
          setImportGroupId(saved.createdGroupId);
          setRenameGroupName(name);
        }
        setNewGroupName('');
      },
    });
  };
  const renameGroup = () => {
    if (!account || !selectedGroup) return;
    const name = renameGroupName.trim();
    if (!name) { setError('Enter a name for the group.'); return; }
    void mutate({ version: account.version, groupAction: { type: 'rename', id: selectedGroup.id, name } }, {
      notice: `Renamed group to “${name}”.`, clearCsv: false,
    });
  };
  const deleteGroup = () => {
    if (!account || !selectedGroup) return;
    if (!window.confirm(`Delete group “${selectedGroup.name}”? Its cards will remain in My words and in any other groups. Any already-published snapshot will remain until an admin unpublishes it.`)) return;
    void mutate({ version: account.version, groupAction: { type: 'delete', id: selectedGroup.id } }, {
      notice: 'Group deleted. Its cards were kept in My words.', clearCsv: false,
      onSaved: () => { setGroupFilter('all'); setImportGroupId(''); setRenameGroupName(''); },
    });
  };
  if (allowed === null) return <main className="mx-auto max-w-5xl p-6">Checking admin access…</main>;
  if (!allowed) return <main className="mx-auto max-w-5xl p-6"><h1 className="font-serif text-3xl">Admin access required</h1><p className="mt-2">Only Firebase UIDs configured on the server can manage other users’ cards.</p><Link href="/cabinet" className="underline">Back to Cabinet</Link></main>;
  return <main className="mx-auto max-w-5xl space-y-6 p-4 pb-20 sm:p-8" data-testid="admin-words">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Administration</p><h1 className="font-serif text-3xl">Cards &amp; groups</h1><p className="mt-2 text-sm text-muted-foreground">Manage another account’s personal cards in named groups. Importing a CSV into a group keeps that batch separate from other cards and save slots; publishing that group creates a snapshot of only its cards. Existing exact matches reuse the same card and can belong to more than one group.</p><p className="mt-2 text-xs text-muted-foreground">Built-in JLPT words, history, and discovery are not changed. You need the account’s exact Firebase UID; this page does not list users.</p></header>
    <form onSubmit={event => { event.preventDefault(); void load(); }} className="flex flex-wrap gap-2"><label className="flex-1 text-sm font-bold">Target Firebase UID<input required value={uid} onChange={e => setUid(e.target.value)} placeholder="Paste the user's Firebase UID" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label><Button type="submit" disabled={busy || !uid.trim()} className="self-end">Load account</Button></form>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{notice}</p>}
    {account && <>
      <p className="text-sm">Account: <strong>{account.nickname || account.uid}</strong> · {account.customWords.length} personal cards · {groups.length} card groups · {account.lists.length} save slots · revision {account.version}</p>
      <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-card-groups">
        <div><h2 className="font-serif text-2xl">Card groups</h2><p className="mt-1 text-sm text-muted-foreground">Groups are separate from the account’s 10 personal save slots. Choose a group to manage its cards, import into it, or publish it on its own.</p></div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <form onSubmit={event => { event.preventDefault(); createGroup(); }} className="flex items-end gap-2">
            <label className="flex-1 text-sm font-semibold">Create a group<input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} maxLength={120} placeholder="e.g. SSW Manufacturing" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label>
            <Button type="submit" disabled={busy || !newGroupName.trim() || groups.length >= 100}>Create group</Button>
          </form>
          <label className="text-sm font-semibold">Show cards<select aria-label="Filter cards by group" value={groupFilter} onChange={event => {
            const id = event.target.value;
            const group = groups.find(item => item.id === id);
            setGroupFilter(id); setSelected([]); setEditId(null); setImportGroupId(group?.id ?? ''); setRenameGroupName(group?.name ?? '');
          }} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal">
            <option value="all">All cards ({accountWords.length})</option>
            <option value="ungrouped">Ungrouped ({accountWords.filter(word => !groupedWordIds.has(word.id)).length})</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name} ({group.wordIds.length})</option>)}
          </select></label>
        </div>
        {selectedGroup && <div className="flex flex-wrap items-end gap-2 rounded-xl bg-muted/50 p-3">
          <label className="min-w-[220px] flex-1 text-sm font-semibold">Rename “{selectedGroup.name}”<input value={renameGroupName} onChange={event => setRenameGroupName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label>
          <Button variant="outline" disabled={busy || !renameGroupName.trim() || renameGroupName.trim() === selectedGroup.name} onClick={renameGroup}>Rename group</Button>
          <Button variant="destructive" disabled={busy} onClick={deleteGroup}>Delete group</Button>
          <p className="basis-full text-xs text-muted-foreground">Deleting a group does not delete its cards. Any published snapshot remains until an admin unpublishes it.</p>
        </div>}
        {!groups.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Create a group before importing a CSV batch or publishing a card group.</p>}
      </section>
      <section className="space-y-3 rounded-2xl border border-border bg-card p-5"><div><h2 className="font-serif text-2xl">Bulk import CSV</h2><p className="mt-1 text-sm text-muted-foreground">Import each batch into a named group instead of appending it to an older save slot. UTF-8 columns: <code>expression,reading,part_of_speech_jp,part_of_speech_en,meaning</code>. Exact expression + reading matches reuse the personal card, update supplied values, and add it to this group; its memberships in other groups remain. Other rows create cards in this group. Built-in cards are unchanged. Max 5,000 rows / 1 MiB.</p></div>
        <label className="block max-w-xl text-sm font-semibold">Import into group<select aria-label="CSV target group" value={importGroupId} onChange={event => {
          const id = event.target.value;
          const group = groups.find(item => item.id === id);
          setImportGroupId(id); setGroupFilter(group?.id ?? 'all'); setRenameGroupName(group?.name ?? ''); setSelected([]); setEditId(null);
        }} disabled={busy || !groups.length} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal"><option value="">{groups.length ? 'Choose a group…' : 'Create a group first'}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) void readCsv(file); e.target.value = ''; }} aria-label="Import CSV" className="block w-full text-sm" />
        {csv && <><p className="text-sm font-semibold">{csv.name}: {csv.rows.length} unique rows · {matches} existing updates · {csv.rows.length - matches} additions</p>
          <div className="flex flex-wrap gap-4"><p className="text-sm text-muted-foreground">Target group: <strong>{groups.find(group => group.id === importGroupId)?.name ?? 'not selected'}</strong>. New cards matching an original expression + reading use its N1–N5 level and POS when omitted; unmatched cards use Custom.</p></div>
          {!importGroupId && <p role="alert" className="text-sm text-destructive">Choose or create a group before confirming this import.</p>}
          <Button disabled={busy || !importGroupId} onClick={() => {
            if (!window.confirm(`Import ${csv.rows.length} rows into “${groups.find(group => group.id === importGroupId)?.name ?? 'the selected group'}” for ${account.uid}? Exact matching cards may have supplied meaning or part-of-speech values updated and will be added to this group.`)) return;
            const entries = csv.rows.map(row => {
              const identity = key(row);
              const personal = existing.get(identity);
              const hasPersonalMatch = !!personal;
              const originalPos = originalPartOfSpeech.get(identity);
              // A blank CSV cell means "not supplied", not "erase the POS".
              // Preserve an existing personal value; if it's absent, recover the
              // canonical value for any matching original expression + reading.
              const partOfSpeechEn = row.partOfSpeechEn?.trim() || personal?.partOfSpeechEn?.trim() || originalPos?.partOfSpeechEn?.trim();
              const partOfSpeechJp = row.partOfSpeechJp?.trim() || personal?.partOfSpeechJp?.trim() || originalPos?.partOfSpeechJp?.trim();
              return {
                expression: row.expression,
                reading: row.reading,
                ...(row.meaning === undefined ? {} : { meaning: row.meaning }),
                ...(partOfSpeechEn ? { partOfSpeechEn } : {}),
                ...(partOfSpeechJp ? { partOfSpeechJp } : {}),
                ...(!hasPersonalMatch ? { level: (originalLevels.get(identity) ?? 'Custom') as WordLevel } : {}),
              };
            });
            void mutate({ version: account.version, entries, groupId: importGroupId });
          }}>Confirm import</Button></>}
      </section>
      <AdminPublishDecks key={account.uid} sourceUid={account.uid} sourceVersion={account.version} />
      <section className="space-y-3 rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-end justify-between gap-3"><h2 className="font-serif text-2xl">Cards{selectedGroup ? ` · ${selectedGroup.name}` : groupFilter === 'ungrouped' ? ' · Ungrouped' : ''}</h2><div className="flex flex-wrap items-end gap-3"><label className="text-sm">Sort by Japanese character count<select aria-label="Sort cards by Japanese character count" value={sortOrder} onChange={e => setSortOrder(e.target.value as CardSortOrder)} className="ml-2 rounded border bg-background p-2"><option value="asc">Shortest first</option><option value="desc">Longest first</option></select></label><label className="text-sm">Search<input value={query} onChange={e => setQuery(e.target.value)} className="ml-2 rounded border bg-background p-2" /></label></div></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { setEditId('new'); setDraft(empty); }}>Add card</Button><Button variant="outline" disabled={busy || !shown.length} onClick={() => setSelected(prev => [...new Set([...prev, ...shown.slice(0, 500).map(word => word.id)])])}>Select visible ({Math.min(shown.length, 500)})</Button><Button variant="outline" disabled={busy || !selected.length} onClick={() => setSelected([])}>Clear selection</Button><Button variant="destructive" disabled={busy || !selected.length} onClick={() => { if (window.confirm(`Permanently delete ${selected.length} personal card(s) from ${account.uid} and remove them from all save slots and groups?`)) void mutate({ version: account.version, deleteIds: selected }); }}>Delete selected ({selected.length})</Button></div>
        <p className="text-xs text-muted-foreground">Tip: Hold the left mouse button on a checkbox and drag across rows to select or deselect multiple cards.</p>
        {editId && <form onSubmit={e => {
          e.preventDefault();
          if (!draft.expression.trim() || !draft.reading.trim()) { setError('Expression and reading are required.'); return; }
          void mutate({ version: account.version, entries: [{ ...(editId === 'new' ? {} : { id: editId }), ...draft }], ...(editId === 'new' && selectedGroup ? { groupId: selectedGroup.id } : {}) });
        }} className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
          <h3 className="sm:col-span-2 font-bold">{editId === 'new' ? `New card${selectedGroup ? ` in ${selectedGroup.name}` : ''}` : 'Edit card'}</h3>
          {(['expression', 'reading', 'meaning'] as const).map(field => <label key={field} className="text-sm capitalize">{field}<input required={field !== 'meaning'} maxLength={field === 'meaning' ? 500 : 200} value={draft[field]} onChange={e => setDraft(prev => ({ ...prev, [field]: e.target.value }))} className="mt-1 w-full rounded border bg-background p-2" /></label>)}
          <label className="text-sm">Part of speech (English)<select value={draft.partOfSpeechEn ?? 'Other'} onChange={e => setDraft(prev => ({ ...prev, partOfSpeechEn: e.target.value as PartOfSpeechKey }))} className="mt-1 w-full rounded border bg-background p-2">{PART_OF_SPEECH_OPTIONS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          <label className="text-sm">Part of speech (Japanese)<input maxLength={80} lang="ja" value={draft.partOfSpeechJp ?? ''} onChange={e => setDraft(prev => ({ ...prev, partOfSpeechJp: e.target.value }))} placeholder="e.g. 名詞" className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="text-sm">Level<select value={draft.level} onChange={e => setDraft(prev => ({ ...prev, level: e.target.value as WordLevel }))} className="mt-1 w-full rounded border bg-background p-2">{CUSTOM_LEVELS.map(level => <option key={level}>{level}</option>)}</select></label>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={busy}>Save card</Button><Button type="button" variant="outline" onClick={() => setEditId(null)}>Cancel</Button></div>
        </form>}
        {!shown.length && <p role="status" className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">No cards match this group and search.</p>}
        <div className="max-h-[620px] overflow-auto rounded-xl border border-border"><table className="w-full min-w-[720px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-3">Select</th><th>Expression / reading</th><th>Part of speech</th><th>Meaning</th><th>Level</th><th>Action</th></tr></thead><tbody>{sortedShown.slice(0, 500).map(word => <tr key={word.id} className="border-t border-border" onMouseEnter={() => {
  if (dragSelectValue.current !== null) setCardSelected(word.id, dragSelectValue.current);
}}><td className="p-3"><input
  type="checkbox"
  checked={selected.includes(word.id)}
  onMouseDown={event => {
    if (event.button !== 0) return;
    if (dragResetTimer.current !== null) window.clearTimeout(dragResetTimer.current);
    dragResetTimer.current = null;
    const checked = !selected.includes(word.id);
    dragSelectValue.current = checked;
    previousUserSelect.current = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    setCardSelected(word.id, checked);
  }}
  onClick={event => {
    const checked = dragSelectValue.current;
    if (checked === null) return;
    event.preventDefault();
    setCardSelected(word.id, checked);
  }}
  onChange={event => {
    setCardSelected(word.id, dragSelectValue.current ?? event.currentTarget.checked);
  }}
  aria-label={`Select ${word.expression}`}
/></td><td><strong>{word.expression}</strong><br /><span className="text-muted-foreground">{word.reading}</span></td><td><PartOfSpeechBadge partOfSpeechEn={word.partOfSpeechEn} partOfSpeechJp={word.partOfSpeechJp} /></td><td>{word.meaning || '—'}</td><td>{word.level}</td><td><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditId(word.id); setDraft({ expression: word.expression, reading: word.reading, meaning: word.meaning, level: word.level, partOfSpeechEn: word.partOfSpeechEn ?? 'Other', partOfSpeechJp: word.partOfSpeechJp ?? 'Other' }); }}>Edit</Button></td></tr>)}</tbody></table></div>{shown.length > 500 && <p className="text-sm text-muted-foreground">Showing first 500 matching cards. Narrow your search to reach others.</p>}
      </section>
    </>}
  </main>;
}
