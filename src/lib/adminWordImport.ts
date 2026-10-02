import { csvRecords, MAX_IMPORT_BYTES } from './bulkWordImport';
import { CUSTOM_LEVELS } from './customWords';
import type { AdminWordChange } from './api';

export type AdminImportEntry = NonNullable<AdminWordChange['entries']>[number];

/** Strict admin CSV: never silently skip a malformed card or an edit instruction. */
export function parseAdminWordImport(text: string): AdminImportEntry[] {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('CSV must be at most 1 MiB.');
  const records = csvRecords(text.replace(/^\uFEFF/, ''));
  const headers = records.shift()?.cells.map(cell => cell.normalize('NFKC').trim().toLowerCase());
  if (!headers) throw new Error('CSV is empty.');
  const allowedHeaders = ['id', 'expression', 'reading', 'meaning', 'level', 'part_of_speech_en', 'part_of_speech_english', 'part_of_speech', 'part_of_speech_jp', 'part_of_speech_ja', 'part_of_speech_japanese'];
  if (new Set(headers).size !== headers.length || headers.filter(column => column === 'expression').length !== 1 || headers.filter(column => column === 'reading').length !== 1 || headers.some(column => !allowedHeaders.includes(column))) {
    throw new Error('CSV headers must include expression,reading, plus optional id,meaning,level,part_of_speech_en,part_of_speech_jp (no duplicates or extra columns).');
  }
  const englishPosHeaders = headers.filter(column => ['part_of_speech_en', 'part_of_speech_english', 'part_of_speech'].includes(column));
  const japanesePosHeaders = headers.filter(column => ['part_of_speech_jp', 'part_of_speech_ja', 'part_of_speech_japanese'].includes(column));
  if (englishPosHeaders.length > 1 || japanesePosHeaders.length > 1) throw new Error('Use at most one part-of-speech column for each language.');
  if (!records.length) throw new Error('Add at least one word to the CSV.');
  const seenKeys = new Set<string>(), seenIds = new Set<string>();
  return records.map(record => {
    if (record.cells.length !== headers.length) throw new Error(`Line ${record.line}: wrong number of columns. Quote cells with commas.`);
    const raw = Object.fromEntries(headers.map((header, index) => [header, record.cells[index].normalize('NFKC').trim()]));
    const value = (field: string, max: number, required = false) => {
      const cell = raw[field] ?? '';
      if ((required && !cell) || cell.length > max || /[\u0000-\u001f\u007f]/.test(cell)) throw new Error(`Line ${record.line}: invalid ${field} (max ${max} characters, no line breaks).`);
      return cell;
    };
    const expression = value('expression', 200, true), reading = value('reading', 200, true);
    const id = headers.includes('id') ? value('id', 200) : '';
    const level = headers.includes('level') ? value('level', 20) : '';
    if (level && !CUSTOM_LEVELS.includes(level as typeof CUSTOM_LEVELS[number])) throw new Error(`Line ${record.line}: level must be N1–N5 or Custom.`);
    const key = `${expression}\u0000${reading}`;
    if (seenKeys.has(key) || (id && seenIds.has(id))) throw new Error(`Line ${record.line}: duplicate card or ID in CSV.`);
    seenKeys.add(key); if (id) seenIds.add(id);
    return {
      expression, reading,
      ...(id ? { id } : {}),
      ...(headers.includes('meaning') ? { meaning: value('meaning', 500) } : {}),
      ...(level ? { level: level as typeof CUSTOM_LEVELS[number] } : {}),
      ...(englishPosHeaders.length ? { partOfSpeechEn: value(englishPosHeaders[0], 80) } : {}),
      ...(japanesePosHeaders.length ? { partOfSpeechJp: value(japanesePosHeaders[0], 80) } : {}),
    };
  });
}
