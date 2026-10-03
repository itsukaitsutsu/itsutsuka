import { useEffect, useState } from 'react';
import { api, type AdminSharedDeck, type DeckAudience } from '@/lib/api';
import { Button } from '@/components/ui/button';

type SourceList = { id: string; name: string; cardCount: number; isGroup: boolean };
const uidsFrom = (text: string) => [...new Set(text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];

/** A saved list belongs to the source account; a publication grants read-only access. */
export function AdminPublishDecks({ sourceUid, sourceVersion }: { sourceUid: string; sourceVersion: number }) {
  const [lists, setLists] = useState<SourceList[]>([]);
  const [published, setPublished] = useState<AdminSharedDeck[]>([]);
  const [listId, setListId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [visibility, setVisibility] = useState<DeckAudience['visibility']>('selected');
  const [recipientText, setRecipientText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setListId(''); setEditingId(''); setPublished([]); setLists([]); setNotice(''); setError(''); setLoading(true);
    void Promise.all([api.adminDeckSources(sourceUid), api.adminSharedDecks(sourceUid)])
      .then(([sources, shared]) => { if (active) {
        const options: SourceList[] = [
          ...(sources.groups ?? []).map(group => ({ ...group, isGroup: true })),
          ...sources.lists.map(list => ({ ...list, isGroup: false })),
        ];
        const first = options[0]?.id ?? '';
        const current = shared.decks.find(deck => deck.sourceListId === first);
        setLists(options); setPublished(shared.decks); setListId(first);
        setEditingId(current?.id ?? ''); setVisibility(current?.visibility ?? 'selected');
        setRecipientText(current?.recipientUids.join('\n') ?? '');
      } })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Could not load saved lists.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sourceUid, sourceVersion]);
  const choose = (id: string) => {
    setListId(id); setError(''); setNotice('');
    const existing = published.find(item => item.sourceListId === id);
    setEditingId(existing?.id ?? ''); setVisibility(existing?.visibility ?? 'selected');
    setRecipientText(existing?.recipientUids.join('\n') ?? '');
  };
  const reload = async () => setPublished((await api.adminSharedDecks(sourceUid)).decks);
  const save = async () => {
    if (!listId) { setError('Choose a saved list or card group.'); return; }
    const recipientUids = visibility === 'selected' ? uidsFrom(recipientText) : [];
    if (visibility === 'selected' && !recipientUids.length) { setError('Enter at least one recipient Firebase UID.'); return; }
    const audience = { visibility, recipientUids };
    if (!window.confirm(`${editingId ? 'Change access to' : 'Publish'} “${lists.find(item => item.id === listId)?.name ?? 'this deck'}” ${visibility === 'public' ? 'for EVERY signed-in user' : `for ${recipientUids.length} selected user(s)`}? This exposes its words and meanings.`)) return;
    setError(''); setNotice(''); setSaving(true);
    try {
      if (editingId) await api.updatePublishedDeck(editingId, audience);
      else { const created = await api.publishDeck({ sourceUid, listId, ...audience }); setEditingId(created.id); }
      await reload();
      setNotice(editingId ? 'Audience updated. Access changes immediately.' : 'Deck published as an independent copy. Recipients can find its cards in Cabinet and practice modes; editing or deleting the original group or save slot will not affect it.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save publication.'); }
    finally { setSaving(false); }
  };
  const unpublish = async (deck: AdminSharedDeck) => {
    if (!window.confirm(`Remove the published copy of “${deck.name}” for everyone? The original group or saved list will remain unchanged.`)) return;
    setError(''); setNotice(''); setSaving(true);
    try {
      await api.unpublishDeck(deck.id);
      await reload();
      if (editingId === deck.id) { setEditingId(''); setVisibility('selected'); setRecipientText(''); }
      setNotice('Deck unpublished. Recipients can no longer open it.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not unpublish deck.'); }
    finally { setSaving(false); }
  };
  return <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-publish-decks">
    <div><p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Read-only sharing</p><h2 className="font-serif text-2xl">Publish a card group or saved deck</h2><p className="mt-2 text-sm text-muted-foreground">Choose a named card group or saved slot. A group publication contains only cards assigned to that group. Publishing creates a separate copy as an immutable snapshot: later edits or deletion of its source will not change or remove it. Only an admin can remove the publication, and published decks do not use personal save slots.</p></div>
    <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">Check the list before sharing: publishing makes its private words and meanings visible to the audience you choose.</p>
    {loading && <p role="status" className="text-sm">Loading saved lists…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!loading && !lists.length && <p className="text-sm text-muted-foreground">This user has no non-empty card groups or saved lists to publish.</p>}
    {!!lists.length && <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-bold">Source group or saved list<select aria-label="Source group or saved list" value={listId} onChange={e => choose(e.target.value)} disabled={saving} className="mt-2 block w-full rounded-xl border bg-background p-2 font-normal">{lists.map(list => <option key={list.id} value={list.id}>{list.isGroup ? 'Group' : 'Saved list'} · {list.name} · {list.cardCount} cards</option>)}</select></label>
      <label className="text-sm font-bold">Who can see it?<select value={visibility} onChange={e => setVisibility(e.target.value as DeckAudience['visibility'])} disabled={saving} className="mt-2 block w-full rounded-xl border bg-background p-2 font-normal"><option value="selected">Selected users only</option><option value="public">Everyone signed in</option></select></label>
      {visibility === 'selected' && <label className="text-sm font-bold sm:col-span-2">Recipient Firebase UIDs<textarea value={recipientText} onChange={e => setRecipientText(e.target.value)} rows={3} maxLength={14000} placeholder="One Firebase UID per line (or separate with commas)" disabled={saving} className="mt-2 block w-full rounded-xl border bg-background p-3 font-normal" /><span className="text-xs font-normal text-muted-foreground">Up to 100 users. This is the recipient’s UID, not their email.</span></label>}
      <div className="sm:col-span-2"><Button onClick={() => void save()} disabled={saving || !listId}>{saving ? 'Saving…' : editingId ? 'Update access' : 'Publish deck'}</Button></div>
    </div>}
    {!!published.length && <div className="border-t pt-4"><h3 className="text-sm font-bold">Currently published from this account</h3><div className="mt-2 space-y-2">{published.map(deck => <div key={deck.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm"><span><strong>{deck.name}</strong> · {deck.visibility === 'public' ? 'Everyone' : `${deck.recipientUids.length} selected user(s)`}{!lists.some(list => list.id === deck.sourceListId) && <span className="mt-1 block text-xs text-muted-foreground">{deck.sourceListId.startsWith('group:') ? 'Original group removed; published copy remains available.' : 'Original save slot removed; published copy remains available.'}</span>}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={saving || !lists.some(list => list.id === deck.sourceListId)} onClick={() => choose(deck.sourceListId)}>Edit audience</Button><Button size="sm" variant="destructive" disabled={saving} onClick={() => void unpublish(deck)}>Unpublish</Button></div></div>)}</div></div>}
  </section>;
}
