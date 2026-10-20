import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { persistRun } from './persist-run.js';
import { createRecordWriter } from './record-writer.js';

const RECORDS = [
  { collection: 'runs', key: 'run_1', value: { runId: 'run_1' } },
  { collection: 'traces', key: 'run_1', value: { runId: 'run_1', steps: [] } },
];

describe('persistRun', () => {
  it('writes every record and reports no warning', async () => {
    const store = createInMemoryStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    expect(await persistRun({ writer, queueKey: 'helper', records: RECORDS })).toBeUndefined();
    expect((await store.get('runs', 'run_1'))?.value).toEqual({ runId: 'run_1' });
    expect((await store.get('traces', 'run_1'))?.value).toEqual({ runId: 'run_1', steps: [] });
  });

  it('writes nothing and warns about nothing without a writer (no store)', async () => {
    expect(await persistRun({ queueKey: 'helper', records: RECORDS })).toBeUndefined();
  });

  it('turns store failures into one warning naming each record and cause, still writing the rest', async () => {
    const memory = createInMemoryStore();
    const store: Store = { ...memory, compareAndSet: async params => { if (params.collection === 'runs') throw new Error('disk full'); return memory.compareAndSet(params); } };
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    expect(await persistRun({ writer, queueKey: 'helper', records: RECORDS })).toBe("Could not save run record: 'runs/run_1' failed: disk full");
    expect(await memory.get('traces', 'run_1')).toBeDefined();
  });

  it('warns when a record already exists', async () => {
    const store = createInMemoryStore();
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    await persistRun({ writer, queueKey: 'helper', records: RECORDS });
    expect(await persistRun({ writer, queueKey: 'helper', records: RECORDS })).toBe("Could not save run record: 'runs/run_1' already exists; 'traces/run_1' already exists");
  });
});
