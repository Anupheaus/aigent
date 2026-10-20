import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentEvent } from '../core/aigent-events.js';
import { createAigent } from '../core/create-aigent.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { CHECKPOINT_HEADS_COLLECTION, CHECKPOINTS_COLLECTION } from './checkpoint-types.js';
import type { CheckpointHead } from './checkpoint-types.js';
import { crashableStore, createWorld, definitionFor, INSTANCE_ID, LEASE_TTL_MS, runtimeOver, scriptedProvider, worldTools } from './crash-injection.test-support.js';
import { checkpointHarness, message, runState } from './checkpoint.test-support.js';
import { checkpointKey, readLatestCheckpoint } from './checkpoint-reader.js';

const read = (store: Store) => readLatestCheckpoint({ store, instanceId: 'inst', streamId: 'run1' });

/** A store whose checkpoint record writes fail `failures` times in a row once armed. */
function failingCheckpoints() {
  const base = createInMemoryStore();
  const state = { failures: 0 };
  const store: Store = {
    ...base, get: base.get, list: base.list, delete: base.delete,
    compareAndSet: async write => {
      if (write.collection === CHECKPOINTS_COLLECTION && state.failures > 0) { state.failures -= 1; throw new Error('transient store failure'); }
      return base.compareAndSet(write);
    },
  };
  return { store, state };
}

describe('checkpoint write failures', () => {
  it('retries a transient failure, so one blip loses nothing', async () => {
    const { store, state } = failingCheckpoints();
    const { writer } = checkpointHarness({ store });
    await writer.write({ boundary: 'start', state: runState([message(1)]) });
    state.failures = 1;
    await writer.write({ boundary: 'approval', state: runState([message(1), message(2)]) });
    expect((await read(store))?.state).toEqual(runState([message(1), message(2)]));
  });

  it('never leaves a gap: a write that fails for good gives back its seq, and later checkpoints stay readable', async () => {
    const { store, state } = failingCheckpoints();
    const { writer } = checkpointHarness({ store });
    await writer.write({ boundary: 'start', state: runState([message(1)]) });
    state.failures = 100;
    await expect(writer.write({ boundary: 'approval', state: runState([message(1), message(2)]) })).rejects.toThrow('transient store failure');
    state.failures = 0;
    await writer.write({ boundary: 'turn-complete', state: runState([message(1), message(2), message(3)]) });
    await writer.write({ boundary: 'turn-complete', state: runState([message(1), message(2), message(3), message(4)]) });
    const latest = await read(store);
    expect(latest).toMatchObject({ seq: 3 });
    expect(latest?.state).toEqual(runState([message(1), message(2), message(3), message(4)]));
  });

  it('says so explicitly when records before the head are missing, instead of quietly returning an older state', async () => {
    const { store, writer } = checkpointHarness({ options: { snapshotEvery: 10 } });
    for (let seq = 1; seq <= 4; seq += 1) await writer.write({ boundary: 'turn-complete', state: runState(Array.from({ length: seq }, (_unused, index) => message(index + 1))) });
    await store.delete?.(CHECKPOINTS_COLLECTION, checkpointKey({ instanceId: 'inst', streamId: 'run1', seq: 3 }));
    const latest = await read(store);
    expect(latest).toMatchObject({ seq: 2, stale: { missingSeq: 3, latestSeq: 4 } });
  });
});

describe('resuming from a stale checkpoint', () => {
  it('warns that later checkpoints are missing', async () => {
    const base = createInMemoryStore();
    const process = crashableStore({ store: base });
    let now = 1_000;
    const tools = (isFirst: boolean) => worldTools({ world: createWorld(), beforeRun: tool => { if (isFirst && tool === 'read_file') { process.crash(); throw new Error('crash'); } } });
    const first = runtimeOver({ store: process.store, provider: scriptedProvider(), now: () => now });
    const { runId } = await first.agent(definitionFor(tools(true))).task({ task: 'Save two notes and read a.txt', unattended: true }).then(result => result, () => ({ runId: '' }));
    await first.close().catch(() => undefined);
    const [stored] = (await base.list<CheckpointHead>(CHECKPOINT_HEADS_COLLECTION)).filter(({ value: { streamId } }) => runId === '' || streamId === runId);
    expect(stored).toBeDefined();
    // The head names a record that is not there (it was lost outside the library).
    const { key, version, value: head } = stored!;
    await base.compareAndSet({ collection: CHECKPOINT_HEADS_COLLECTION, key, expectedVersion: version, value: { ...head, latestSeq: head.latestSeq + 1 } });
    now += LEASE_TTL_MS + 1;
    const second = runtimeOver({ store: base, provider: scriptedProvider(), now: () => now });
    const agent = second.agent(definitionFor(tools(false)));
    await agent.ready;
    const run = agent.resume()!;
    const events = [];
    for await (const event of run) events.push(event);
    await second.close();
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('missing') });
  });
});

describe('a pending approval whose checkpoint cannot be written', () => {
  it('still asks, and warns that the request will not survive a restart', async () => {
    const base = createInMemoryStore();
    // Only the approval's checkpoint fails: every other write works.
    const isApproval = (value: unknown): boolean => (value as { boundary?: unknown }).boundary === 'approval';
    const store: Store = { ...base, get: base.get, list: base.list, delete: base.delete, compareAndSet: async write => { if (write.collection === CHECKPOINTS_COLLECTION && isApproval(write.value)) throw new Error('store down'); return base.compareAndSet(write); } };
    const tool = defineTool({ name: 'wipe', description: 'Wipe', args: z.object({}).strict(), deterministic: false, cache: false, hasSideEffects: true, requiresApproval: true, describeActivity: () => ({ title: 'wipe' }), run: async () => 'wiped' });
    const ai = createAigent({ providers: [createFakeProvider({ turns: [toolTurn([{ id: 'w1', name: 'wipe', args: {} }]), textTurn('done')] })], store, enableFeedback: false, resume: { lease: false } });
    const agent = ai.agent({ name: 'wiper', model: 'fake:m', tools: [tool], instanceId: 'wipe-1', todo: false });
    const run = agent.task({ task: 'wipe' });
    const events: AigentEvent[] = [];
    for await (const event of run) {
      events.push(event);
      if (event.type === 'approval-request') void agent.approve(event.requestId, { decision: 'allow_once' });
    }
    await run;
    await ai.close();
    expect(events).toContainEqual({ type: 'warning', message: expect.stringContaining('will not survive a restart') });
  });
});
