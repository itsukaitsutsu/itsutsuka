// Keep full-tier rounds and large mastery collections below the per-value KV limit.
// All chunks and the alarm are committed in the caller's single storage transaction.
type Store = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
type Manifest = { roomChunks: number };
const chunkKey = (i: number) => `room:chunk:${i}`;
export async function readRoom<T>(storage: Store): Promise<T | undefined> {
  const value = await storage.get<T | Manifest>('room');
  if (!value || typeof value !== 'object' || !('roomChunks' in value)) return value as T | undefined;
  const keys = Array.from({ length: value.roomChunks }, (_, i) => chunkKey(i));
  const chunks: string[] = [];
  for (let i = 0; i < keys.length; i += 64) {
    const batch = keys.slice(i, i + 64), values = await storage.get<string>(batch);
    for (const key of batch) { const chunk = values.get(key); if (chunk === undefined) throw new Error('Incomplete room storage.'); chunks.push(chunk); }
  }
  return JSON.parse(chunks.join('')) as T;
}
export async function writeRoom(storage: Store, room: unknown): Promise<void> {
  const old = await storage.get<Manifest>('room');
  const json = JSON.stringify(room);
  // At most 64 KiB UTF-8 per chunk, even for four-byte characters.
  const chunks = Math.ceil(json.length / 16000);
  for (let i = 0; i < chunks; i += 64) {
    const entries: Record<string, string> = {};
    for (let j = i; j < Math.min(i + 64, chunks); j++) entries[chunkKey(j)] = json.slice(j * 16000, (j + 1) * 16000);
    await storage.put(entries);
  }
  for (let i = chunks; i < (old?.roomChunks ?? 0); i += 64) await storage.delete(Array.from({ length: Math.min(64, old!.roomChunks - i) }, (_, j) => chunkKey(i + j)));
  await storage.put('room', { roomChunks: chunks });
}
