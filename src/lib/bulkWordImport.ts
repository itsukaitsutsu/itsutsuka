import { wordProgressKey } from './cardProgress';
import { sanitizeCustomWords, type CustomWord } from './customWords';
import { sanitizeLists, type WordList } from './wordLists';
import type { Level, Word } from './vocabulary';

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_SAVE_SLOTS = 10;
// D1 caps a single table row at 2 MB. Your account is ONE row (lists + custom
// words + history), so 800 KB keeps a big import clear of that — and it is
// measured on the whole document, while the row stores the three arrays
// separately, so what actually lands in the database is smaller than this.
export const MAX_USER_DOCUMENT_BYTES = 800000;
export type ImportRow = { expression: string; reading: string; line: number };
export type ImportIssue = { line: number; message: string };
export type ParsedWordImport = { rows: ImportRow[]; issues: ImportIssue[]; duplicates: number; dataRows: number; ignoredColumns: string[] };
export type ImportMatch = ImportRow & { key: string; source: 'original' | 'existing' | 'new'; word?: Word | CustomWord };
export type BulkImportRequest = { rows: ImportRow[]; name: string; defaultLevel: Level; importId: string };
export type BulkImportResult = { cacheWarning?: boolean; list: WordList; lists: WordList[]; customWords: CustomWord[]; originalCount: number; reusedCount: number; createdCount: number };

// RFC-style CSV records, including commas/newlines inside quotes and escaped quotes.
// Structural CSV errors reject the whole file; invalid data rows are reported.
function csvRecords(text: string): { cells: string[]; line: number }[] {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [], cell = '', quoted = false, closed = false;
  let line = 1, startLine = 1;
  const endCell = () => { cells.push(cell); cell = ''; closed = false; };
  const endRow = () => {
    endCell();
    if (cells.some((value) => value.trim())) records.push({ cells, line: startLine });
    if (records.length > MAX_IMPORT_ROWS + 1) throw new Error(`A CSV can contain at most ${MAX_IMPORT_ROWS.toLocaleString()} data rows.`);
    cells = []; startLine = line + 1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else { quoted = false; closed = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        cell += '\n'; line += 1;
      } else cell += char;
    } else if (char === ',') endCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRow(); line += 1;
    } else if (char === '"') {
      if (cell.trim() || closed) throw new Error(`Invalid quote on line ${line}. Quote the entire cell and escape quotes as "".`);
      cell = ''; quoted = true;
    } else if (closed) {
      if (!/\s/.test(char)) throw new Error(`Unexpected text after a quoted cell on line ${line}.`);
    } else cell += char;
  }
  if (quoted) throw new Error(`Unclosed quoted cell beginning on line ${startLine}.`);
  if (cell || cells.length || closed) endRow();
  return records;
}

const normalize = (value: string) => value.normalize('NFKC').trim();
function validRow(row: Pick<ImportRow, 'expression' | 'reading'>): boolean {
  return [row.expression, row.reading].every((value) => !!value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value));
}

export function parseWordImport(text: string): ParsedWordImport {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('CSV is too large. The limit is 1 MiB.');
  const records = csvRecords(text.replace(/^\uFEFF/, ''));
  const header = records.shift()?.cells.map((value) => normalize(value).toLowerCase());
  if (!header) throw new Error('The CSV is empty. Add expression,reading headers and at least one word.');
  const expressionColumns = header.flatMap((value, index) => ['expression', 'kanji'].includes(value) ? [index] : []);
  const readingColumns = header.flatMap((value, index) => ['reading', 'furigana'].includes(value) ? [index] : []);
  if (expressionColumns.length !== 1 || readingColumns.length !== 1) throw new Error('Use exactly one expression (or kanji) column and one reading (or furigana) column.');
  const expressionIndex = expressionColumns[0], readingIndex = readingColumns[0];
  const rows: ImportRow[] = [], issues: ImportIssue[] = [];
  const keys = new Set<string>();
  let duplicates = 0;
  for (const record of records) {
    if (record.cells.length !== header.length) { issues.push({ line: record.line, message: 'Column count does not match the header. Quote cells containing commas.' }); continue; }
    const row = { expression: normalize(record.cells[expressionIndex]), reading: normalize(record.cells[readingIndex]), line: record.line };
    if (!validRow(row)) { issues.push({ line: row.line, message: 'Expression and reading are required (max 200 characters each, no line breaks/control characters).' }); continue; }
    const key = wordProgressKey(row);
    if (keys.has(key)) { duplicates += 1; continue; }
    keys.add(key); rows.push(row);
  }
  return { rows, issues, duplicates, dataRows: records.length,
    ignoredColumns: header.filter((_, index) => index !== expressionIndex && index !== readingIndex) };
}

