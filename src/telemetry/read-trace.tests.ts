import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { readTrace } from './read-trace.js';

const META = { schemaVersion: 1, runId: 'r1', agentName: 'a', instanceId: 'i', mode: 'task', agentVersion: 'v', recordedAt: 1 };
const RUN = {
  ...META, responseId: 'resp_1', model: 'fake:m', settings: {}, unattended: false, status: 'completed',
  usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, turns: 1, toolCalls: 0, toolCallsPerTurn: 0, retries: 0, fallbacks: 0, durationMs: 1 },
  timings: { startedAt: 0, durationMs: 1, modelMs: 1, toolMs: 0, queuedMs: 0 }, stepCount: 0, failureCount: 0,
};

describe('readTrace', () => {
  it('returns undefined without a store or for an unknown run', async () => {
    expect(await readTrace({ runId: 'r1' })).toBeUndefined();
    expect(await readTrace({ store: createInMemoryStore(), runId: 'r1' })).toBeUndefined();
  });

  it('returns the run with no steps when its trace was not stored', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'runs', key: 'r1', expectedVersion: undefined, value: RUN });
    expect(await readTrace({ store, runId: 'r1' })).toEqual({ run: RUN, steps: [] });
  });

  it('rejects a stored run that does not match the schema, naming it', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'runs', key: 'r1', expectedVersion: undefined, value: { ...RUN, usage: undefined } });
    await expect(readTrace({ store, runId: 'r1' })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(/'runs\/r1'.*usage/) }));
  });
});
