import { WORD_LEVELS, type WordLevel } from '../shared/vocabulary';

type CustomWord = {
  id: string;
  expression: string;
  reading: string;
  meaning: string;
  level: WordLevel;
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
  createdAt: string;
};
type WordList = { id: string; name: string; wordIds: string[]; createdAt: string };
export type AdminCardGroup = { id: string; name: string; wordIds: string[]; createdAt: string };

export const ADMIN_MAX_ROWS = 5000;
export const ADMIN_MAX_BYTES = 800000;
export const ADMIN_MAX_GROUPS = 100;
export type AdminEntry = {
  id?: string;
  expression: string;
  reading: string;
  meaning?: string;
  level?: WordLevel;
  partOfSpeechEn?: string;
  partOfSpeechJp?: string;
};
export type AdminGroupAction =
  | { type: 'create'; name: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string };
export type AdminWordChange = {
  version: number;
  entries?: AdminEntry[];
  deleteIds?: string[];
  listId?: string;
  groupId?: string;
  groupAction?: AdminGroupAction;
};

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const trimmed = value.normalize('NFKC').trim();
  if ((required && !trimmed) || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`Invalid ${label} (max ${max} characters, no line breaks).`);
  return trimmed;
}
function key(word: { expression: string; reading: string }) { return `${word.expression.normalize('NFKC').trim()}\u0000${word.reading.normalize('NFKC').trim()}`; }
function groupNameKey(name: string) { return name.normalize('NFKC').trim().toLocaleLowerCase(); }

