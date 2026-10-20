import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import { createPatchLog } from './apply-patch.js';
import { createEmptyConversation } from './conversation.js';
import { CHATS_COLLECTION, createSessionWriter, loadSession, PATCHES_PER_CHUNK } from './session-persistence.js';
import type { ChatSessionRecord } from './session-persistence.js';

const KEY = { agentName: 'helper', sessionId: 's1' };
const PATCH_COUNT = 250;

describe('session persistence', () => {
  it('writes patches in chunks of 100 with a snapshot at each boundary, and loads the snapshot plus the later patches exactly', async () => {
    const store = createInMemoryStore();
    const writer = createSessionWriter({ writer: createRecordWriter({ store, writeQueue: createWriteQueue() }), key: KEY, instanceId: 'i1' });
    const log = createPatchLog({ base: createEmptyConversation(KEY), now: () => 5 });
    log.subscribe(patch => writer.append(patch, log.state()));
    for (let index = 0; index < PATCH_COUNT; index += 1) log.append({ type: 'title-updated', title: `t${index}` });
    expect(await writer.flush()).toEqual([]);
    const loaded = await loadSession({ store, key: KEY });
    // Only the chunk after the snapshot is read: restore cost does not grow with the session.
    expect(loaded?.patches).toEqual(log.patches(2 * PATCHES_PER_CHUNK + 1));
    expect(loaded?.record).toMatchObject({ schemaVersion: 1, sessionId: 's1', agentName: 'helper', instanceId: 'i1', seq: 2 * PATCHES_PER_CHUNK });
    expect(loaded?.record.snapshot?.title).toBe(`t${2 * PATCHES_PER_CHUNK - 1}`);
    expect((await store.list(CHATS_COLLECTION)).map(({ key }) => key).sort()).toEqual(['helper:s1', 'helper:s1:0', 'helper:s1:1', 'helper:s1:2']);
    const restored = createPatchLog({ base: createEmptyConversation(KEY), history: loaded!.patches, snapshot: loaded!.record.snapshot!, now: () => 6 });
    expect(restored.state()).toEqual(log.state());
  });

  it('passes every write through redact and reports failed writes from flush', async () => {
    const store = createInMemoryStore();
    const redact = ({ value, ...rest }: { collection: string; key: string; value: unknown }) => {
      if (rest.key.endsWith(':0')) throw new Error('redact refused');
      return { ...rest, value: { ...(value as ChatSessionRecord), redacted: true } };
    };
    const writer = createSessionWriter({ writer: createRecordWriter({ store, writeQueue: createWriteQueue(), redact }), key: KEY, instanceId: 'i1' });
    const log = createPatchLog({ base: createEmptyConversation(KEY), now: () => 5 });
    log.subscribe(patch => writer.append(patch, log.state()));
    log.append({ type: 'title-updated', title: 'x' });
    expect(await writer.flush()).toEqual(['redact refused']);
    expect((await store.get(CHATS_COLLECTION, 'helper:s1'))?.value).toMatchObject({ redacted: true });
  });

  it('stops writing at the first failed patch, so the store never holds a hole or a snapshot ahead of its patches', async () => {
    const store = failingWhen(patches => patches.some(({ seq }) => seq === 3));
    const writer = createSessionWriter({ writer: createRecordWriter({ store, writeQueue: createWriteQueue() }), key: KEY, instanceId: 'i1' });
    const log = createPatchLog({ base: createEmptyConversation(KEY), now: () => 5 });
    log.subscribe(patch => writer.append(patch, log.state()));
    log.append({ type: 'title-updated', title: 'a' });
    log.append({ type: 'title-updated', title: 'b' });
    expect(await writer.flush()).toEqual([]);
    log.append({ type: 'title-updated', title: 'c' });
    expect(await writer.flush()).toEqual(['chunk write refused']);
    log.append({ type: 'title-updated', title: 'd' });
    log.append({ type: 'title-updated', title: 'e' });
    writer.snapshot(log.state());
    await writer.flush();
    expect(writer.failedSeqs()).toEqual([3, 4, 5]);
    const loaded = await loadSession({ store, key: KEY });
    expect(loaded?.patches.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(loaded?.record.seq).toBe(1);
  });

  it('refuses to load a stored history with a hole instead of replaying it silently', async () => {
    const store = createInMemoryStore();
    const writer = createSessionWriter({ writer: createRecordWriter({ store, writeQueue: createWriteQueue() }), key: KEY, instanceId: 'i1' });
    const log = createPatchLog({ base: createEmptyConversation(KEY), now: () => 5 });
    log.subscribe(patch => writer.append(patch, log.state()));
    for (const title of ['a', 'b', 'c']) log.append({ type: 'title-updated', title });
    await writer.flush();
    const chunk = await store.get<{ patches: { seq: number }[] }>(CHATS_COLLECTION, 'helper:s1:0');
    await store.compareAndSet({ collection: CHATS_COLLECTION, key: 'helper:s1:0', expectedVersion: chunk!.version, value: { ...chunk!.value, patches: chunk!.value.patches.filter(({ seq }) => seq !== 2) } });
    await expect(loadSession({ store, key: KEY })).rejects.toMatchObject({ code: 'store_failed', message: expect.stringMatching(/session 'helper:s1'.*patch 2 is missing/) });
  });
});

/** An in-memory store whose chat chunk writes fail while `refuse` says so. */
function failingWhen(refuse: (patches: { seq: number }[]) => boolean): Store {
  const store = createInMemoryStore();
  return {
    ...store,
    compareAndSet: async params => {
      const { patches } = params.value as { patches?: { seq: number }[] };
      if (patches != null && refuse(patches)) throw new Error('chunk write refused');
      return store.compareAndSet(params);
    },
  };
}
