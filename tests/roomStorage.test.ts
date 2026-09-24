// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readRoom, writeRoom } from '../worker/roomStorage';
function storage() {
  const data = new Map<string, unknown>();
  const api = {
    async get(keys: string | string[]) { return typeof keys === 'string' ? data.get(keys) : new Map(keys.filter(k => data.has(k)).map(k => [k, data.get(k)])); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) {
        if (typeof v === 'string') expect(Buffer.byteLength(v)).toBeLessThan(128 * 1024);
        data.set(k as string, structuredClone(v));
      }
    },
    async delete(keys: string | string[]) { for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k); },
  };
  return { data, api: api as any };
}
describe('bounded durable room snapshots', () => {
  it('round-trips a multi-megabyte full-tier snapshot without oversized values and removes old chunks', async () => {
    const { api, data } = storage();
    const snapshot = { questions: Array.from({ length: 3000 }, (_, i) => ({ id: i, reading: '日本語😀'.repeat(200) })), accounts: { a: 10, b: 20 } };
    await writeRoom(api, snapshot); expect(data.size).toBeGreaterThan(128); expect(await readRoom(api)).toEqual(snapshot);
    await writeRoom(api, { status: 'complete' }); expect(await readRoom(api)).toEqual({ status: 'complete' }); expect(data.size).toBe(2);
  });
  it('can read old snapshots for a clear legacy-room error and detects missing chunks', async () => {
    const { api, data } = storage(); data.set('room', { status: 'legacy' }); expect(await readRoom(api)).toEqual({ status: 'legacy' });
    await writeRoom(api, { status: 'live' }); data.delete('room:chunk:0'); await expect(readRoom(api)).rejects.toThrow('Incomplete room storage');
  });
});
