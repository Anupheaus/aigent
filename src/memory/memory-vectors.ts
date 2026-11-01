import { createAigentError } from '../core/aigent-error.js';
import type { Store } from '../store/store-types.js';
import { updateRecord } from '../store/update-record.js';

/** The store collection that holds memory embeddings, keyed by memory entry id (one vector per entry). */
export const MEMORY_VECTOR_COLLECTION = 'memory-vectors';

/** Each lost compare-and-set means another write landed; a vector record has few writers (recalls of one scope). */
const MAX_EMPTY_ATTEMPTS = 20;

/**
 * One memory entry's embedding. It carries the entry's agent, run and times, so `ai.purge` and a store's retention
 * reach it exactly as they reach the entry; forgetting or evicting the entry drops it.
 */
export interface MemoryVectorRecord {
  memoryId: string;
  agentName: string;
  scopeKey: string;
  /** The entry's run (absent on entries older than run stamping). */
  runId?: string;
  /** The entry's `recordedAt` when embedded: never later than the entry's, so purging the entry purges the vector. */
  recordedAt: number;
  /** The entry's `expiresAt` when embedded. */
  expiresAt?: number;
  /** `Embedder.id` and `dimensions`: a vector is used only by the same embedder, never compared across spaces. */
  embedderId: string;
  dimensions: number;
  /** sha-256 of the text embedded (the entry's stored, already scrubbed text). */
  textHash: string;
  vector: number[];
}

/** A dropped record on a store without `delete`: the identity and purge fields stay, the vector goes. */
type DroppedVectorRecord = Omit<MemoryVectorRecord, 'vector'> & { removed: true };

type StoredVectorRecord = MemoryVectorRecord | DroppedVectorRecord;

function isLive(record: StoredVectorRecord | undefined): record is MemoryVectorRecord {
  return record != null && !('removed' in record);
}

/** The entry's vector record, or undefined when there is none (or it was dropped). */
export async function readMemoryVector(params: { store: Store; memoryId: string }): Promise<MemoryVectorRecord | undefined> {
  const { store, memoryId } = params;
  const record = (await store.get<StoredVectorRecord>(MEMORY_VECTOR_COLLECTION, memoryId))?.value;
  return isLive(record) ? record : undefined;
}

/** Writes (or replaces) the entry's vector record. */
export async function writeMemoryVector(params: { store: Store; record: MemoryVectorRecord }): Promise<void> {
  const { store, record } = params;
  await updateRecord<StoredVectorRecord>({ store, collection: MEMORY_VECTOR_COLLECTION, key: record.memoryId, update: () => record });
}

/** Deletes the entries' vector records; on a store without `delete`, empties them (the vector is gone either way). */
export async function dropMemoryVectors(params: { store: Store; ids: string[] }): Promise<void> {
  const { store, ids } = params;
  for (const id of ids) {
    if (store.delete != null) {
      await store.delete(MEMORY_VECTOR_COLLECTION, id);
      continue;
    }
    await emptyRecord({ store, id });
  }
}

/** Replaces a live record by its dropped form; gone or already dropped records are left alone (nothing is created). */
async function emptyRecord(params: { store: Store; id: string }): Promise<void> {
  const { store, id } = params;
  for (let attempt = 1; attempt <= MAX_EMPTY_ATTEMPTS; attempt += 1) {
    const current = await store.get<StoredVectorRecord>(MEMORY_VECTOR_COLLECTION, id);
    if (current == null || !isLive(current.value)) return;
    const { vector: _vector, ...kept } = current.value;
    const dropped: DroppedVectorRecord = { ...kept, removed: true };
    if (await store.compareAndSet({ collection: MEMORY_VECTOR_COLLECTION, key: id, expectedVersion: current.version, value: dropped })) return;
  }
  throw createAigentError({
    code: 'store_conflict',
    message: `Could not drop memory vector '${MEMORY_VECTOR_COLLECTION}/${id}' after ${MAX_EMPTY_ATTEMPTS} attempts because of concurrent writes`,
    details: { collection: MEMORY_VECTOR_COLLECTION, key: id },
  });
}
