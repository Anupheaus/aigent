import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { CHECKPOINT_HEADS_COLLECTION, CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import type { CheckpointHead, RunState } from './checkpoint-types.js';
import { checkpointHarness, countingStore, message, runState } from './checkpoint.test-support.js';
import { checkpointKey, readLatestCheckpoint } from './checkpoint-reader.js';
import { migrateCheckpoint } from './migrations.js';

const read = (store: Parameters<typeof readLatestCheckpoint>[0]['store']) => readLatestCheckpoint({ store, instanceId: 'inst', streamId: 'run1' });

describe('checkpoint writer and reader', () => {
  it('round-trips the latest state, written through the queue and redact', async () => {
    const { store, writer } = checkpointHarness({ redact: record => record });
    await writer.write({ boundary: 'start', state: runState([message(0)]) });
    await writer.write({ boundary: 'turn-complete', state: runState([message(0), message(1)], { status: 'running' }) });
    const latest = await read(store);
    expect(latest).toMatchObject({ seq: 2, boundary: 'turn-complete', instanceId: 'inst', runId: 'run1', fence: 1, schemaVersion: 1 });
    expect(latest?.state).toEqual(runState([message(0), message(1)]));
    expect(await read(createInMemoryStore())).toBeUndefined();
  });

  it('writes a snapshot every snapshotEvery records, a delta of appended messages otherwise, and a snapshot when history was rewritten', async () => {
    const { store, writer } = checkpointHarness({ options: { snapshotEvery: 3, keepSnapshots: 10 } });
    const messages = [message(0)];
    for (let index = 1; index <= 5; index += 1) {
      messages.push(message(index));
      await writer.write({ boundary: 'turn-complete', state: runState([...messages]) });
    }
    // A compaction rewrites earlier messages: no longer append-only.
    await writer.write({ boundary: 'compaction', state: runState([message(0, 'summary'), message(5)]) });
    const records = await store.list<{ seq: number; isSnapshot: boolean; messagesFrom?: number; state: RunState }>(CHECKPOINTS_COLLECTION);
    expect(records.map(({ value: { seq, isSnapshot, messagesFrom } }) => ({ seq, isSnapshot, messagesFrom }))).toEqual([
      { seq: 1, isSnapshot: true, messagesFrom: undefined }, { seq: 2, isSnapshot: false, messagesFrom: 2 }, { seq: 3, isSnapshot: false, messagesFrom: 3 },
      { seq: 4, isSnapshot: true, messagesFrom: undefined }, { seq: 5, isSnapshot: false, messagesFrom: 5 }, { seq: 6, isSnapshot: true, messagesFrom: undefined },
    ]);
    expect(records[1]?.value.state.context.messages).toHaveLength(1);
    expect((await read(store))?.state).toEqual(runState([message(0, 'summary'), message(5)]));
  });

  it('prunes records older than the kept snapshots, and restores from snapshot plus tail with bounded reads', async () => {
    const counted = countingStore();
    const { writer } = checkpointHarness({ store: counted.store, options: { snapshotEvery: 5, keepSnapshots: 2 } });
    const messages = [message(0)];
    for (let index = 1; index <= 23; index += 1) {
      messages.push(message(index));
      await writer.write({ boundary: 'turn-complete', state: runState([...messages]) });
    }
    const stored = await counted.store.list<{ seq?: number; isDeleted?: boolean }>(CHECKPOINTS_COLLECTION);
    // Snapshots at 1, 6, 11, 16, 21: the last two are kept with what follows them.
    expect(stored.filter(({ value }) => value.isDeleted !== true).map(({ value: { seq } }) => seq)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    // Pruned records keep no content: a store delete cannot be conditional, so the fenced store leaves a tombstone.
    expect(stored.filter(({ value }) => value.isDeleted === true).map(({ value }) => Object.keys(value).sort())).toEqual(Array.from({ length: 15 }, () => ['isDeleted', 'leaseFence']));
    const head = await counted.store.get<CheckpointHead>(CHECKPOINT_HEADS_COLLECTION, 'inst:run1');
    expect(head?.value.snapshots).toEqual([16, 21]);
    const before = counted.reads();
    expect((await read(counted.store))?.state).toEqual(runState(messages));
    // The head, the latest snapshot and its two-record tail.
    expect(counted.reads() - before).toBe(4);
  });

  it('property: the latest snapshot plus its tail equals the last state written', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(fc.constant('append' as const), fc.constant('rewrite' as const), fc.constant('same' as const)), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 1, max: 6 }),
      async (steps, snapshotEvery) => {
        const { store, writer } = checkpointHarness({ options: { snapshotEvery, keepSnapshots: 1 } });
        let messages = [message(0)];
        let last = runState(messages);
        for (const [index, step] of steps.entries()) {
          if (step === 'append') messages = [...messages, message(messages.length)];
          if (step === 'rewrite') messages = [message(0, `rewritten ${index}`), ...messages.slice(2)];
          last = runState(messages, { totals: { ...runState([]).totals, turns: index } });
          await writer.write({ boundary: 'turn-complete', state: last });
        }
        expect((await read(store))?.state).toEqual(last);
      },
    ), { numRuns: 60 });
  });

  it('never writes a record from a stale fence or over an existing seq', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'leases', key: 'inst', expectedVersion: undefined, value: { instanceId: 'inst', ownerId: 'b', fence: 2, expiresAt: 0 } });
    const { writer } = checkpointHarness({ store, fence: 1 });
    await expect(writer.write({ boundary: 'start', state: runState([]) })).rejects.toMatchObject({ code: 'store_conflict', details: { fenced: true } });
    expect(await store.list(CHECKPOINTS_COLLECTION)).toEqual([]);
  });
});

describe('migrateCheckpoint', () => {
  it('upgrades a v0 record to v1 and reads it back through the reader', async () => {
    const state = runState([message(0)]);
    const v0 = { version: 0, instanceId: 'inst', streamId: 'run1', seq: 1, kind: 'start', at: 3, state };
    expect(migrateCheckpoint(v0)).toEqual({ schemaVersion: 1, instanceId: 'inst', runId: 'run1', seq: 1, boundary: 'start', at: 3, fence: 0, isSnapshot: true, state });
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: CHECKPOINTS_COLLECTION, key: checkpointKey({ instanceId: 'inst', streamId: 'run1', seq: 1 }), expectedVersion: undefined, value: v0 });
    await store.compareAndSet({ collection: CHECKPOINT_HEADS_COLLECTION, key: 'inst:run1', expectedVersion: undefined, value: { instanceId: 'inst', streamId: 'run1', kind: 'run', latestSeq: 1, snapshots: [1], updatedAt: 3 } });
    expect((await read(store))?.state).toEqual(state);
  });

  it('refuses unknown versions and non-records', () => {
    expect(() => migrateCheckpoint({ schemaVersion: 9 })).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('version 9') }));
    expect(() => migrateCheckpoint('x')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});
