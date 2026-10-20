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

  it('updates records read-modify-write, redacting every value it writes', async () => {
    const { store, written } = recordingStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue(), redact: maskSecrets });
    const append = (entry: string) => writer.update<string[]>({ queueKey: 'agent', collection: 'feedback', key: 'k', update: current => [...current ?? [], entry] });
    await Promise.all([append('secret one'), append('secret two'), append('three')]);
    expect((await store.get<string[]>('feedback', 'k'))?.value.sort()).toEqual([`${MASK} one`, `${MASK} two`, 'three']);
    expect(JSON.stringify(written)).not.toContain('secret');
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
    await expect(writer.update({ queueKey: 'agent', collection: 'runs', key: 'r2', update: () => 'secret' })).rejects.toThrow('redactor down');
    expect(written).toEqual([]);
  });
});
