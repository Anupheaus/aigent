import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import type { TaskResult } from './agent-types.js';
import type { ProviderTarget } from './open-turn-stream.js';
import { buildRunRecord, writeRunRecord } from './run-record.js';
import type { RunRecord } from './run-record.js';

const RESULT: TaskResult = {
  status: 'completed', answer: 'ok', runId: 'run_1', agentName: 'helper', instanceId: 'agent_1', errors: [],
  usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, turns: 1, toolCalls: 0, toolCallsPerTurn: 0, retries: 0, fallbacks: 0, durationMs: 5 },
};

function target(overrides: Partial<ProviderTarget> & Pick<ProviderTarget, 'label'>): ProviderTarget {
  return { provider: createFakeProvider({ turns: [] }), model: 'm', warnings: [], dropped: [], ...overrides };
}

describe('buildRunRecord', () => {
  it('records what the primary was sent, its dropped keys, runtime-only settings and the run identity', () => {
    const record = buildRunRecord({
      input: { task: 'x', label: 'nightly', scope: { tenant: 't1' } },
      result: RESULT,
      agent: { agentVersion: 'abc', version: 'v2' },
      targets: {
        primary: target({ label: 'fake:m', settings: { temperature: 0.2 }, dropped: ['seed'] }),
        fallbacks: [],
        runtimeSettings: { temperature: 0.2, seed: 1, contextSize: 8_000, showThinking: false },
      },
      startedAt: 100,
    });
    expect(record).toEqual({
      runId: 'run_1', agentName: 'helper', instanceId: 'agent_1', agentVersion: 'abc', model: 'fake:m',
      settings: { temperature: 0.2 }, droppedSettings: ['seed'], runtimeSettings: { contextSize: 8_000, showThinking: false },
      version: 'v2', label: 'nightly', scope: { tenant: 't1' }, status: 'completed', usage: RESULT.usage, startedAt: 100,
    } satisfies RunRecord);
  });

  it('records {} settings and leaves optional fields out when nothing was set', () => {
    const record = buildRunRecord({ input: { task: 'x' }, result: RESULT, agent: { agentVersion: 'abc' }, targets: { primary: target({ label: 'fake:m' }), fallbacks: [], runtimeSettings: {} }, startedAt: 1 });
    expect(record.settings).toEqual({});
    for (const field of ['droppedSettings', 'runtimeSettings', 'fallbacks', 'version', 'label', 'scope']) expect(record).not.toHaveProperty(field);
  });

  it('records each fallback the run used with what it was sent', () => {
    const record = buildRunRecord({
      input: { task: 'x' }, result: RESULT, agent: { agentVersion: 'abc' }, startedAt: 1,
      targets: {
        primary: target({ label: 'a:m', settings: { maxOutputTokens: 10 } }),
        fallbacks: [target({ label: 'b:m', settings: { maxOutputTokens: 10 }, dropped: ['temperature'] }), target({ label: 'c:m' })],
        runtimeSettings: {},
      },
    });
    expect(record.fallbacks).toEqual([
      { model: 'b:m', settings: { maxOutputTokens: 10 }, droppedSettings: ['temperature'] },
      { model: 'c:m', settings: {} },
    ]);
  });
});

describe('writeRunRecord', () => {
  const record = buildRunRecord({ input: { task: 'x' }, result: RESULT, agent: { agentVersion: 'abc' }, targets: { primary: target({ label: 'fake:m' }), fallbacks: [], runtimeSettings: {} }, startedAt: 1 });

  it('writes nothing and warns about nothing without a store', async () => {
    expect(await writeRunRecord({ writeQueue: createWriteQueue(), record })).toBeUndefined();
  });

  it('writes the record to the runs collection under its run id', async () => {
    const store = createInMemoryStore();
    expect(await writeRunRecord({ store, writeQueue: createWriteQueue(), record })).toBeUndefined();
    expect((await store.get('runs', 'run_1'))?.value).toEqual(record);
  });

  it('returns a warning, never throwing, when the record already exists', async () => {
    const store = createInMemoryStore();
    const writeQueue = createWriteQueue();
    await writeRunRecord({ store, writeQueue, record });
    expect(await writeRunRecord({ store, writeQueue, record })).toBe("Run record 'run_1' for agent 'helper' was not written: a record with that id already exists");
  });

  it('returns a warning naming the cause when the store fails', async () => {
    const failing: Store = { ...createInMemoryStore(), compareAndSet: async () => { throw new Error('disk full'); } };
    expect(await writeRunRecord({ store: failing, writeQueue: createWriteQueue(), record })).toBe("Run record 'run_1' for agent 'helper' could not be written: disk full");
  });
});