export function matchWordImport(rows: ImportRow[], originals: Word[], customWords: CustomWord[]): ImportMatch[] {
  const originalIndex = new Map<string, Word>();
  const customIndex = new Map<string, CustomWord>();
  for (const word of originals) if (!originalIndex.has(wordProgressKey(word))) originalIndex.set(wordProgressKey(word), word);
  for (const word of customWords) if (!customIndex.has(wordProgressKey(word))) customIndex.set(wordProgressKey(word), word);
  const added = new Set<string>();
  return rows.flatMap((row) => {
    const key = wordProgressKey(row);
    if (added.has(key)) return [];
    added.add(key);
    const original = originalIndex.get(key), custom = customIndex.get(key);
    return [{ ...row, key, source: original ? 'original' : custom ? 'existing' : 'new', word: original ?? custom } as ImportMatch];
  });
}

// Pure transaction preparation: do not mutate the catalogue, existing meanings,
// discovery flags, history or scores. Recompute against current server data.
export function prepareBulkImport(data: Record<string, unknown>, request: BulkImportRequest, originals: Word[], now = new Date().toISOString()): BulkImportResult {
  const name = request.name.trim();
  if (!name || name.length > 120) throw new Error('Give the new save slot a name (1–120 characters).');
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(request.importId)) throw new Error('Invalid import identifier. Choose the file again.');
  if (!['N1', 'N2', 'N3', 'N4', 'N5'].includes(request.defaultLevel)) throw new Error('Choose a default drawer level for unmatched words.');
  if (!request.rows.length || request.rows.length > MAX_IMPORT_ROWS || request.rows.some((row) => !validRow(row))) throw new Error('The import needs 1–5,000 valid words with expression and reading.');
  const lists = sanitizeLists(data.lists), customWords = sanitizeCustomWords(data.customWords);
  const id = `list-import-${request.importId}`;
  const wordPrefix = `custom-import-${request.importId}-`;
  const matches = matchWordImport(request.rows, originals, customWords);
  const previous = lists.find((list) => list.id === id);
  // Stable IDs make retries after a lost response idempotent.
  if (previous) {
    const originalIds = new Set(originals.map((word) => word.id));
    const createdCount = previous.wordIds.filter((wordId) => wordId.startsWith(wordPrefix)).length;
    const originalCount = previous.wordIds.filter((wordId) => originalIds.has(wordId)).length;
    return { list: previous, lists, customWords, createdCount, originalCount, reusedCount: previous.wordIds.length - createdCount - originalCount };
  }
  if (lists.length >= MAX_SAVE_SLOTS) throw new Error(`All ${MAX_SAVE_SLOTS} save slots are in use. Delete a slot before importing.`);
  const additions: CustomWord[] = [];
  const wordIds = matches.map((match, index) => {
    if (match.word) return match.word.id;
    const word: CustomWord = { id: `${wordPrefix}${index}`, expression: match.expression, reading: match.reading,
      meaning: '', level: request.defaultLevel, createdAt: now };
    additions.push(word);
    return word.id;
  });
  const list: WordList = { id, name, wordIds: [...new Set(wordIds)], createdAt: now };
  const result: BulkImportResult = { list, lists: [...lists, list], customWords: [...additions, ...customWords],
    originalCount: matches.filter((item) => item.source === 'original').length,
    reusedCount: matches.filter((item) => item.source === 'existing').length, createdCount: additions.length };
  const document = { ...data, lists: result.lists, customWords: result.customWords, activeId: id };
  if (new TextEncoder().encode(JSON.stringify(document)).length > MAX_USER_DOCUMENT_BYTES) throw new Error('This import would make your account document too large. Import fewer words or remove unused custom words/lists first. Nothing was saved.');
  return result;
}

export const isQuizReadyWord = (word: Pick<Word, 'meaning'>) => word.meaning.trim().length > 0;
