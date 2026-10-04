import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AdminContentBatch, type AdminContentCard, type AdminContentEvent, type AdminContentEventDetail, type AdminContentGroup, type AdminSharedDeck, type DeckAudience } from '@/lib/api';
import { MAX_IMPORT_BYTES, parseWordImport, type ImportRow } from '@/lib/bulkWordImport';
import { CUSTOM_LEVELS } from '@/lib/customWords';
import { sortAdminCards, type CardSortOrder } from '@/lib/adminWordSort';
import type { WordLevel } from '@/lib/vocabulary';
import { Button } from '@/components/ui/button';

const ADMIN_CONTENT_GROUP_SOURCE_PREFIX = 'admin-content-group:';
const CARD_CHUNK_SIZE = 5000;
const CARD_PAGE_SIZE = 100;
type CatalogFilter = 'all' | `group:${string}` | `batch:${string}`;
type PreparedCsv = { id: string; name: string; rows: Array<Omit<ImportRow, 'line'>>; ignoredColumns: string[]; error: string };
type CardDraft = { expression: string; reading: string; meaning: string; level: WordLevel; partOfSpeechEn: string; partOfSpeechJp: string };
const blankCard: CardDraft = { expression: '', reading: '', meaning: '', level: 'Custom', partOfSpeechEn: '', partOfSpeechJp: '' };
const actionLabel: Record<string, string> = {
  csv_import: 'CSV upload', personal_copy: 'Personal copy', personal_sync: 'Manual sync',
  batch_updated: 'Batch updated', batches_grouped: 'Batches grouped', batches_ungrouped: 'Batches ungrouped', batch_deleted: 'Batch deleted', batches_deleted: 'Batches deleted', cards_removed_from_batch: 'Cards removed from batch',
  card_updated: 'Card edited', cards_deleted: 'Cards deleted', group_created: 'Group created', group_renamed: 'Group renamed', group_deleted: 'Group deleted',
};
const toFilter = (filter: CatalogFilter) => filter === 'all' ? {} : filter.startsWith('batch:')
  ? { batchId: filter.slice('batch:'.length) } : { groupId: filter.slice('group:'.length) };
