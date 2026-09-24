import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { discoveryDocumentId, jlptProgressKey, loadSeenKeys, progressCacheKey, sanitizeSeenKeys, saveSeenKeys, summarizeDiscovery, wordProgressKey } from '../src/lib/cardProgress';

beforeEach(() => localStorage.clear());

describe('card identities and discovery counts', () => {
  it('uses expression and reading, not shuffled position, CSV id, deck, or meaning', () => {
    const original = { id: 'n5-10-猫', expression: '猫', reading: 'ねこ', meaning: 'cat' };
    const reordered = { ...original, id: 'n5-99-猫', meaning: 'a cat' };
    expect(wordProgressKey(original)).toBe(wordProgressKey(reordered));
    expect(wordProgressKey({ expression: ' Ａ ', reading: ' ｶﾅ ' })).toBe(wordProgressKey({ expression: 'A', reading: 'カナ' }));
    expect(wordProgressKey({ ...original, reading: 'びょう' })).not.toBe(wordProgressKey(original));
  });
  it('keeps JLPT questions separate from words', () => {
    expect(jlptProgressKey({ id: 'Q0001' })).toBe('jlpt:Q0001');
    expect(wordProgressKey({ expression: 'Q0001', reading: '' })).not.toBe('jlpt:Q0001');
  });
  it('deduplicates overlapping drawers, repeats and shuffled cards', () => {
    const seen = new Set(['word:a', 'jlpt:q']);
    expect(summarizeDiscovery(['word:b', 'word:a', 'word:a'], seen)).toEqual({ total: 2, seen: 1, remaining: 1, percent: 50 });
    expect(summarizeDiscovery(['word:a', 'word:b'], seen)).toEqual(summarizeDiscovery(['word:b', 'word:a'], seen));
    expect(summarizeDiscovery([], seen)).toEqual({ total: 0, seen: 0, remaining: 0, percent: 0 });
    expect(summarizeDiscovery(['word:a'], seen).percent).toBe(100);
  });
  it('sanitizes malformed cache and isolates accounts', () => {
    expect(sanitizeSeenKeys([null, {}, 1, 'other', 'word:a', 'word:a', 'jlpt:b'])).toEqual(['word:a', 'jlpt:b']);
    localStorage.setItem(progressCacheKey('bad'), '{');
    expect(loadSeenKeys('bad').size).toBe(0);
    saveSeenKeys('alice', new Set(['word:a']));
    expect(loadSeenKeys('alice').has('word:a')).toBe(true);
    expect(loadSeenKeys('bob').size).toBe(0);
  });
  it('uses stable cache ordering to avoid storage-event ping-pong between tabs', () => {
    saveSeenKeys('alice', new Set(['word:b', 'word:a']));
    const before = localStorage.getItem(progressCacheKey('alice'));
    saveSeenKeys('alice', new Set(['word:a', 'word:b']));
    expect(localStorage.getItem(progressCacheKey('alice'))).toBe(before);
  });
  it('handles disabled storage without crashing practice', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(saveSeenKeys('alice', new Set(['word:a']))).toBe(false);
  });
  it('produces bounded deterministic cloud IDs even for long Japanese text and slashes', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const key = wordProgressKey({ expression: '猫/犬'.repeat(500), reading: 'ねこ' });
    const id = await discoveryDocumentId(key);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await discoveryDocumentId(key)).toBe(id);
    expect(await discoveryDocumentId(key + 'a')).not.toBe(id);
    vi.unstubAllGlobals();
  });
});
