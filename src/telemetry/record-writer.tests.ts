import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { CompareAndSetParams, Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from './record-writer.js';
import type { Redact } from './redact.js';

const MASK = '[redacted]';
const maskSecrets: Redact = ({ collection, key, value }) => ({ collection, key, value: JSON.parse(JSON.stringify(value).replaceAll('secret', MASK)) });

/** Every value handed to `compareAndSet`, so tests can prove nothing un-redacted reaches the store. */
function recordingStore(): { store: Store; written: CompareAndSetParams<unknown>[] } {
  const memory = createInMemoryStore();
  const written: CompareAndSetParams<unknown>[] = [];
  return { written, store: { ...memory, compareAndSet: params => { written.push(structuredClone(params)); return memory.compareAndSet(params); } } };
}

describe('createRecordWriter', () => {
  it('creates records once, through redact', async () => {
    const { store, written } = recordingStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue(), redact: maskSecrets });
    expect(await writer.create({ queueKey: 'agent', record: { collection: 'runs', key: 'r1', value: { task: 'secret' } } })).toBe(true);
    expect(await writer.create({ queueKey: 'agent', record: { collection: 'runs', key: 'r1', value: { task: 'again' } } })).toBe(false);
    expect((await store.get('runs', 'r1'))?.value).toEqual({ task: MASK });
    expect(JSON.stringify(written)).not.toContain('secret');
  });

  it('updates records read-modify-write, redacting every new value it writes', async () => {
    const { store, written } = recordingStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue(), redact: maskSecrets });
    const append = (entry: string) => writer.update<string[], string[]>({ queueKey: 'agent', collection: 'feedback', key: 'k', patch: () => [entry], merge: ({ current, patch }) => [...current ?? [], ...patch] });
    await Promise.all([append('secret one'), append('secret two'), append('three')]);
    expect((await store.get<string[]>('feedback', 'k'))?.value.sort()).toEqual([`${MASK} one`, `${MASK} two`, 'three']);
    expect(JSON.stringify(written)).not.toContain('secret');
  });

  it('redacts only the patch, never the stored (already redacted) value again', async () => {
    const { store } = recordingStore();
    // Not idempotent, like hashing or encrypting: applying it twice would compound.
    const wrap: Redact = ({ collection, key, value }) => ({ collection, key, value: (value as string[]).map(entry => `H(${entry})`) });
    const seen: unknown[] = [];
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue(), redact: record => { seen.push(record.value); return wrap(record); } });
    const append = (entry: string) => writer.update<string[], string[]>({ queueKey: 'agent', collection: 'c', key: 'k', patch: () => [entry], merge: ({ current, patch }) => [...current ?? [], ...patch] });
    await append('a');
    await append('b');
    expect((await store.get<string[]>('c', 'k'))?.value).toEqual(['H(a)', 'H(b)']);
    expect(seen).toEqual([['a'], ['b']]);
  });

  it('lets the patch read other records, re-reading them on a compare-and-set retry', async () => {
    const memory = createInMemoryStore();
    let conflicts = 1;
    const store: Store = { ...memory, compareAndSet: async params => (conflicts-- > 0 ? false : memory.compareAndSet(params)) };
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    let reads = 0;
    const stored = await writer.update<{ n: number }, { n: number }>({ queueKey: 'agent', collection: 'c', key: 'k', patch: async () => { reads += 1; return { n: reads }; }, merge: ({ patch }) => patch });
    expect(stored).toEqual({ n: 2 });
    expect((await memory.get('c', 'k'))?.value).toEqual({ n: 2 });
  });

  it('serialises writes per queue key in arrival order', async () => {
    const memory = createInMemoryStore();
    const order: string[] = [];
    const store: Store = { ...memory, compareAndSet: async params => { await new Promise(resolve => setTimeout(resolve, params.key === 'slow' ? 15 : 0)); order.push(params.key); return memory.compareAndSet(params); } };
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    await Promise.all([
      writer.create({ queueKey: 'agent', record: { collection: 'c', key: 'slow', value: 1 } }),
      writer.create({ queueKey: 'agent', record: { collection: 'c', key: 'fast', value: 2 } }),
    ]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('writes nothing when redact throws (fails closed) and rejects with the cause', async () => {
    const { store, written } = recordingStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue(), redact: () => { throw new Error('redactor down'); } });
    await expect(writer.create({ queueKey: 'agent', record: { collection: 'runs', key: 'r1', value: { task: 'secret' } } })).rejects.toThrow('redactor down');
    await expect(writer.update<string, string>({ queueKey: 'agent', collection: 'runs', key: 'r2', patch: () => 'secret', merge: ({ patch }) => patch })).rejects.toThrow('redactor down');
    expect(written).toEqual([]);
  });
});
