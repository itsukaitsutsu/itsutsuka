// src/lib/customWords.ts
// User-added vocabulary — the "personal drawer". Words added here live in
// their own localStorage key and are NEVER merged into the original
// CSV-backed vocabulary exported from ./vocabulary. The two collections
// stay separate on purpose: the Cabinet shows both (tagging these
// "My words"), while the /custom page manages the entries stored below.

import { type Level, type Word } from './vocabulary';

export type CustomWord = {
  id: string;
  expression: string;
  reading: string;
  meaning: string;
  level: Level;
  createdAt: string;
};

export type CustomWordDraft = {
  expression: string;
  reading: string;
  meaning: string;
  level: Level;
};

const CUSTOM_WORDS_KEY = 'kotoba-custom-words';

export const CUSTOM_LEVELS: Level[] = ['N5', 'N4', 'N3', 'N2', 'N1'];

function uid() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseLevel(value: unknown): Level {
  return (CUSTOM_LEVELS as string[]).includes(String(value)) ? (value as Level) : 'N5';
}

function normalize(draft: CustomWordDraft) {
  return {
    expression: draft.expression.trim(),
    reading: draft.reading.trim(),
    meaning: draft.meaning.trim(),
    level: parseLevel(draft.level),
  };
}

/**
 * Turn ANY value that claims to be a custom word list into a guaranteed-safe one.
 * Never throws. Bad items are repaired or safely filtered, so users don't lose data.
 */
export function sanitizeCustomWords(raw: unknown): CustomWord[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.expression === 'string' && item.expression.trim() !== '')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id : uid(),
      expression: String(item.expression).trim(),
      reading: typeof item.reading === 'string' ? item.reading.trim() : '',
      meaning: typeof item.meaning === 'string' ? item.meaning.trim() : '',
      level: parseLevel(item.level),
      createdAt:
        typeof item.createdAt === 'string' && !isNaN(Date.parse(item.createdAt))
          ? item.createdAt
          : new Date().toISOString(),
    }));
}

function readStored(): CustomWord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_WORDS_KEY) || 'null');
    return sanitizeCustomWords(raw);
  } catch {
    /* ignore malformed storage */
  }
  return [];
}

export function persistCustomWords(words: CustomWord[]) {
  localStorage.setItem(CUSTOM_WORDS_KEY, JSON.stringify(words));
}

export function loadCustomWords(): CustomWord[] {
  return readStored();
}

export function addCustomWord(words: CustomWord[], draft: CustomWordDraft): { words: CustomWord[]; id: string } {
  const word: CustomWord = { id: uid(), ...normalize(draft), createdAt: new Date().toISOString() };
  return { words: [word, ...words], id: word.id };
}

export function updateCustomWord(words: CustomWord[], id: string, draft: CustomWordDraft): CustomWord[] {
  const next = normalize(draft);
  return words.map((word) => (word.id === id ? { ...word, ...next } : word));
}

export function deleteCustomWord(words: CustomWord[], id: string): CustomWord[] {
  return words.filter((word) => word.id !== id);
}

// Quiz decks deal in the plain Word shape, so custom words join the pool
// through this adapter. The built-in vocabulary array itself is never
// touched — the mix is only assembled inside the quiz component.
export function customWordsToWords(words: CustomWord[]): Word[] {
  return words.map((word) => ({
    id: word.id,
    expression: word.expression,
    reading: word.reading,
    meaning: word.meaning,
    level: word.level,
    tags: [],
  }));
}