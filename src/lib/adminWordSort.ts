export type CardSortOrder = 'asc' | 'desc';
export type SortableCard = { id: string; expression: string; reading: string };

const japaneseCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const isJapaneseWritingCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;

/** Count kanji, hiragana, and katakana characters in an expression. */
export function countJapaneseCharacters(expression: string): number {
  return Array.from(expression.normalize('NFKC')).filter(character => isJapaneseWritingCharacter.test(character)).length;
}

/** Sort admin cards by Japanese character count, then expression, reading, and ID for stable ties. */
export function sortAdminCards<T extends SortableCard>(cards: T[], order: CardSortOrder): T[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => direction * (
    countJapaneseCharacters(a.expression) - countJapaneseCharacters(b.expression)
    || japaneseCollator.compare(a.expression, b.expression)
    || japaneseCollator.compare(a.reading, b.reading)
    || a.id.localeCompare(b.id)
  ));
}
