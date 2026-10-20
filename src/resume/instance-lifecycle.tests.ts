import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAigent } from '../core/create-aigent.js';
import { createTimerSleeper } from '../core/runtime-services.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import { INSTANCES_COLLECTION, LEASES_COLLECTION } from './checkpoint-types.js';
import type { LeaseRecord } from './lease.js';

const definition = (instanceId?: string) => ({ name: 'worker', model: 'fake:m', tools: [], todo: false, ...(instanceId == null ? {} : { instanceId }) });

describe('agent instances and their leases', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens nothing for an agent without an instanceId until it runs', async () => {
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [createFakeProvider({ turns: [textTurn('done')] })], store, enableFeedback: false, resume: {} });
    const agents = Array.from({ length: 5 }, () => ai.agent(definition()));
    await Promise.all(agents.map(({ ready }) => ready));
    expect(await store.list(LEASES_COLLECTION)).toHaveLength(0);
    expect(await store.list(INSTANCES_COLLECTION)).toHaveLength(0);
    expect(agents[0]?.resume()).toBeUndefined();
    await agents[0]?.task({ task: 't' });
    expect(await store.list(LEASES_COLLECTION)).toHaveLength(1);
    await ai.close();
  });

  it('releases the lease when opening fails, so the instance is not locked by a dead open', async () => {
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [createFakeProvider({ turns: [] })], store, enableFeedback: false, resume: {} });
    await ai.agent(definition('shared')).ready;
    await ai.close();
    const other = createAigent({ providers: [createFakeProvider({ turns: [] })], store, enableFeedback: false, resume: {} });
    await expect(other.agent({ ...definition('shared'), name: 'someone-else' }).ready).rejects.toMatchObject({ code: 'invalid_input' });
    const lease = (await store.get<LeaseRecord>(LEASES_COLLECTION, 'shared'))?.value;
    expect(lease?.expiresAt).toBeLessThanOrEqual(Date.now());
    await other.close();
  });

  it('agent.close() releases its instance at once, so another runtime can take it over', async () => {
    const store = createInMemoryStore();
    const ai = createAigent({ providers: [createFakeProvider({ turns: [] })], store, enableFeedback: false, resume: {} });
    const held = ai.agent(definition('handover'));
    await held.ready;
    await held.close();
    const other = createAigent({ providers: [createFakeProvider({ turns: [] })], store, enableFeedback: false, resume: {} });
    await expect(other.agent(definition('handover')).ready).resolves.toBeUndefined();
    await Promise.all([ai.close(), other.close()]);
  });

  it('uses heartbeat timers that do not keep the process alive', async () => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => { const timer = realSetTimeout(handler, ms); timers.push(timer); return timer; }) as typeof setTimeout);
    const controller = new AbortController();
    const slept = createTimerSleeper({ unref: true })(60_000, controller.signal);
    expect(timers.at(-1)?.hasRef()).toBe(false);
    controller.abort();
    await slept;
  });
});
