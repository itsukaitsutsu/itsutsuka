import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  filterByPartOfSpeech,
  parseCsv,
  partOfSpeechCategory,
  type Level,
  type Word,
} from '../shared/vocabulary';

const levels: Level[] = ['N1', 'N2', 'N3', 'N4', 'N5'];

describe('bilingual vocabulary part-of-speech data', () => {
  it('reads the English and Japanese POS headers without shifting meaning or tags', () => {
    const words = parseCsv(
      'expression,reading,part_of_speech_jp,part_of_speech_en,meaning,tags\n猫,ねこ,名詞,Noun,"cat, feline",JLPT_N5 JLPT',
      'n5',
      'N5',
    );

    expect(words[0]).toMatchObject({
      id: 'n5-0-猫', expression: '猫', reading: 'ねこ',
      partOfSpeechJp: '名詞', partOfSpeechEn: 'Noun',
      meaning: 'cat, feline', tags: ['JLPT_N5', 'JLPT'], level: 'N5',
    });
  });

  it('keeps compatibility with the earlier expression,reading,meaning,tags CSV layout', () => {
    const words = parseCsv('expression,reading,meaning,tags\n食べる,たべる,to eat,JLPT_N5', 'n5', 'N5');
    expect(words[0]).toMatchObject({ meaning: 'to eat', tags: ['JLPT_N5'] });
    expect(words[0].partOfSpeechEn).toBeUndefined();
    expect(words[0].partOfSpeechJp).toBeUndefined();
  });

  it('loads all five source files with both POS values intact and includes words without furigana', () => {
    const words = levels.flatMap((level) => {
      const csv = readFileSync(`attached_assets/data/vocab-${level.toLowerCase()}.csv`, 'utf8');
      return parseCsv(csv, level.toLowerCase(), level);
    });

    expect(words).toHaveLength(7972);
    expect(words.every((word) => word.partOfSpeechEn && word.partOfSpeechJp)).toBe(true);
    expect(words.find((word) => word.expression === 'ごらんになる' && word.level === 'N4')).toMatchObject({
      reading: '', partOfSpeechEn: 'Verb', partOfSpeechJp: '動詞',
    });
    expect(words.find((word) => word.expression === '高校; 高等学校' && word.level === 'N4')).toMatchObject({
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞',
    });
    expect(words.find((word) => word.expression === '高等学校' && word.level === 'N2')).toMatchObject({
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞',
    });
    expect(words.find((word) => word.expression === '作法' && word.level === 'N3')).toMatchObject({
      partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞', meaning: 'manners, etiquette, propriety',
    });
  });

  it('filters across the bilingual labels while grouping Japanese subtypes consistently', () => {
    const words: Word[] = [
      { id: 'noun', expression: '猫', reading: 'ねこ', meaning: 'cat', level: 'N5', tags: [], partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' },
      { id: 'pronoun', expression: '私', reading: 'わたし', meaning: 'I', level: 'N5', tags: [], partOfSpeechEn: 'Noun', partOfSpeechJp: '代名詞' },
      { id: 'adjectival-noun', expression: '様々', reading: 'さまざま', meaning: 'various', level: 'N3', tags: [], partOfSpeechEn: 'Adjective', partOfSpeechJp: '形状詞' },
      { id: 'particle', expression: 'が', reading: 'が', meaning: 'subject marker', level: 'N3', tags: [], partOfSpeechEn: 'Particle', partOfSpeechJp: '助詞' },
      { id: 'unclassified', expression: 'ええと', reading: 'ええと', meaning: 'well', level: 'Custom', tags: [] },
    ];

    expect(filterByPartOfSpeech(words, 'Noun').map((word) => word.id)).toEqual(['noun', 'pronoun']);
    expect(filterByPartOfSpeech(words, 'Adjective').map((word) => word.id)).toEqual(['adjectival-noun']);
    expect(filterByPartOfSpeech(words, 'Particle').map((word) => word.id)).toEqual(['particle']);
    expect(filterByPartOfSpeech(words, 'Other').map((word) => word.id)).toEqual(['unclassified']);
    expect(partOfSpeechCategory(undefined, '助詞')).toBe('Particle');
    expect(partOfSpeechCategory('Other', '接続詞')).toBe('Other');
  });
});
