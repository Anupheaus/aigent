import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';

/** A removed record where the store cannot delete: never listed again. */
interface Tombstone {
  id: string;
  removedAt: number;
}

/** Versioned learned objects (variants, skills) of one collection, written through `redact` and the write queue. */
export interface LearnedRecords<T extends { id: string }> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | undefined>;
  create(value: T): Promise<boolean>;
  /** Merges the changed fields into the stored value (compare-and-set retry); undefined when there is no live record. */
  update(id: string, change: (current: T) => Partial<T>): Promise<T | undefined>;
  /** True when a live record was removed. */
  remove(id: string): Promise<boolean>;
}

export interface CreateLearnedRecordsParams<T> {
  store: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
  collection: string;
  /** Writes of this collection run one at a time, in order. */
  queueKey: string;
  /** The stored value as `T`, or undefined for anything else (a tombstone, a corrupt or foreign record). */
  parse(value: unknown): T | undefined;
  now(): number;
}

export function createLearnedRecords<T extends { id: string }>(params: CreateLearnedRecordsParams<T>): LearnedRecords<T> {
  const { store, writeQueue, redact, collection, queueKey, parse, now } = params;
  const writer = createRecordWriter({ store, writeQueue, ...(redact == null ? {} : { redact }) });
  const get = async (id: string): Promise<T | undefined> => {
    const stored = await store.get<unknown>(collection, id);
    return stored == null ? undefined : parse(stored.value);
  };
  return {
    list: async () => (await store.list<unknown>(collection)).flatMap(({ value }) => { const parsed = parse(value); return parsed == null ? [] : [parsed]; }),
    get,
    create: value => writer.create({ queueKey, record: { collection, key: value.id, value } }),
    update: async (id, change) => {
      if (await get(id) == null) return undefined;
      // Rechecked inside the retry loop: a concurrent remove leaves the record as it is.
      let isLive = true;
      const stored = await writer.update<unknown, Partial<T>>({
        queueKey, collection, key: id,
        patch: current => { const parsed = parse(current); isLive = parsed != null; return parsed == null ? {} : change(parsed); },
        merge: ({ current, patch }) => (isLive ? { ...(current as T), ...patch } : current),
      });
      return isLive ? parse(stored) : undefined;
    },
    remove: async id => {
      if (await get(id) == null) return false;
      if (store.delete != null) {
        await writeQueue.enqueue(queueKey, () => store.delete!(collection, id));
        return true;
      }
      const tombstone: Tombstone = { id, removedAt: now() };
      await writer.update<unknown, Tombstone>({ queueKey, collection, key: id, patch: () => tombstone, merge: ({ patch }) => patch });
      return true;
    },
  };
}
