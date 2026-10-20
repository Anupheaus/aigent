import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { ConversationState } from './conversation.js';
import type { Patch } from './patches.js';

/** Store collection of chat sessions: one session record plus the patch chunks. */
export const CHATS_COLLECTION = 'chats';
export const CHAT_SCHEMA_VERSION = 1;
/** Patches per chunk record; the session record's snapshot is refreshed at each chunk boundary. */
export const PATCHES_PER_CHUNK = 100;

/** The session record (`<agentName>:<sessionId>`). */
export interface ChatSessionRecord {
  schemaVersion: typeof CHAT_SCHEMA_VERSION;
  sessionId: string;
  agentName: string;
  instanceId: string;
  /** Seq of the last patch written with the snapshot. */
  seq: number;
  /** The conversation at `seq`, written every `PATCHES_PER_CHUNK` patches and on close. */
  snapshot?: ConversationState;
}

/** One chunk of patches (`<agentName>:<sessionId>:<index>`), seqs `index * 100 + 1` to `(index + 1) * 100`. */
export interface ChatChunkRecord {
  schemaVersion: typeof CHAT_SCHEMA_VERSION;
  sessionId: string;
  agentName: string;
  chunk: number;
  patches: Patch[];
}

export interface SessionKey {
  agentName: string;
  sessionId: string;
}

export function sessionRecordKey(key: SessionKey): string {
  return `${key.agentName}:${key.sessionId}`;
}

function chunkKey(params: { key: SessionKey; chunk: number }): string {
  return `${sessionRecordKey(params.key)}:${params.chunk}`;
}

function chunkOf(seq: number): number {
  return Math.floor((seq - 1) / PATCHES_PER_CHUNK);
}

export interface StoredSession {
  record: ChatSessionRecord;
  patches: Patch[];
}

/** Reads a stored session with all its patches, or undefined when it was never stored. */
export async function loadSession(params: { store: Store; key: SessionKey }): Promise<StoredSession | undefined> {
  const { store, key } = params;
  const stored = await store.get<ChatSessionRecord>(CHATS_COLLECTION, sessionRecordKey(key));
  if (stored == null) return undefined;
  const patches: Patch[] = [];
  for (let chunk = 0; ; chunk += 1) {
    const record = await store.get<ChatChunkRecord>(CHATS_COLLECTION, chunkKey({ key, chunk }));
    if (record == null) break;
    patches.push(...record.value.patches);
  }
  return { record: stored.value, patches };
}

export interface SessionWriter {
  /** Queues the patch; consecutive patches of one chunk go out in one write. */
  append(patch: Patch, state: ConversationState): void;
  /** Writes the session record with the latest snapshot. */
  snapshot(state: ConversationState): void;
  /** Resolves when every write so far has settled; resolves with the failures (as messages). */
  flush(): Promise<string[]>;
}

interface PendingChunk {
  chunk: number;
  patches: Patch[];
  /** The write has read the batch, so later patches need a write of their own. */
  isTaken: boolean;
}

/** Every patch goes through the keyed write queue (key `chat:<agentName>:<sessionId>`) and `redact`, in order. */
export function createSessionWriter(params: { writer: RecordWriter; key: SessionKey; instanceId: string }): SessionWriter {
  const { writer, key, instanceId } = params;
  const { agentName, sessionId } = key;
  const queueKey = `chat:${agentName}:${sessionId}`;
  const writes = new Set<Promise<unknown>>();
  const failures: string[] = [];
  let pending: PendingChunk | undefined;

  function track(write: Promise<unknown>): void {
    const settled = write.then(() => undefined, (error: unknown) => { failures.push(error instanceof Error ? error.message : String(error)); });
    writes.add(settled);
    void settled.then(() => writes.delete(settled));
  }

  function snapshot(state: ConversationState): void {
    const value = (): ChatSessionRecord => ({ schemaVersion: CHAT_SCHEMA_VERSION, sessionId, agentName, instanceId, seq: state.seq, snapshot: state });
    track(writer.update<ChatSessionRecord, ChatSessionRecord>({ queueKey, collection: CHATS_COLLECTION, key: sessionRecordKey(key), patch: value, merge: ({ patch }) => patch }));
  }

  function append(patch: Patch, state: ConversationState): void {
    const chunk = chunkOf(patch.seq);
    if (pending != null && pending.chunk === chunk && !pending.isTaken) {
      pending.patches.push(patch);
    } else {
      const batch: PendingChunk = { chunk, patches: [patch], isTaken: false };
      pending = batch;
      // The session record exists from the first patch, so a reopen finds the chunks.
      if (patch.seq === 1) snapshot(state);
      track(writer.update<ChatChunkRecord, Patch[]>({
        queueKey, collection: CHATS_COLLECTION, key: chunkKey({ key, chunk }),
        patch: () => { batch.isTaken = true; return batch.patches; },
        merge: ({ current, patch: added }) => ({ schemaVersion: CHAT_SCHEMA_VERSION, sessionId, agentName, chunk, patches: [...(current?.patches ?? []), ...added] }),
      }));
    }
    // Queued after the chunk write that holds this patch, so the snapshot never runs ahead of the patches.
    if (patch.seq % PATCHES_PER_CHUNK === 0) snapshot(state);
  }

  async function flush(): Promise<string[]> {
    while (writes.size > 0) await Promise.all([...writes]);
    return failures.splice(0);
  }

  return { append, snapshot, flush };
}
