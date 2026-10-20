import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { UserFeedbackRecord } from './feedback-records.js';
import { recordUserFeedback } from './user-feedback.js';

const INDEX = { schemaVersion: 1, runId: 'run_1', agentName: 'helper', instanceId: 'i', mode: 'task', agentVersion: 'v', recordedAt: 5, expiresAt: 99, responseId: 'resp_1' };

async function seededStore() {
  const store = createInMemoryStore();
  await store.compareAndSet({ collection: 'responses', key: 'resp_1', expectedVersion: undefined, value: INDEX });
  return { store, writer: createRecordWriter({ store, writeQueue: createWriteQueue() }) };
}

describe('recordUserFeedback', () => {
  it('stores feedback for a run whose record was purged, without recreating the run', async () => {
    const { store, writer } = await seededStore();
    await recordUserFeedback({ store, writer, now: () => 50, feedback: { responseId: 'resp_1', rating: 'correct' } });
    expect((await store.get<UserFeedbackRecord>('feedback', 'resp_1'))?.value).toMatchObject({ rating: 'correct', recordedAt: 50, expiresAt: 99, history: [{ at: 50, rating: 'correct' }] });
    expect(await store.get('runs', 'run_1')).toBeUndefined();
  });

  it('rejects a corrupt index entry, naming it', async () => {
    const store = createInMemoryStore();
    await store.compareAndSet({ collection: 'responses', key: 'resp_1', expectedVersion: undefined, value: { responseId: 'resp_1' } });
    const writer = createRecordWriter({ store, writeQueue: createWriteQueue() });
    await expect(recordUserFeedback({ store, writer, now: () => 1, feedback: { responseId: 'resp_1', rating: 'correct' } })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining("'responses/resp_1'") }));
  });

  it('validates before touching the store', async () => {
    const { store, writer } = await seededStore();
    await expect(recordUserFeedback({ store, writer, now: () => 1, feedback: { responseId: 'resp_1', rating: 'meh' } })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(await store.get('feedback', 'resp_1')).toBeUndefined();
  });
});