const uidForFile = (file: File) => `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;

export function AdminContentLibraryPanel() {
  const [groups, setGroups] = useState<AdminContentGroup[]>([]);
  const [batches, setBatches] = useState<AdminContentBatch[]>([]);
  const [cards, setCards] = useState<AdminContentCard[]>([]);
  const [events, setEvents] = useState<AdminContentEvent[]>([]);
  const [published, setPublished] = useState<AdminSharedDeck[]>([]);
  const [limits, setLimits] = useState({ groups: 100, filesPerUpload: 10, rowsPerUpload: 5000 });
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [loadEpoch, setLoadEpoch] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<CardSortOrder>('asc');
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [cardPage, setCardPage] = useState(0);
  const [cardChunkOffset, setCardChunkOffset] = useState(0);
  const [totalCardCount, setTotalCardCount] = useState(0);
  const [hasMoreCards, setHasMoreCards] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [editingGroupId, setEditingGroupId] = useState('');
  const [editingGroupName, setEditingGroupName] = useState('');
  const [uploadGroupId, setUploadGroupId] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PreparedCsv[]>([]);
  const [fileReadBusy, setFileReadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dragSelectValue = useRef<boolean | null>(null);
  const batchDragSelectValue = useRef<boolean | null>(null);
  const batchDragResetTimer = useRef<number | null>(null);
  const previousBatchUserSelect = useRef('');
  const dragResetTimer = useRef<number | null>(null);
  const previousUserSelect = useRef('');
  const [editingBatchId, setEditingBatchId] = useState('');
  const [editingBatchName, setEditingBatchName] = useState('');
  const [editingBatchGroupId, setEditingBatchGroupId] = useState('');
  const [selectedFileBatchIds, setSelectedFileBatchIds] = useState<string[]>([]);
  const [bulkGroupId, setBulkGroupId] = useState('');
  const [editingCard, setEditingCard] = useState<AdminContentCard | null>(null);
  const [cardDraft, setCardDraft] = useState<CardDraft>(blankCard);
  const [openEventId, setOpenEventId] = useState('');
  const [eventDetail, setEventDetail] = useState<AdminContentEventDetail | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [publishGroupId, setPublishGroupId] = useState('');
  const [visibility, setVisibility] = useState<DeckAudience['visibility']>('selected');
  const [recipientText, setRecipientText] = useState('');
  const [adminUid, setAdminUid] = useState('');

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
      // Keep drag-selection state through the click event fired after mouseup.
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

  useEffect(() => {
    const clearBatchDrag = () => {
      if (batchDragResetTimer.current !== null) {
        window.clearTimeout(batchDragResetTimer.current);
      }
      batchDragResetTimer.current = null;

      if (batchDragSelectValue.current !== null) {
        batchDragSelectValue.current = null;
        document.body.style.userSelect = previousBatchUserSelect.current;
      }
    };

    const finishBatchDragAfterClick = () => {
      if (batchDragSelectValue.current === null) return;
      if (batchDragResetTimer.current !== null) {
        window.clearTimeout(batchDragResetTimer.current);
      }
      batchDragResetTimer.current = window.setTimeout(clearBatchDrag, 0);
    };

    window.addEventListener('mouseup', finishBatchDragAfterClick);
    window.addEventListener('blur', clearBatchDrag);
    return () => {
      window.removeEventListener('mouseup', finishBatchDragAfterClick);
      window.removeEventListener('blur', clearBatchDrag);
      clearBatchDrag();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const catalog = await api.adminContent();
        if (!active) return;
        setGroups(catalog.groups); setBatches(catalog.batches); setLimits(catalog.limits);
        const filterExists = filter === 'all'
          || (filter.startsWith('group:') && catalog.groups.some(group => group.id === filter.slice('group:'.length)))
          || (filter.startsWith('batch:') && catalog.batches.some(batch => batch.id === filter.slice('batch:'.length)));
        const selectedFilter: CatalogFilter = filterExists ? filter : 'all';
        const selectedOffset = filterExists ? cardChunkOffset : 0;
        if (!filterExists) { setFilter('all'); setCardChunkOffset(0); }
        const uid = api.currentUid();
        setAdminUid(uid);
        const [cardResult, eventResult, publishedResult] = await Promise.all([
          api.adminContentCards(toFilter(selectedFilter), selectedOffset, sortOrder),
          api.adminContentEvents(50),
          uid ? api.adminSharedDecks(uid) : Promise.resolve({ decks: [] as AdminSharedDeck[] }),
        ]);
        if (!active) return;
        setCards(cardResult.cards); setTotalCardCount(cardResult.total); setHasMoreCards(cardResult.hasMore); setCardPage(0);
        setEvents(eventResult.events); setPublished(publishedResult.decks);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not load the admin content catalog.');
      } finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [filter, loadEpoch, cardChunkOffset, sortOrder]);

  useEffect(() => {
    if (!publishGroupId && groups.length) setPublishGroupId(groups.find(group => group.cardCount > 0)?.id ?? groups[0].id);
    else if (publishGroupId && !groups.some(group => group.id === publishGroupId)) setPublishGroupId(groups.find(group => group.cardCount > 0)?.id ?? groups[0]?.id ?? '');
  }, [groups, publishGroupId]);
  useEffect(() => {
    const publication = published.find(deck => deck.sourceUid === adminUid && deck.sourceListId === `${ADMIN_CONTENT_GROUP_SOURCE_PREFIX}${publishGroupId}`);
    setVisibility(publication?.visibility ?? 'selected');
    setRecipientText(publication?.recipientUids.join('\n') ?? '');
  }, [publishGroupId, published, adminUid]);

  const visibleCards = useMemo(() => cards.filter(card => `${card.expression} ${card.reading} ${card.meaning} ${card.level} ${card.partOfSpeechEn ?? ''} ${card.partOfSpeechJp ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [cards, query]);
  const sortedCards = useMemo(() => sortAdminCards(visibleCards, sortOrder), [visibleCards, sortOrder]);
  const cardPageCount = Math.max(1, Math.ceil(sortedCards.length / CARD_PAGE_SIZE));
  const currentCardPage = Math.min(cardPage, cardPageCount - 1);
  const pageCards = sortedCards.slice(currentCardPage * CARD_PAGE_SIZE, (currentCardPage + 1) * CARD_PAGE_SIZE);
  const cardChunkCount = Math.max(1, Math.ceil(totalCardCount / CARD_CHUNK_SIZE));
  const currentCardChunk = Math.floor(cardChunkOffset / CARD_CHUNK_SIZE);
  const filteredBatchId = filter.startsWith('batch:') ? filter.slice('batch:'.length) : '';
  const currentBatch = batches.find(batch => batch.id === filteredBatchId);
  const selectedGroup = groups.find(group => filter === `group:${group.id}`);
  const selectedCardIdSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);
  const selectedFileBatchIdSet = useMemo(() => new Set(selectedFileBatchIds), [selectedFileBatchIds]);
  const uploadRows = pendingFiles.reduce((total, item) => total + item.rows.length, 0);
  const hasFileError = pendingFiles.some(item => !!item.error);
  const selectedPublication = published.find(deck => deck.sourceUid === adminUid && deck.sourceListId === `${ADMIN_CONTENT_GROUP_SOURCE_PREFIX}${publishGroupId}`);

  const reload = () => { setLoading(true); setCards([]); setTotalCardCount(0); setHasMoreCards(false); setCardChunkOffset(0); setLoadEpoch(epoch => epoch + 1); };
  const chooseFilter = (value: string) => {
    setSelectedCardIds([]); setQuery(''); setEditingCard(null); setCardPage(0); setCardChunkOffset(0);
    setCards([]); setTotalCardCount(0); setHasMoreCards(false); setLoading(true);
    setFilter((value || 'all') as CatalogFilter);
  };
  const queueFiles = async (inputFiles: File[]) => {
    if (!inputFiles.length) return;
    if (fileReadBusy || busy) return;
    if (pendingFiles.length + inputFiles.length > limits.filesPerUpload) {
      setUploadError(`An upload can contain at most ${limits.filesPerUpload} files. Remove files from the queue before adding more.`);
      return;
    }
    setUploadError(''); setFileReadBusy(true);
    try {
      const prepared = await Promise.all(inputFiles.map(async file => {
        const id = uidForFile(file);
        const csv: PreparedCsv = { id, name: file.name, rows: [], ignoredColumns: [], error: '' };
        try {
          if (!/\.csv$/i.test(file.name)) throw new Error('Choose a file with a .csv extension.');
          if (file.size > MAX_IMPORT_BYTES) throw new Error('Each CSV must be at most 1 MiB.');
          if (file.name.trim().length > 120) throw new Error('The file name must be at most 120 characters.');
          const parsed = parseWordImport(await file.text());
          if (parsed.issues.length) throw new Error(`${parsed.issues.length} invalid row(s). First: line ${parsed.issues[0].line}: ${parsed.issues[0].message}`);
          if (parsed.duplicates) throw new Error(`${parsed.duplicates} duplicate row(s) in this file. Remove duplicates before uploading.`);
          if (!parsed.rows.length) throw new Error('No valid cards were found in this file.');
          csv.rows = parsed.rows.map(row => ({ expression: row.expression, reading: row.reading,
            ...(row.meaning !== undefined ? { meaning: row.meaning } : {}),
            ...(row.partOfSpeechEn ? { partOfSpeechEn: row.partOfSpeechEn } : {}),
            ...(row.partOfSpeechJp ? { partOfSpeechJp: row.partOfSpeechJp } : {}) }));
          csv.ignoredColumns = parsed.ignoredColumns;
        } catch (err) { csv.error = err instanceof Error ? err.message : 'Could not read this CSV.'; }
        return csv;
      }));
      setPendingFiles(current => [...current, ...prepared]);
    } finally { setFileReadBusy(false); }
  };
  const removePendingFile = (id: string) => { setPendingFiles(current => current.filter(file => file.id !== id)); setUploadError(''); };
  const uploadCsvFiles = async () => {
    if (!pendingFiles.length || fileReadBusy || busy) return;
    if (hasFileError) { setUploadError('Fix or remove every invalid CSV before uploading.'); return; }
    if (uploadRows > limits.rowsPerUpload) { setUploadError(`A multi-file upload may contain at most ${limits.rowsPerUpload.toLocaleString()} cards in total.`); return; }
    const payload = { groupId: uploadGroupId || null, files: pendingFiles.map(file => ({ name: file.name, rows: file.rows })) };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 10_000_000) { setUploadError('The combined upload exceeds the 10 MB request limit.'); return; }
    setBusy(true); setUploadError(''); setError(''); setNotice('');
    try {
      const result = await api.importAdminContentCsv(payload);
      setPendingFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      setNotice(`Uploaded ${result.batches.length} separate CSV batch(es): ${result.batches.map(batch => `${batch.name} (${batch.cardCount})`).join(', ')}.`);
      setSelectedCardIds([]);
      setFilter(uploadGroupId ? `group:${uploadGroupId}` : result.batches[0] ? `batch:${result.batches[0].id}` : 'all');
      reload();
    } catch (err) { setUploadError(err instanceof Error ? err.message : 'Could not upload the selected CSV files.'); }
    finally { setBusy(false); }
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const group = await api.createAdminContentGroup(name);
      setGroupName(''); setNotice(`Created admin content group “${group.name}”.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the group.'); }
    finally { setBusy(false); }
  };
  const saveGroupName = async (group: AdminContentGroup) => {
    const name = editingGroupName.trim();
    if (!name || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.renameAdminContentGroup(group.id, name);
      setEditingGroupId(''); setNotice(`Renamed group to “${name}”.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not rename the group.'); }
    finally { setBusy(false); }
  };
  const deleteGroup = async (group: AdminContentGroup) => {
    if (!window.confirm(`Delete group “${group.name}”? Its batches and catalog cards will remain, moved to ungrouped. Any published snapshot will remain available until an admin unpublishes it.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.deleteAdminContentGroup(group.id);
      if (filter === `group:${group.id}`) setFilter('all');
      if (uploadGroupId === group.id) setUploadGroupId('');
      if (bulkGroupId === group.id) setBulkGroupId('');
      setNotice(`Deleted group “${group.name}”. Its batches and cards were kept.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete the group.'); }
    finally { setBusy(false); }
  };

  const startBatchEdit = (batch: AdminContentBatch) => {
    setEditingBatchId(batch.id); setEditingBatchName(batch.name); setEditingBatchGroupId(batch.groupId ?? '');
  };
  const saveBatch = async () => {
    const name = editingBatchName.trim();
    if (!editingBatchId || !name || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.updateAdminContentBatch(editingBatchId, { name, groupId: editingBatchGroupId || null });
      setEditingBatchId(''); setNotice(`Updated batch “${name}”.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update this batch.'); }
    finally { setBusy(false); }
  };
  const applyBatchGroup = async () => {
    if (!selectedFileBatchIds.length || busy) return;
    const targetGroup = groups.find(group => group.id === bulkGroupId);
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.groupAdminContentBatches(selectedFileBatchIds, bulkGroupId || null);
      setSelectedFileBatchIds([]);
      setNotice(result.updated
        ? bulkGroupId ? `Moved ${result.updated} batch(es) to “${targetGroup?.name ?? 'the selected group'}”.` : `Ungrouped ${result.updated} batch(es).`
        : 'The selected batches already have that group assignment.');
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update the selected batch groups.'); }
    finally { setBusy(false); }
  };
  const syncBatch = async (batch: AdminContentBatch) => {
    if (!window.confirm(`Synchronize “${batch.name}” from its personal source now? New and updated cards will be copied into this admin batch; cards removed from the source will be released from this batch only. Other admin batches and the personal account will not be changed.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.syncAdminContentBatch(batch.id);
      setNotice(`Manual sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} released from this batch.${result.sourceMissing ? ' The personal source group or save slot no longer exists.' : ''}`);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not synchronize this batch.'); }
    finally { setBusy(false); }
  };
  const deleteBatch = async (batch: AdminContentBatch) => {
    if (!window.confirm(`Permanently delete batch “${batch.name}” and all ${batch.cardCount} of its cards from the admin catalog, including shared cards and their references in other batches? Personal source data and already-published snapshots will remain unchanged.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.deleteAdminContentBatch(batch.id);
      if (filter === `batch:${batch.id}`) setFilter('all');
      setSelectedCardIds([]); setEditingBatchId('');
      setSelectedFileBatchIds(current => current.filter(id => id !== batch.id));
      setNotice(`Deleted batch “${batch.name}” and ${result.deleted} admin catalog card(s). Personal source data and published snapshots were not changed.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete this batch.'); }
    finally { setBusy(false); }
  };
  const deleteSelectedBatches = async () => {
    if (!selectedFileBatchIds.length || busy) return;
    const ids = [...selectedFileBatchIds];
    const selectedBatches = batches.filter(batch => selectedFileBatchIdSet.has(batch.id));
    const totalBatchCards = selectedBatches.reduce((sum, batch) => sum + batch.cardCount, 0);
    if (!window.confirm(`Permanently delete ${ids.length} selected batch(es) (${totalBatchCards.toLocaleString()} batch card entries) and all of their cards from the admin catalog, including shared cards and their references in other batches? Personal source data and already-published snapshots will remain unchanged.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.deleteAdminContentBatches(ids);
      if (filter.startsWith('batch:') && ids.includes(filter.slice('batch:'.length))) setFilter('all');
      setSelectedCardIds([]);
      setEditingBatchId(current => current && ids.includes(current) ? '' : current);
      setSelectedFileBatchIds([]);
      setNotice(`Deleted ${result.deletedBatches} batch(es) and ${result.deletedCards} admin catalog card(s). Personal source data and published snapshots were not changed.`);
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete the selected batches.'); }
    finally { setBusy(false); }
  };

  const selectCard = (id: string, checked: boolean) => setSelectedCardIds(current => checked
    ? [...new Set([...current, id])] : current.filter(cardId => cardId !== id));
  const selectFileBatch = (id: string, checked: boolean) => setSelectedFileBatchIds(current => checked
    ? [...new Set([...current, id])] : current.filter(batchId => batchId !== id));
  const editCard = (card: AdminContentCard) => {
    setEditingCard(card);
    setCardDraft({ expression: card.expression, reading: card.reading, meaning: card.meaning, level: card.level,
      partOfSpeechEn: card.partOfSpeechEn ?? '', partOfSpeechJp: card.partOfSpeechJp ?? '' });
  };
  const saveCard = async () => {
    if (!editingCard || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.updateAdminContentCard(editingCard.id, { ...cardDraft,
        ...(cardDraft.partOfSpeechEn.trim() ? { partOfSpeechEn: cardDraft.partOfSpeechEn.trim() } : { partOfSpeechEn: '' }),
        ...(cardDraft.partOfSpeechJp.trim() ? { partOfSpeechJp: cardDraft.partOfSpeechJp.trim() } : { partOfSpeechJp: '' }) });
      setEditingCard(null); setNotice(`Saved admin card “${cardDraft.expression}”.`); reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save this card.'); }
    finally { setBusy(false); }
  };
  const removeSelectedFromBatch = async () => {
    if (!currentBatch || !selectedCardIds.length || busy) return;
    if (!window.confirm(`Remove ${selectedCardIds.length} selected card(s) from batch “${currentBatch.name}”? Other batch memberships remain unchanged; this action does not change any personal source.`)) return;
    setBusy(true); setError(''); setNotice('');
    let removed = 0;
    try {
      for (let start = 0; start < selectedCardIds.length; start += CARD_CHUNK_SIZE) {
        const result = await api.removeAdminContentCardsFromBatch(currentBatch.id, selectedCardIds.slice(start, start + CARD_CHUNK_SIZE));
        removed += result.removed;
      }
      setSelectedCardIds([]); setNotice(`Removed ${removed} card(s) from “${currentBatch.name}”. Other batch references and source accounts were not changed.`); reload();
    } catch (err) {
      setSelectedCardIds([]);
      setError(removed
        ? `Partial removal: ${removed} card(s) were released before a later request failed. ${err instanceof Error ? err.message : 'Please reload and review the batch.'}`
        : err instanceof Error ? err.message : 'Could not remove cards from this batch.');
      if (removed) reload();
    }
    finally { setBusy(false); }
  };
  const deleteSelectedCards = async () => {
    if (!selectedCardIds.length || busy) return;
    const ids = [...selectedCardIds];
    if (!window.confirm(`Permanently delete ${ids.length} selected card(s) from the entire admin catalog, including their references in every batch? Personal source accounts and already-published snapshots will remain unchanged.`)) return;
    setBusy(true); setError(''); setNotice('');
    let deleted = 0, removedReferences = 0;
    try {
      for (let start = 0; start < ids.length; start += CARD_CHUNK_SIZE) {
        const result = await api.deleteAdminContentCards(ids.slice(start, start + CARD_CHUNK_SIZE));
        deleted += result.deleted; removedReferences += result.removedReferences;
      }
      setSelectedCardIds([]);
      setEditingCard(current => current && ids.includes(current.id) ? null : current);
      setNotice(`Deleted ${deleted} card(s) from the admin catalog and removed ${removedReferences} batch reference(s). Personal sources and published snapshots were unchanged.`);
      reload();
    } catch (err) {
      setSelectedCardIds([]);
      setEditingCard(current => current && ids.includes(current.id) ? null : current);
      setError(deleted
        ? `Partial deletion: ${deleted} of ${ids.length} selected card(s) were removed before a later request failed. ${err instanceof Error ? err.message : 'Please reload and review the catalog.'}`
        : err instanceof Error ? err.message : 'Could not delete the selected cards.');
      if (deleted) reload();
    }
    finally { setBusy(false); }
  };

  const toggleEvent = async (event: AdminContentEvent) => {
    if (openEventId === event.id) { setOpenEventId(''); setEventDetail(null); return; }
    setOpenEventId(event.id); setEventDetail(null); setHistoryError(''); setEventBusy(true);
    try { setEventDetail(await api.adminContentEvent(event.id)); }
    catch (err) { setHistoryError(err instanceof Error ? err.message : 'Could not load the change log.'); }
    finally { setEventBusy(false); }
  };

  const publishGroup = async () => {
    const group = groups.find(item => item.id === publishGroupId);
    if (!group || busy) return;
    const recipientUids = visibility === 'selected' ? [...new Set(recipientText.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))] : [];
    if (visibility === 'selected' && !recipientUids.length) { setError('Enter at least one recipient Firebase UID.'); return; }
    if (recipientUids.length > 100) { setError('Enter no more than 100 recipient Firebase UIDs.'); return; }
    const action = selectedPublication ? 'Change the audience of' : 'Publish';
    const audienceLabel = visibility === 'public' ? 'for EVERY signed-in user' : `for ${recipientUids.length} selected user(s)`;
    if (!window.confirm(`${action} the frozen snapshot of “${group.name}” ${audienceLabel}? Its words and meanings will be visible to that audience.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const audience: DeckAudience = { visibility, recipientUids };
      if (selectedPublication) await api.updatePublishedDeck(selectedPublication.id, audience);
      else await api.publishAdminContentGroup(group.id, audience);
      setNotice(selectedPublication ? 'Publication audience updated.' : 'Published an independent snapshot of this admin content group. It does not use a personal save slot.');
      reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not publish this content group.'); }
    finally { setBusy(false); }
  };
  const unpublish = async (deck: AdminSharedDeck) => {
    if (!window.confirm(`Unpublish “${deck.name}”? Recipients will no longer be able to open it. The frozen snapshot is removed; the admin catalog group and batches remain.`)) return;
    setBusy(true); setError(''); setNotice('');
    try { await api.unpublishDeck(deck.id); setNotice(`Unpublished “${deck.name}”. The admin catalog group remains unchanged.`); reload(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not unpublish this snapshot.'); }
    finally { setBusy(false); }
  };
  const clearCatalogActivity = async () => {
    if (!events.length || busy) return;
    if (!window.confirm('Clear all catalog activity log entries? Groups, batches, cards, and published snapshots will not be changed.')) return;
    setBusy(true); setError(''); setNotice(''); setHistoryError('');
    try {
      const result = await api.clearAdminContentEvents();
      setEvents([]);
      setOpenEventId('');
      setEventDetail(null);
      setNotice(`Cleared ${result.deleted} catalog activity log entry/entries.`);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Could not clear catalog activity.');
    } finally {
      setBusy(false);
    }
  };

  return <section className="space-y-6" data-testid="admin-content-library">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Admin-owned library</p><h2 className="font-serif text-3xl">Admin content</h2><p className="mt-2 text-sm text-muted-foreground">CSV files and copied personal content are stored as separate admin batches, outside every personal account and save slot. A content group holds multiple batches. Matching expression and reading pairs share one admin card rather than creating duplicate cards.</p></header>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{notice}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading admin content…</p>}

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-groups">
      <div><h3 className="font-serif text-2xl">Content groups</h3><p className="mt-1 text-sm text-muted-foreground">A group organizes multiple file batches. Batches may also remain ungrouped and can be assigned later.</p></div>
      <form onSubmit={event => { event.preventDefault(); void createGroup(); }} className="flex flex-wrap items-end gap-2"><label className="min-w-[220px] flex-1 text-sm font-semibold">New group name<input value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={120} placeholder="e.g. SSW Manufacture" className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><Button type="submit" disabled={busy || !groupName.trim() || groups.length >= limits.groups}>Create group</Button><span className="text-xs text-muted-foreground">{groups.length} / {limits.groups}</span></form>
      {!groups.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No groups yet. You can create one here or upload batches without a group and organize them later.</p>}
      {!!groups.length && <div className="grid gap-3 md:grid-cols-2">{groups.map(group => <article key={group.id} className="rounded-xl border p-3">
        {editingGroupId === group.id ? <div className="flex flex-wrap items-end gap-2"><label className="min-w-[180px] flex-1 text-sm font-semibold">Group name<input value={editingGroupName} onChange={event => setEditingGroupName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><Button size="sm" disabled={busy || !editingGroupName.trim()} onClick={() => void saveGroupName(group)}>Save</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingGroupId('')}>Cancel</Button></div>
          : <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-semibold">{group.name}</h4><p className="text-xs text-muted-foreground">{group.batchCount} batch(es) · {group.cardCount} unique card(s)</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => chooseFilter(`group:${group.id}`)}>View group</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditingGroupId(group.id); setEditingGroupName(group.name); }}>Rename</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteGroup(group)}>Delete group</Button></div></div>}
      </article>)}</div>}
    </section>

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-upload">
      <div><h3 className="font-serif text-2xl">Upload CSV files as separate batches</h3><p className="mt-1 text-sm text-muted-foreground">Choose several CSVs at once or drop them below. Each file becomes its own batch, retaining its filename. Up to {limits.filesPerUpload} files and {limits.rowsPerUpload.toLocaleString()} cards per upload.</p></div>
      <label className="block text-sm font-semibold">Choose CSV file(s)<input ref={fileInput} type="file" multiple accept=".csv,text/csv" disabled={busy || fileReadBusy} onChange={event => { void queueFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} className="mt-1 block w-full rounded-lg border bg-background p-3 font-normal file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground" /></label>
      <div onDragEnter={event => { event.preventDefault(); setDragging(true); }} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { event.preventDefault(); setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); void queueFiles(Array.from(event.dataTransfer.files)); }} className={`rounded-xl border-2 border-dashed p-6 text-center text-sm transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'}`}>
        Drop multiple .csv files here to queue them. They will remain separate batches.
      </div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Group for these upload batches<select value={uploadGroupId} disabled={busy} onChange={event => setUploadGroupId(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="">Ungrouped — assign later</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><div className="flex items-end text-sm text-muted-foreground">{pendingFiles.length} file(s) queued · {uploadRows.toLocaleString()} card row(s)</div></div>
      {!!pendingFiles.length && <div className="space-y-2">{pendingFiles.map(file => <div key={file.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"><div><strong>{file.name}</strong><span className="ml-2 text-muted-foreground">{file.rows.length} cards</span>{file.error && <p className="mt-1 text-destructive">{file.error}</p>}{!file.error && !!file.ignoredColumns.length && <p className="mt-1 text-xs text-muted-foreground">Ignored columns: {file.ignoredColumns.join(', ')}</p>}</div><Button size="sm" variant="outline" disabled={busy || fileReadBusy} onClick={() => removePendingFile(file.id)}>Remove</Button></div>)}</div>}
      {uploadError && <p role="alert" className="text-sm text-destructive">{uploadError}</p>}
      <div className="flex flex-wrap items-center gap-2"><Button disabled={busy || fileReadBusy || !pendingFiles.length || hasFileError} onClick={() => void uploadCsvFiles()}>{busy ? 'Saving…' : `Upload ${pendingFiles.length || ''} file batch(es)`}</Button>{fileReadBusy && <span role="status" className="text-sm text-muted-foreground">Reading CSV files…</span>}</div>
    </section>

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-batches">
      <div><h3 className="font-serif text-2xl">File batches</h3><p className="mt-1 text-sm text-muted-foreground">Manage every CSV or personal-source copy independently. Personal batches change only when an admin chooses Manual sync.</p></div>
      {!batches.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No batches yet. Upload a CSV file or copy cards from Personal cards.</p>}
      {!!batches.length && <div className="flex flex-wrap items-end gap-3 rounded-xl bg-muted/40 p-3">
        <div className="mr-auto min-w-[220px]"><strong className="text-sm">Group batches in bulk</strong><p className="text-xs text-muted-foreground">Select batches below, then assign or ungroup them. Each CSV remains its own batch.</p><p className="text-xs text-muted-foreground">{selectedFileBatchIds.length} of {batches.length} selected</p></div>
        <Button size="sm" variant="outline" disabled={busy || selectedFileBatchIds.length === batches.length} onClick={() => setSelectedFileBatchIds(batches.map(batch => batch.id))}>Select all batches</Button>
        <Button size="sm" variant="outline" disabled={busy || !selectedFileBatchIds.length} onClick={() => setSelectedFileBatchIds([])}>Clear selection</Button>
        <label className="min-w-[200px] text-sm font-semibold">Target group<select aria-label="Target group for selected batches" value={bulkGroupId} disabled={busy} onChange={event => setBulkGroupId(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="">Ungrouped</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <Button size="sm" disabled={busy || !selectedFileBatchIds.length} onClick={() => void applyBatchGroup()}>{busy ? 'Saving…' : `Apply to selected batches (${selectedFileBatchIds.length})`}</Button>
        <Button size="sm" variant="destructive" disabled={busy || !selectedFileBatchIds.length} onClick={() => void deleteSelectedBatches()}>{busy ? 'Deleting…' : `Delete selected batches (${selectedFileBatchIds.length})`}</Button>
      </div>}
      {!!batches.length && <div className="max-h-[34rem] space-y-2 overflow-auto">{batches.map(batch => <article key={batch.id} className={`rounded-xl border p-3 ${filter === `batch:${batch.id}` ? 'border-primary' : ''}`} onMouseEnter={() => {
        const checked = batchDragSelectValue.current;
        if (checked !== null) selectFileBatch(batch.id, checked);
      }}>
        {editingBatchId === batch.id ? <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"><label className="text-sm font-semibold">Batch name<input value={editingBatchName} onChange={event => setEditingBatchName(event.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Group<select value={editingBatchGroupId} onChange={event => setEditingBatchGroupId(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="">Ungrouped</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><div className="flex gap-2"><Button size="sm" disabled={busy || !editingBatchName.trim()} onClick={() => void saveBatch()}>Save</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingBatchId('')}>Cancel</Button></div></div>
          : <div className="flex flex-wrap items-center gap-3"><input type="checkbox" aria-label={`Select batch ${batch.name} (${batch.id})`} checked={selectedFileBatchIdSet.has(batch.id)} disabled={busy} onMouseDown={event => {
            if (event.button !== 0) return;
            if (batchDragResetTimer.current !== null) window.clearTimeout(batchDragResetTimer.current);
            batchDragResetTimer.current = null;
            const checked = !selectedFileBatchIdSet.has(batch.id);
            batchDragSelectValue.current = checked;
            previousBatchUserSelect.current = document.body.style.userSelect;
            document.body.style.userSelect = 'none';
            selectFileBatch(batch.id, checked);
          }} onClick={event => {
            const checked = batchDragSelectValue.current;
            if (checked === null) return;
            event.preventDefault();
            selectFileBatch(batch.id, checked);
          }} onChange={event => selectFileBatch(batch.id, batchDragSelectValue.current ?? event.currentTarget.checked)} /><div className="min-w-[190px] flex-1"><strong>{batch.name}</strong><p className="text-xs text-muted-foreground">{batch.kind === 'csv' ? 'CSV file' : 'Personal source copy'} · {batch.cardCount} cards · {batch.groupName ? `Group: ${batch.groupName}` : 'Ungrouped'}{batch.kind === 'personal' && batch.sourceUid && <span className="block">Source UID: {batch.sourceUid} · {batch.sourceKind === 'my_words' ? 'My words' : batch.sourceKind === 'list' ? 'Save slot' : 'Personal group'}</span>}</p></div><Button size="sm" variant="outline" onClick={() => chooseFilter(`batch:${batch.id}`)}>View cards</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => startBatchEdit(batch)}>Rename / group</Button>{batch.kind === 'personal' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void syncBatch(batch)}>Sync now</Button>}<Button size="sm" variant="destructive" disabled={busy} onClick={() => void deleteBatch(batch)}>Delete batch</Button></div>}
      </article>)}</div>}
    </section>

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-cards">
      <div><h3 className="font-serif text-2xl">Manage cards</h3><p className="mt-1 text-sm text-muted-foreground">Filter by one batch or by an entire group. Matching expression and reading pairs are shared across source batches, so the Batches column shows a compact count instead of repeating every filename. Larger results load in chunks of up to 5,000 cards; the table renders up to 100 rows per page.</p></div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><label className="text-sm font-semibold">Show cards<select aria-label="Filter admin cards by batch or group" value={filter} onChange={event => chooseFilter(event.target.value)} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="all">All admin catalog cards</option><optgroup label="Groups">{groups.map(group => <option key={group.id} value={`group:${group.id}`}>{group.name} · {group.cardCount} cards</option>)}</optgroup><optgroup label="Batches / files">{batches.map(batch => <option key={batch.id} value={`batch:${batch.id}`}>{batch.name} · {batch.cardCount} cards</option>)}</optgroup></select></label><label className="text-sm font-semibold">Search current 5,000-card chunk<input value={query} onChange={event => { setQuery(event.target.value); setCardPage(0); }} placeholder="Expression, reading, meaning, POS…" className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label></div>
      <div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm text-muted-foreground">{sortedCards.length} match(es) in this chunk · table page {currentCardPage + 1} of {cardPageCount}{selectedGroup ? ` · Group: ${selectedGroup.name}` : currentBatch ? ` · Batch: ${currentBatch.name}` : ''} · {selectedCardIds.length} selected</span><Button size="sm" variant="outline" disabled={busy || !pageCards.length} onClick={() => setSelectedCardIds(current => [...new Set([...current, ...pageCards.map(card => card.id)])])}>Select this page ({pageCards.length})</Button><Button size="sm" variant="outline" disabled={busy || !sortedCards.length} onClick={() => setSelectedCardIds(current => [...new Set([...current, ...sortedCards.map(card => card.id)])])}>Select all filtered in chunk ({sortedCards.length})</Button><Button size="sm" variant="outline" onClick={() => { setLoading(true); setCards([]); setSortOrder(order => order === 'asc' ? 'desc' : 'asc'); setCardPage(0); setCardChunkOffset(0); }}>Sort: {sortOrder === 'asc' ? 'shortest first' : 'longest first'}</Button><Button size="sm" variant="outline" disabled={busy || !selectedCardIds.length} onClick={() => setSelectedCardIds([])}>Clear selection</Button>{currentBatch && <Button size="sm" variant="outline" disabled={busy || !selectedCardIds.length} onClick={() => void removeSelectedFromBatch()}>Remove selected from this batch ({selectedCardIds.length})</Button>}<Button size="sm" variant="destructive" disabled={busy || !selectedCardIds.length} onClick={() => void deleteSelectedCards()}>Delete selected from catalog ({selectedCardIds.length})</Button></div>
      {totalCardCount > CARD_CHUNK_SIZE && <nav className="flex flex-wrap items-center justify-center gap-3 rounded-lg bg-muted/40 p-2" aria-label="Admin card data chunks">
        <Button size="sm" variant="outline" aria-label="Previous 5,000 cards" disabled={loading || busy || cardChunkOffset === 0} onClick={() => { setLoading(true); setCards([]); setCardPage(0); setCardChunkOffset(Math.max(0, cardChunkOffset - CARD_CHUNK_SIZE)); }}>Previous 5,000</Button>
        <span role="status" aria-live="polite" className="text-sm text-muted-foreground">{loading ? `Loading chunk ${currentCardChunk + 1} of ${cardChunkCount} · ${totalCardCount.toLocaleString()} total cards` : `Chunk ${currentCardChunk + 1} of ${cardChunkCount} · cards ${cardChunkOffset + 1}–${Math.min(cardChunkOffset + cards.length, totalCardCount)} of ${totalCardCount.toLocaleString()}`}</span>
        <Button size="sm" variant="outline" aria-label="Next 5,000 cards" disabled={loading || busy || !hasMoreCards} onClick={() => { setLoading(true); setCards([]); setCardPage(0); setCardChunkOffset(cardChunkOffset + CARD_CHUNK_SIZE); }}>Next 5,000</Button>
      </nav>}
      {totalCardCount > CARD_CHUNK_SIZE && <p className="text-xs text-muted-foreground">Search applies to the current 5,000-card chunk. Selected cards remain selected as you move between chunks.</p>}
      <p className="text-xs text-muted-foreground">To select several rows, hold the left mouse button on a checkbox and drag across the rows; the first checkbox determines whether the drag selects or clears. “Remove selected from this batch” only removes membership in the displayed batch. “Delete selected from catalog” permanently removes the cards from every admin batch; personal source data and published snapshots remain unchanged.</p>
      {editingCard && <div className="space-y-3 rounded-xl border border-primary/40 bg-muted/20 p-4"><div className="flex items-center justify-between gap-2"><h4 className="font-semibold">Edit admin card</h4><Button size="sm" variant="outline" onClick={() => setEditingCard(null)}>Cancel</Button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Expression<input value={cardDraft.expression} onChange={event => setCardDraft(current => ({ ...current, expression: event.target.value }))} maxLength={200} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Reading<input value={cardDraft.reading} onChange={event => setCardDraft(current => ({ ...current, reading: event.target.value }))} maxLength={200} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Meaning<input value={cardDraft.meaning} onChange={event => setCardDraft(current => ({ ...current, meaning: event.target.value }))} maxLength={500} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Level<select value={cardDraft.level} onChange={event => setCardDraft(current => ({ ...current, level: event.target.value as WordLevel }))} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal">{CUSTOM_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}</select></label><label className="text-sm font-semibold">Part of speech (English)<input value={cardDraft.partOfSpeechEn} onChange={event => setCardDraft(current => ({ ...current, partOfSpeechEn: event.target.value }))} maxLength={80} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label><label className="text-sm font-semibold">Part of speech (Japanese)<input value={cardDraft.partOfSpeechJp} onChange={event => setCardDraft(current => ({ ...current, partOfSpeechJp: event.target.value }))} maxLength={80} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal" /></label></div><Button disabled={busy || !cardDraft.expression.trim() || !cardDraft.reading.trim()} onClick={() => void saveCard()}>Save card</Button></div>}
      {!visibleCards.length && !loading && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No cards match this filter.</p>}
      {!!visibleCards.length && <>
        <div className="max-h-[38rem] overflow-auto rounded-xl border"><table className="w-full min-w-[900px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">Select</th><th>Expression / reading</th><th>Meaning</th><th>Level / POS</th><th>Batches</th><th>Action</th></tr></thead><tbody>{pageCards.map(card => <tr key={card.id} className="border-t align-top" onMouseEnter={() => {
          const checked = dragSelectValue.current;
          if (checked !== null) selectCard(card.id, checked);
        }}><td className="p-2"><input type="checkbox" aria-label={`Select ${card.expression}`} checked={selectedCardIdSet.has(card.id)} onMouseDown={event => {
          if (event.button !== 0) return;
          if (dragResetTimer.current !== null) window.clearTimeout(dragResetTimer.current);
          dragResetTimer.current = null;
          const checked = !selectedCardIds.includes(card.id);
          dragSelectValue.current = checked;
          previousUserSelect.current = document.body.style.userSelect;
          document.body.style.userSelect = 'none';
          selectCard(card.id, checked);
        }} onClick={event => {
          const checked = dragSelectValue.current;
          if (checked === null) return;
          event.preventDefault();
          selectCard(card.id, checked);
        }} onChange={event => selectCard(card.id, dragSelectValue.current ?? event.currentTarget.checked)} /></td><td className="py-2"><strong>{card.expression}</strong><br /><span className="text-muted-foreground">{card.reading}</span></td><td className="py-2">{card.meaning || '—'}</td><td className="py-2">{card.level}<br /><span className="text-xs text-muted-foreground">{[card.partOfSpeechEn, card.partOfSpeechJp].filter(Boolean).join(' · ') || 'POS not set'}</span></td><td className="py-2" title={`Present in ${card.batchCount} batch(es)`}>{card.batchCount} {card.batchCount === 1 ? 'batch' : 'batches'}</td><td className="py-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => editCard(card)}>Edit</Button></td></tr>)}</tbody></table></div>
        {cardPageCount > 1 && <nav aria-label="Manage cards pagination" className="flex flex-wrap items-center justify-center gap-3">
          <Button size="sm" variant="outline" aria-label="Previous card page" disabled={currentCardPage === 0} onClick={() => setCardPage(currentCardPage - 1)}>Previous</Button>
          <span role="status" aria-live="polite" className="text-sm text-muted-foreground">Page {currentCardPage + 1} of {cardPageCount} · showing {currentCardPage * CARD_PAGE_SIZE + 1}–{Math.min((currentCardPage + 1) * CARD_PAGE_SIZE, sortedCards.length)} of {sortedCards.length}</span>
          <Button size="sm" variant="outline" aria-label="Next card page" disabled={currentCardPage >= cardPageCount - 1} onClick={() => setCardPage(currentCardPage + 1)}>Next</Button>
        </nav>}
      </>}
    </section>

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-publication">
      <div><h3 className="font-serif text-2xl">Publish an admin content group</h3><p className="mt-1 text-sm text-muted-foreground">Publication creates a frozen snapshot from all batches currently assigned to the group. It does not use personal save slots. Later catalog edits, source-account changes, or batch deletion do not alter the snapshot; only an admin can unpublish it.</p></div>
      {!groups.length && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Create a group and assign at least one batch before publishing.</p>}
      {!!groups.length && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Group snapshot<select value={publishGroupId} onChange={event => setPublishGroupId(event.target.value)} disabled={busy} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal">{groups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.cardCount} cards</option>)}</select></label><label className="text-sm font-semibold">Audience<select value={visibility} onChange={event => setVisibility(event.target.value as DeckAudience['visibility'])} disabled={busy} className="mt-1 w-full rounded-lg border bg-background px-3 py-2 font-normal"><option value="selected">Selected users only</option><option value="public">Everyone signed in</option></select></label>{visibility === 'selected' && <label className="text-sm font-semibold sm:col-span-2">Recipient Firebase UIDs<textarea value={recipientText} onChange={event => setRecipientText(event.target.value)} rows={3} maxLength={14000} disabled={busy} placeholder="One Firebase UID per line (or separate with commas)" className="mt-1 w-full rounded-lg border bg-background p-3 font-normal" /><span className="text-xs font-normal text-muted-foreground">Up to 100 users. Use Firebase UIDs, not email addresses.</span></label>}<div className="sm:col-span-2"><Button disabled={busy || !publishGroupId || !(groups.find(group => group.id === publishGroupId)?.cardCount)} onClick={() => void publishGroup()}>{busy ? 'Saving…' : selectedPublication ? 'Update publication access' : 'Publish frozen snapshot'}</Button></div></div>}
      {!!published.filter(deck => deck.sourceUid === adminUid && deck.sourceListId.startsWith(ADMIN_CONTENT_GROUP_SOURCE_PREFIX)).length && <div className="border-t pt-4"><h4 className="font-semibold">Published admin content snapshots</h4><div className="mt-2 space-y-2">{published.filter(deck => deck.sourceUid === adminUid && deck.sourceListId.startsWith(ADMIN_CONTENT_GROUP_SOURCE_PREFIX)).map(deck => { const sourceGroupId = deck.sourceListId.slice(ADMIN_CONTENT_GROUP_SOURCE_PREFIX.length); const sourceGroup = groups.find(group => group.id === sourceGroupId); return <div key={deck.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm"><span><strong>{deck.name}</strong> · {deck.cardCount} cards · {deck.visibility === 'public' ? 'Everyone signed in' : `${deck.recipientUids.length} selected user(s)`}{!sourceGroup && <span className="mt-1 block text-xs text-muted-foreground">Original admin group was deleted; this frozen snapshot remains available.</span>}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || !sourceGroup} onClick={() => sourceGroup && setPublishGroupId(sourceGroup.id)}>Edit audience</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void unpublish(deck)}>Unpublish</Button></div></div>; })}</div></div>}
      <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">Confirm that the selected group is appropriate to share. Publishing exposes all included words and meanings to the chosen audience.</p>
    </section>

    <section className="space-y-4 rounded-2xl border border-border bg-card p-5" data-testid="admin-content-history">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-serif text-2xl">Catalog activity</h3><p className="mt-1 text-sm text-muted-foreground">Recent uploads, copies, synchronization, bulk group changes, card removals, and batch deletion. Open a log entry to see which cards were added, updated, released, or deleted.</p></div>{!!events.length && <Button size="sm" variant="destructive" disabled={busy || eventBusy} onClick={() => void clearCatalogActivity()}>{busy ? 'Clearing…' : 'Clear catalog activity'}</Button>}</div>
      {historyError && <p role="alert" className="text-sm text-destructive">{historyError}</p>}
      {!events.length && !loading && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">No admin catalog activity has been recorded yet.</p>}
      {!!events.length && <div className="space-y-2">{events.map(event => <article key={event.id} className="rounded-xl border p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{actionLabel[event.action] ?? event.action}</strong>{event.batch_name && <span> · {event.batch_name}</span>}<p className="mt-1 text-xs text-muted-foreground">{event.summary} · {new Date(event.created_at).toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{event.added_count} added · {event.updated_count} updated · {event.removed_count} released · {event.deleted_count} deleted</p></div><Button size="sm" variant="outline" onClick={() => void toggleEvent(event)}>{openEventId === event.id ? 'Hide card log' : 'Show card log'}</Button></div>{openEventId === event.id && <div className="mt-3 border-t pt-3">{eventBusy && <p role="status" className="text-sm">Loading card log…</p>}{eventDetail && <>{!eventDetail.cards.length ? <p className="text-sm text-muted-foreground">This activity entry has no individual card changes.</p> : <div className="max-h-64 overflow-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">Change</th><th>Expression</th><th>Reading</th></tr></thead><tbody>{eventDetail.cards.map((card, index) => <tr key={`${card.position}-${index}`} className="border-t"><td className="p-2">{card.change_type}</td><td>{card.expression}</td><td>{card.reading}</td></tr>)}</tbody></table></div>}</>}{historyError && <p role="alert" className="mt-2 text-sm text-destructive">{historyError}</p>}</div>}</article>)}</div>}
    </section>
  </section>;
}
