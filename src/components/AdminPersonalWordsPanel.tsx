import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AdminContentGroup, type AdminWordsPayload } from '@/lib/api';
import { CUSTOM_LEVELS, sanitizeCustomWords, type CustomWordDraft } from '@/lib/customWords';
import { sanitizeAdminCardGroups } from '@/lib/adminCardGroups';
import { sanitizeLists } from '@/lib/wordLists';
import { sortAdminCards, type CardSortOrder } from '@/lib/adminWordSort';
import { PART_OF_SPEECH_OPTIONS, vocabulary, type PartOfSpeechKey, type WordLevel } from '@/lib/vocabulary';
import { PartOfSpeechBadge } from '@/components/PartOfSpeech';
import { Button } from '@/components/ui/button';
import { AdminPublishDecks } from '@/components/AdminPublishDecks';

const key = (word: { expression: string; reading: string }) => `${word.expression.normalize('NFKC').trim()}\u0000${word.reading.normalize('NFKC').trim()}`;
const originalLevels = new Map(vocabulary.map(word => [key(word), word.level]));
const originalPartOfSpeech = new Map(vocabulary.map(word => [key(word), { partOfSpeechEn: word.partOfSpeechEn, partOfSpeechJp: word.partOfSpeechJp }]));
const empty: CustomWordDraft = { expression: '', reading: '', meaning: '', level: 'Custom', partOfSpeechEn: 'Other', partOfSpeechJp: 'Other' };

