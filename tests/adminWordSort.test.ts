import { describe, expect, it } from 'vitest';
import { countJapaneseCharacters, sortAdminCards } from '../src/lib/adminWordSort';

describe('admin card Japanese-character sorting', () => {
  const cards = [
    { id: 'four', expression: '日本語学', reading: 'にほんごがく' },
    { id: 'one-katakana', expression: 'ア', reading: 'あ' },
    { id: 'zero', expression: 'ABC!', reading: 'えーびーしー' },
    { id: 'two', expression: '東京', reading: 'とうきょう' },
    { id: 'one-hiragana', expression: 'あ', reading: 'あ' },
  ];

  it('counts kanji, hiragana, and katakana, including the katakana long-vowel mark', () => {
    expect(countJapaneseCharacters('日本語学')).toBe(4);
    expect(countJapaneseCharacters('かな')).toBe(2);
    expect(countJapaneseCharacters('カナ')).toBe(2);
    expect(countJapaneseCharacters('コーヒー')).toBe(4);
    expect(countJapaneseCharacters('ABC!')).toBe(0);
  });

  it('sorts shortest to longest or longest to shortest without changing the original list', () => {
    const ascending = sortAdminCards(cards, 'asc');
    const descending = sortAdminCards(cards, 'desc');
    expect(ascending.map(card => countJapaneseCharacters(card.expression))).toEqual([0, 1, 1, 2, 4]);
    expect(descending.map(card => countJapaneseCharacters(card.expression))).toEqual([4, 2, 1, 1, 0]);
    expect(ascending.filter(card => countJapaneseCharacters(card.expression) === 1).map(card => card.id)).toContain('one-katakana');
    expect(ascending.filter(card => countJapaneseCharacters(card.expression) === 1).map(card => card.id)).toContain('one-hiragana');
    expect(cards.map(card => card.id)).toEqual(['four', 'one-katakana', 'zero', 'two', 'one-hiragana']);
  });
});