/** Pure, all-or-nothing preparation; personal cards, group memberships, and list references change atomically. */
export function prepareAdminWordChange(rawWords: unknown, rawLists: unknown, request: AdminWordChange, rawGroups: unknown = []) {
  if (!request || !Number.isSafeInteger(request.version) || request.version < 0) throw new Error('A current account version is required. Reload and try again.');
  const entries = request.entries ?? [], deleteIds = request.deleteIds ?? [];
  const hasGroupAction = request.groupAction !== undefined;
  if (!Array.isArray(entries) || !Array.isArray(deleteIds) || (entries.length + deleteIds.length === 0 && !hasGroupAction) || entries.length > ADMIN_MAX_ROWS || deleteIds.length > ADMIN_MAX_ROWS) throw new Error('Choose cards or a group to change.');
  if (hasGroupAction && (entries.length > 0 || deleteIds.length > 0 || request.groupId !== undefined || request.listId !== undefined)) throw new Error('Change a group separately from its cards.');
  // Never silently drop malformed existing records during an admin edit.
  if (!Array.isArray(rawWords) || !rawWords.every(word => word && typeof word.id === 'string' && typeof word.expression === 'string' && typeof word.reading === 'string' && typeof word.meaning === 'string' && typeof word.level === 'string') ||
      !Array.isArray(rawLists) || !rawLists.every(list => list && typeof list.id === 'string' && Array.isArray(list.wordIds) && list.wordIds.every((id: unknown) => typeof id === 'string')) ||
      !Array.isArray(rawGroups) || !rawGroups.every(group => group && typeof group.id === 'string' && typeof group.name === 'string' && typeof group.createdAt === 'string' && Array.isArray(group.wordIds) && group.wordIds.every((id: unknown) => typeof id === 'string'))) {
    throw new Error('Account data contains invalid cards, groups, or save slots. Nothing was changed.');
  }
  const words = rawWords as CustomWord[];
  const lists = rawLists as WordList[];
  const groups = (rawGroups as AdminCardGroup[]).map(group => ({ ...group, wordIds: [...new Set(group.wordIds)] }));
  if (groups.length > ADMIN_MAX_GROUPS) throw new Error(`This account exceeds the ${ADMIN_MAX_GROUPS}-group limit. Nothing was changed.`);
  const byId = new Map(words.map(word => [word.id, word]));
  const removed = new Set<string>();
  for (const rawId of deleteIds) {
    const id = text(rawId, 'card ID', 200, true);
    if (removed.has(id) || !byId.has(id)) throw new Error(`Unknown or duplicate card ID: ${id}`);
    removed.add(id);
  }
  let targetList: WordList | undefined;
  if (request.listId !== undefined) {
    const listId = text(request.listId, 'save slot ID', 200, true);
    targetList = lists.find(list => list.id === listId);
    if (!targetList) throw new Error('The selected save slot no longer exists. Reload and try again.');
  }

  let createdGroupId: string | undefined;
  let groupActionId: string | undefined;
  let nextGroups = groups.map(group => ({ ...group, wordIds: group.wordIds.filter(id => !removed.has(id)) }));
  if (request.groupAction !== undefined) {
    const action = request.groupAction;
    if (!action || typeof action !== 'object' || !['create', 'rename', 'delete'].includes(action.type)) throw new Error('Invalid card-group action.');
    if (action.type === 'create') {
      const name = text(action.name, 'group name', 120, true);
      if (nextGroups.length >= ADMIN_MAX_GROUPS) throw new Error(`A maximum of ${ADMIN_MAX_GROUPS} card groups is allowed.`);
      if (nextGroups.some(group => groupNameKey(group.name) === groupNameKey(name))) throw new Error('A group with this name already exists.');
      createdGroupId = `group-${crypto.randomUUID()}`;
      groupActionId = createdGroupId;
      nextGroups.push({ id: createdGroupId, name, wordIds: [], createdAt: new Date().toISOString() });
    } else {
      const id = text(action.id, 'group ID', 200, true);
      const groupIndex = nextGroups.findIndex(group => group.id === id);
      if (groupIndex < 0) throw new Error('The selected group no longer exists. Reload and try again.');
      groupActionId = id;
      if (action.type === 'rename') {
        const name = text(action.name, 'group name', 120, true);
        if (nextGroups.some((group, index) => index !== groupIndex && groupNameKey(group.name) === groupNameKey(name))) throw new Error('A group with this name already exists.');
        nextGroups[groupIndex] = { ...nextGroups[groupIndex], name };
      } else {
        nextGroups = nextGroups.filter(group => group.id !== id);
      }
    }
  }

  let targetGroup: AdminCardGroup | undefined;
  if (request.groupId !== undefined) {
    const groupId = text(request.groupId, 'group ID', 200, true);
    if (request.groupAction?.type === 'delete' && request.groupAction.id === groupId) throw new Error('A group cannot be deleted while cards are being added to it.');
    targetGroup = nextGroups.find(group => group.id === groupId);
    if (!targetGroup) throw new Error('The selected group no longer exists. Reload and try again.');
  }

  const next = words.filter(word => !removed.has(word.id));
  const index = new Map(next.map((word, i) => [word.id, i]));
  const matches = new Map<string, CustomWord[]>();
  for (const word of next) matches.set(key(word), [...(matches.get(key(word)) ?? []), word]);
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  const addedIds: string[] = [];
  let created = 0, updated = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid card row.');
    const expression = text(raw.expression, 'expression', 200, true);
    const reading = text(raw.reading, 'reading', 200, true);
    const meaning = raw.meaning === undefined ? undefined : text(raw.meaning, 'meaning', 500);
    const partOfSpeechEn = raw.partOfSpeechEn === undefined ? undefined : text(raw.partOfSpeechEn, 'English part of speech', 80);
    const partOfSpeechJp = raw.partOfSpeechJp === undefined ? undefined : text(raw.partOfSpeechJp, 'Japanese part of speech', 80);
    if (raw.level !== undefined && !WORD_LEVELS.includes(raw.level)) throw new Error('Invalid drawer level.');
    const rowKey = key({ expression, reading });
    if (seen.has(rowKey)) throw new Error(`Duplicate card in request: ${expression} / ${reading}`);
    seen.add(rowKey);
    const id = raw.id === undefined ? undefined : text(raw.id, 'card ID', 200, true);
    if (id && (seenIds.has(id) || removed.has(id))) throw new Error('Duplicate or deleted card ID in request.');
    if (id) seenIds.add(id);
    const found = id ? byId.get(id) : matches.get(rowKey)?.[0];
    if (id && !found) throw new Error(`Card ${id} no longer exists. Reload and try again.`);
    if (!id && (matches.get(rowKey)?.length ?? 0) > 1) throw new Error(`Multiple existing cards match ${expression} / ${reading}. Edit them by ID instead.`);
    if (found) {
      const position = index.get(found.id);
      if (position === undefined) throw new Error('Cannot update a deleted card.');
      next[position] = {
        ...next[position], expression, reading,
        ...(meaning !== undefined ? { meaning } : {}),
        ...(raw.level ? { level: raw.level } : {}),
        ...(partOfSpeechEn !== undefined ? { partOfSpeechEn } : {}),
        ...(partOfSpeechJp !== undefined ? { partOfSpeechJp } : {}),
      };
      updated++;
      addedIds.push(found.id);
    } else {
      const word: CustomWord = {
        id: `custom-admin-${crypto.randomUUID()}`, expression, reading, meaning: meaning ?? '', level: raw.level ?? 'Custom',
        ...(partOfSpeechEn !== undefined ? { partOfSpeechEn } : {}),
        ...(partOfSpeechJp !== undefined ? { partOfSpeechJp } : {}),
        createdAt: new Date().toISOString(),
      };
      next.push(word); addedIds.push(word.id); created++;
    }
  }
  // Refuse ambiguous duplicates (including an ID-based rename to an existing key).
  const touched = new Set(addedIds);
  const allKeys = new Map<string, CustomWord>();
  for (const word of next) {
    const wordKey = key(word), previous = allKeys.get(wordKey);
    // Pre-existing duplicates are tolerated; don't let this request introduce one.
    if (previous && (touched.has(previous.id) || touched.has(word.id))) throw new Error('The change would create duplicate cards.');
    allKeys.set(wordKey, word);
  }
  const nextLists = lists.map(list => ({ ...list, wordIds: list.wordIds.filter(id => !removed.has(id)) }));
  if (targetList) {
    const list = nextLists.find(item => item.id === targetList.id)!;
    list.wordIds = [...new Set([...list.wordIds, ...addedIds])];
    if (list.wordIds.length > 5000) throw new Error('This save slot would exceed 5,000 cards.');
  }
  if (targetGroup && addedIds.length) {
    targetGroup.wordIds = [...new Set([...targetGroup.wordIds, ...addedIds])];
    if (targetGroup.wordIds.length > ADMIN_MAX_ROWS) throw new Error('This group would exceed 5,000 cards.');
  }
  return { customWords: next, lists: nextLists, groups: nextGroups, created, updated, deleted: removed.size, createdGroupId, groupActionId };
}