export function AdminPersonalWordsPanel({ onContentChanged }: { onContentChanged?: () => void }) {
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
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroupName, setRenameGroupName] = useState('');
  const [sortOrder, setSortOrder] = useState<CardSortOrder>('asc');
  const [copyPanelOpen, setCopyPanelOpen] = useState(false);
  const [copySource, setCopySource] = useState('my_words');
  const [copySelectedIds, setCopySelectedIds] = useState<string[]>([]);
  const [copyQuery, setCopyQuery] = useState('');
  const [copyName, setCopyName] = useState('');
  const [copyGroupId, setCopyGroupId] = useState('');
  const [copyGroups, setCopyGroups] = useState<AdminContentGroup[]>([]);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
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

  const load = async (target = uid.trim()) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      const data = await api.adminWords(target);
      setAccount(data); setUid(target); setSelected([]); setEditId(null);
      setGroupFilter('all'); setNewGroupName(''); setRenameGroupName('');
    } catch (err) { setAccount(null); setError(err instanceof Error ? err.message : 'Could not load account.'); }
    finally { setBusy(false); }
  };
  const mutate = async (
    change: Parameters<typeof api.changeAdminWords>[1],
    options: {
      notice?: string;
      onSaved?: (saved: Awaited<ReturnType<typeof api.changeAdminWords>>) => void;
    } = {},
  ) => {
    if (!account) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.changeAdminWords(account.uid, change);
      const refreshed = await api.adminWords(account.uid);
      setAccount(refreshed); setSelected([]); setEditId(null);
      setNotice(options.notice ?? `Saved: ${saved.created} added, ${saved.updated} updated, ${saved.deleted} deleted.`);
      options.onSaved?.(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      if (err instanceof ApiError && err.isStale) {
        setAccount(null); setSelected([]);
        setNotice('Reload this account before making any more changes.');
      }
    } finally { setBusy(false); }
  };
  const accountWords = sanitizeCustomWords(account?.customWords ?? []);
  const groups = sanitizeAdminCardGroups(account?.groups ?? []);
  const lists = sanitizeLists(account?.lists ?? []);
  const personalCardIndex = new Map(accountWords.map(card => [card.id, card]));
  const catalogueCardIndex = new Map(vocabulary.map(card => [card.id, card]));
  const copySourceSeparator = copySource.indexOf(':');
  const copySourceKindValue = copySourceSeparator < 0 ? 'my_words' : copySource.slice(0, copySourceSeparator);
  const copySourceKind = copySourceKindValue === 'list' || copySourceKindValue === 'group' ? copySourceKindValue : 'my_words';
  const copySourceId = copySourceSeparator < 0 ? null : copySource.slice(copySourceSeparator + 1);
  const copySourceRecord = copySourceKind === 'list' ? lists.find(list => list.id === copySourceId)
    : copySourceKind === 'group' ? groups.find(group => group.id === copySourceId) : null;
  const copySourceName = copySourceKind === 'my_words' ? 'My words' : copySourceRecord?.name ?? 'Selected source';
  const copySourceIds = copySourceKind === 'my_words' ? accountWords.map(card => card.id) : copySourceRecord?.wordIds ?? [];
  const copySourceCards = [...new Set(copySourceIds)].flatMap(id => {
    const card = personalCardIndex.get(id) ?? catalogueCardIndex.get(id);
    return card ? [{ id: card.id, expression: card.expression, reading: card.reading, meaning: card.meaning,
      level: card.level, partOfSpeechEn: card.partOfSpeechEn, partOfSpeechJp: card.partOfSpeechJp }] : [];
  });
  const copyVisibleCards = copySourceCards.filter(card => `${card.expression} ${card.reading} ${card.meaning} ${card.partOfSpeechEn ?? ''} ${card.partOfSpeechJp ?? ''}`.toLowerCase().includes(copyQuery.toLowerCase()));
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
      notice: `Created personal-card group “${name}”.`,
      onSaved: saved => {
        if (saved.createdGroupId) {
          setGroupFilter(saved.createdGroupId);
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
      notice: `Renamed personal-card group to “${name}”.`,
    });
  };
  const deleteGroup = () => {
    if (!account || !selectedGroup) return;
    if (!window.confirm(`Delete group “${selectedGroup.name}”? Its cards will remain in My words and in any other groups. Any already-published snapshot will remain until an admin unpublishes it.`)) return;
    void mutate({ version: account.version, groupAction: { type: 'delete', id: selectedGroup.id } }, {
      notice: 'Personal-card group deleted. Its cards were kept in My words.',
      onSaved: () => { setGroupFilter('all'); setRenameGroupName(''); },
    });
  };
  const sourceIdsFor = (value: string) => {
    if (!account || value === 'my_words') return accountWords.map(card => card.id);
    const split = value.indexOf(':');
    const kind = value.slice(0, split), id = value.slice(split + 1);
    return kind === 'list' ? lists.find(list => list.id === id)?.wordIds ?? []
      : kind === 'group' ? groups.find(group => group.id === id)?.wordIds ?? [] : [];
  };
  const sourceNameFor = (value: string) => {
    if (!account || value === 'my_words') return 'My words';
    const split = value.indexOf(':'), kind = value.slice(0, split), id = value.slice(split + 1);
    return kind === 'list' ? lists.find(list => list.id === id)?.name ?? 'Personal save slot'
      : kind === 'group' ? groups.find(group => group.id === id)?.name ?? 'Personal group' : 'My words';
  };
  const openCopyPanel = async () => {
    if (!account) return;
    setCopyBusy(true); setCopyError(''); setCopyNotice('');
    try {
      const content = await api.adminContent();
      setCopyGroups(content.groups); setCopyGroupId(''); setCopySource('my_words');
      setCopySelectedIds(accountWords.map(card => card.id)); setCopyQuery('');
      setCopyName(`${account.nickname || account.uid} — My words`.slice(0, 120));
      setCopyPanelOpen(true);
    } catch (err) { setCopyError(err instanceof Error ? err.message : 'Could not open the copy panel.'); }
    finally { setCopyBusy(false); }
  };
  const copySelectedToAdmin = async () => {
    if (!account || !copySelectedIds.length) { setCopyError('Select at least one personal card to copy.'); return; }
    if (!copyName.trim()) { setCopyError('Enter a name for the new admin batch.'); return; }
    setCopyBusy(true); setCopyError(''); setCopyNotice('');
    try {
      const sourceAll = copySelectedIds.length === copySourceCards.length;
      const result = await api.copyPersonalContent({
        sourceUid: account.uid,
        sourceKind: copySourceKind,
        sourceId: copySourceId,
        sourceAll,
        selectedSourceIds: sourceAll ? [] : copySelectedIds,
        name: copyName.trim(),
        groupId: copyGroupId || null,
      });
      setCopyNotice(`Copied ${result.batch.cardCount} cards into admin batch “${result.batch.name}”. The personal account was not changed.`);
      setCopyPanelOpen(false); setCopySelectedIds([]); onContentChanged?.();
    } catch (err) { setCopyError(err instanceof Error ? err.message : 'Could not copy personal cards.'); }
    finally { setCopyBusy(false); }
  };
  return <section className="space-y-6" data-testid="admin-personal-words">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Personal account tools</p><h2 className="font-serif text-3xl">Manage personal cards</h2><p className="mt-2 text-sm text-muted-foreground">This panel reads or edits the selected account’s personal cards. CSV batches belong to the separate Admin content tab; copying cards from here creates a separate admin-owned batch and never changes this account.</p><p className="mt-2 text-xs text-muted-foreground">Built-in JLPT words, history, and discovery are not changed. Enter the exact Firebase UID; this page does not list users.</p></header>
    <form onSubmit={event => { event.preventDefault(); void load(); }} className="flex flex-wrap gap-2"><label className="flex-1 text-sm font-bold">Target Firebase UID<input required value={uid} onChange={e => setUid(e.target.value)} placeholder="Paste the user's Firebase UID" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label><Button type="submit" disabled={busy || !uid.trim()} className="self-end">Load account</Button></form>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{notice}</p>}
    {account && <>
      <p className="text-sm">Account: <strong>{account.nickname || account.uid}</strong> · {account.customWords.length} personal cards · {groups.length} card groups · {account.lists.length} save slots · revision {account.version}</p>
      <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-card-groups">
        <div><h3 className="font-serif text-2xl">Personal-card groups</h3><p className="mt-1 text-sm text-muted-foreground">These groups belong only to this account’s personal cards. They are a source for copying selected content into an admin-owned batch; the copy is managed separately in the Admin content tab.</p></div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <form onSubmit={event => { event.preventDefault(); createGroup(); }} className="flex items-end gap-2">
            <label className="flex-1 text-sm font-semibold">Create a group<input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} maxLength={120} placeholder="e.g. SSW Manufacturing" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-normal" /></label>
            <Button type="submit" disabled={busy || !newGroupName.trim() || groups.length >= 100}>Create group</Button>
          </form>
          <label className="text-sm font-semibold">Show cards<select aria-label="Filter cards by group" value={groupFilter} onChange={event => {
            const id = event.target.value;
            const group = groups.find(item => item.id === id);
            setGroupFilter(id); setSelected([]); setEditId(null); setRenameGroupName(group?.name ?? '');
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
        {!groups.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Create a personal-card group if this account’s cards need organizing or copying as a collection.</p>}
      </section>
      <section className="space-y-3 rounded-2xl border border-border bg-card p-5" data-testid="copy-personal-to-admin-content">
        <div><h3 className="font-serif text-2xl">Copy personal cards to Admin content</h3><p className="mt-1 text-sm text-muted-foreground">Choose My words, a personal save slot, or a personal group. The selected content is copied into a separate admin batch; later changes in this account do not change that batch until you synchronize it from the Admin content tab.</p></div>
        {copyNotice && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{copyNotice}</p>}
        {copyError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{copyError}</p>}
        {!copyPanelOpen && <Button variant="outline" disabled={!account || copyBusy} onClick={() => void openCopyPanel()}>{copyBusy ? 'Loading sources…' : 'Choose personal content to copy'}</Button>}
        {copyPanelOpen && <div className="space-y-3 rounded-xl border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold">Personal source<select value={copySource} disabled={copyBusy} onChange={event => {
              const value = event.target.value;
              const ids = sourceIdsFor(value);
              setCopySource(value); setCopySelectedIds(ids); setCopyQuery('');
              setCopyName(`${account.nickname || account.uid} — ${sourceNameFor(value)}`.slice(0, 120));
              setCopyError('');
            }} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal">
              <option value="my_words">My words ({accountWords.length})</option>
              <optgroup label="Personal save slots">{lists.map(list => <option key={list.id} value={`list:${list.id}`}>{list.name} ({list.wordIds.length})</option>)}</optgroup>
              <optgroup label="Personal groups">{groups.map(group => <option key={group.id} value={`group:${group.id}`}>{group.name} ({group.wordIds.length})</option>)}</optgroup>
            </select></label>
            <label className="text-sm font-semibold">Add copied batch to admin group<select value={copyGroupId} disabled={copyBusy} onChange={event => setCopyGroupId(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="">No group yet — assign later</option>{copyGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <label className="text-sm font-semibold sm:col-span-2">Admin batch name<input value={copyName} onChange={event => setCopyName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label>
          </div>
          <div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm text-muted-foreground">{copySelectedIds.length} selected · {copySourceCards.length} source cards</span><label className="text-sm">Search<input value={copyQuery} onChange={event => setCopyQuery(event.target.value)} className="ml-2 rounded border bg-background p-2" /></label><Button size="sm" variant="outline" disabled={copyBusy || !copyVisibleCards.length} onClick={() => setCopySelectedIds(current => [...new Set([...current, ...copyVisibleCards.map(card => card.id)])])}>Select visible</Button><Button size="sm" variant="outline" disabled={copyBusy || !copySourceCards.length} onClick={() => setCopySelectedIds(copySourceCards.map(card => card.id))}>Select all</Button><Button size="sm" variant="outline" disabled={copyBusy || !copySelectedIds.length} onClick={() => setCopySelectedIds([])}>Clear</Button></div>
          {!copySourceCards.length && <p role="status" className="rounded-lg bg-muted p-3 text-sm">This personal source contains no cards available to copy.</p>}
          {!!copySourceCards.length && <div className="max-h-72 overflow-auto rounded-lg border"><table className="w-full min-w-[560px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">Select</th><th>Expression / reading</th><th>Meaning</th><th>Level</th></tr></thead><tbody>{copyVisibleCards.slice(0, 500).map(card => <tr key={card.id} className="border-t"><td className="p-2"><input type="checkbox" aria-label={`Copy ${card.expression}`} checked={copySelectedIds.includes(card.id)} onChange={event => setCopySelectedIds(current => event.target.checked ? [...new Set([...current, card.id])] : current.filter(id => id !== card.id))} /></td><td><strong>{card.expression}</strong><br /><span className="text-muted-foreground">{card.reading}</span></td><td>{card.meaning || '—'}</td><td>{card.level}</td></tr>)}</tbody></table>{copyVisibleCards.length > 500 && <p className="p-2 text-xs text-muted-foreground">Showing 500 matches; use Search to narrow the list.</p>}</div>}
          {copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}
          <div className="flex flex-wrap gap-2"><Button disabled={copyBusy || !copySelectedIds.length || !copyName.trim()} onClick={() => void copySelectedToAdmin()}>{copyBusy ? 'Copying…' : `Copy ${copySelectedIds.length} card(s) to Admin content`}</Button><Button type="button" variant="outline" disabled={copyBusy} onClick={() => { setCopyPanelOpen(false); setCopyError(''); }}>Cancel</Button></div>
        </div>}
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
  </section>;
}
