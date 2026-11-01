import { describe, expect, it } from 'vitest';
import { createSystemClock, createUuidGenerator } from '../core/runtime-services.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import { createEffectLog } from './effect-log.js';
import { EFFECTS_COLLECTION } from './undo-types.js';

describe('effect log reads', () => {
  it('lists only the agent\'s effect entries, asking the store for just those', async () => {
    const base = createInMemoryStore();
    const seen: unknown[] = [];
    const store: Store = { ...base, list: (collection, options) => { seen.push({ collection, options }); return base.list(collection, options); } };
    const log = createEffectLog({ store, writer: createRecordWriter({ store, writeQueue: createWriteQueue() }), clock: createSystemClock(), ids: createUuidGenerator() });
    const effect = { callId: 'c1', tool: 'write' };
    await log.append({ effect, effectId: 'mine', agentName: 'a', instanceId: 'i', runId: 'r' });
    await log.append({ effect, effectId: 'theirs', agentName: 'b', instanceId: 'i', runId: 'r' });
    const [mine] = await log.effects('a');
    await log.recordUndo({ effect: mine ?? (() => { throw new Error('no effect'); })(), ok: true });
    expect((await log.effects('a')).map(({ effectId, status }) => ({ effectId, status }))).toEqual([{ effectId: 'mine', status: 'undone' }]);
    expect(seen.at(-1)).toEqual({ collection: EFFECTS_COLLECTION, options: { where: { kind: 'effect', agentName: 'a' } } });
  });
});
