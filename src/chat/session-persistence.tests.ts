import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
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
});
