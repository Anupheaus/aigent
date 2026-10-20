import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import { createCallLedger, idempotencyKeyOf, loadCallLedger } from './call-ledger.js';
import { CALLS_COLLECTION } from './checkpoint-types.js';

function setup(store: Store = createInMemoryStore()) {
  const records = createRecordWriter({ store, writeQueue: createWriteQueue() });
  const ledger = createCallLedger({ records, runId: 'run1', clock: { now: () => 7 } });
  return { store, ledger };
}

const call = (callId: string) => ({ callId, tool: 'write_file', args: { path: callId }, argsHash: `h-${callId}`, turn: 1 });

describe('call ledger', () => {
  it('records started before it resolves, then done with the envelope', async () => {
    const { store, ledger } = setup();
    const started = await ledger.begin(call('c1'));
    expect(started).toMatchObject({ callId: 'c1', status: 'started', idempotencyKey: 'run1:c1', startedAt: 7 });
    expect((await loadCallLedger({ store, runId: 'run1' })).map(({ callId, status }) => ({ callId, status }))).toEqual([{ callId: 'c1', status: 'started' }]);
    await ledger.complete('c1', { id: 'c1', tool: 'write_file', ok: true, result: 'ok' });
    expect(ledger.get('c1')).toMatchObject({ status: 'done', envelope: { ok: true, result: 'ok' }, finishedAt: 7 });
    expect(await loadCallLedger({ store, runId: 'run1' })).toEqual(ledger.entries());
  });

  it('records a failure and keeps entries in begin order whatever order they finish in', async () => {
    const { store, ledger } = setup();
    await ledger.begin(call('a'));
    await ledger.begin(call('b'));
    await ledger.fail('b', { category: 'thrown', code: 'tool_threw', message: 'disk full', retryable: false });
    await ledger.complete('a', { id: 'a', tool: 'write_file', ok: true, result: 1 });
    expect((await loadCallLedger({ store, runId: 'run1' })).map(({ callId, status, envelope }) => ({ callId, status, ok: envelope?.ok }))).toEqual([
      { callId: 'a', status: 'done', ok: true }, { callId: 'b', status: 'failed', ok: false },
    ]);
  });

  it('rejects begin when the entry cannot be stored, so the caller never runs the tool', async () => {
    const store = createInMemoryStore();
    const broken: Store = { ...store, compareAndSet: async () => { throw new Error('disk gone'); } };
    const { ledger } = setup(broken);
    let ran = false;
    await expect(ledger.begin(call('c1')).then(() => { ran = true; })).rejects.toThrow('disk gone');
    expect(ran).toBe(false);
    expect(await store.list(CALLS_COLLECTION)).toEqual([]);
  });

  it('continues a loaded ledger and derives idempotency keys from the run and call', async () => {
    const { store, ledger } = setup();
    await ledger.begin(call('a'));
    const records = createRecordWriter({ store, writeQueue: createWriteQueue() });
    const resumed = createCallLedger({ records, runId: 'run1', clock: { now: () => 9 }, loaded: await loadCallLedger({ store, runId: 'run1' }) });
    expect(resumed.get('a')?.status).toBe('started');
    await resumed.complete('a', { id: 'a', tool: 'write_file', ok: true, result: 2 });
    expect((await loadCallLedger({ store, runId: 'run1' }))[0]?.status).toBe('done');
    expect(idempotencyKeyOf({ runId: 'r', callId: 'c' })).toBe('r:c');
  });
});
