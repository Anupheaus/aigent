import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AigentEvent } from '../core/aigent-events.js';
import { createAigent } from '../core/create-aigent.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { LEASES_COLLECTION } from './checkpoint-types.js';
import type { LeaseRecord } from './lease.js';

const INSTANCE = 'lost-1';
/** Short, so the real heartbeat timer notices the takeover within a few milliseconds. */
const TTL_MS = 30;

/** Another process takes the instance over: the lease gets a higher fence and another owner. */
async function stealLease(store: Store): Promise<void> {
  const stored = await store.get<LeaseRecord>(LEASES_COLLECTION, INSTANCE);
  await store.compareAndSet<LeaseRecord>({ collection: LEASES_COLLECTION, key: INSTANCE, expectedVersion: stored?.version, value: { instanceId: INSTANCE, ownerId: 'thief', fence: (stored?.value.fence ?? 0) + 1, expiresAt: Number.MAX_SAFE_INTEGER } });
}

async function runUntilLost(onLeaseLost?: 'immediate' | 'graceful') {
  const store = createInMemoryStore();
  // Waits (until its run is stopped) once the lease is gone, so the heartbeat is what ends the run.
  const wait = defineTool({
    name: 'wait', description: 'Wait', args: z.object({}).strict(), deterministic: false, cache: false, describeActivity: () => ({ title: 'wait' }),
    run: async (_args, { signal }) => {
      await stealLease(store);
      await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 500); });
      return 'waited';
    },
  });
  const provider = createFakeProvider({ turns: [toolTurn([{ id: 'w1', name: 'wait', args: {} }]), textTurn('done'), textTurn('done')] });
  const ai = createAigent({ providers: [provider], store, enableFeedback: false, resume: { lease: { ttlMs: TTL_MS }, ...(onLeaseLost == null ? {} : { onLeaseLost }) } });
  const run = ai.agent({ name: 'waiter', model: 'fake:m', tools: [wait], instanceId: INSTANCE, todo: false }).task({ task: 'wait' });
  const events: AigentEvent[] = [];
  for await (const event of run) events.push(event);
  const result = await run;
  await ai.close();
  return { result, events, provider };
}

describe('a lost lease', () => {
  it('stops the instance\'s runs at once by default, with a warning', async () => {
    const { result, events } = await runUntilLost();
    expect(result.status).toBe('cancelled');
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', message: expect.stringContaining(`lease of agent instance '${INSTANCE}' was lost`) }));
  });

  it('stops them at the next safe boundary with onLeaseLost graceful', async () => {
    const { result, provider } = await runUntilLost('graceful');
    expect(result.status).toBe('stopped');
    expect(provider.requests).toHaveLength(1);
  });
});
