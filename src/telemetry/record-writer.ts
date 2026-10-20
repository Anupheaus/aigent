import type { Store } from '../store/store-types.js';
import { updateRecord } from '../store/update-record.js';
import type { WriteQueue } from '../store/write-queue.js';
import { applyRedact } from './redact.js';
import type { Redact, RedactableRecord } from './redact.js';

export interface CreateRecordParams {
  /** Writes sharing a key (the agent name) run one at a time in arrival order. */
  queueKey: string;
  record: RedactableRecord;
}

export interface UpdateWrittenRecordParams<T> {
  queueKey: string;
  collection: string;
  key: string;
  /** Builds the next value from the stored one (undefined when absent). May run several times under contention. */
  update(current: T | undefined): T;
}

/** The only way telemetry reaches the store: every write is queued per key and passes through `redact` first. */
export interface RecordWriter {
  /** Creates a record that must not exist yet; resolves false (writing nothing) when it does. */
  create(params: CreateRecordParams): Promise<boolean>;
  /** Read-modify-write with compare-and-set retry; resolves with the value as stored (redacted). */
  update<T>(params: UpdateWrittenRecordParams<T>): Promise<T>;
}

export interface CreateRecordWriterParams {
  store: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
}

export function createRecordWriter(params: CreateRecordWriterParams): RecordWriter {
  const { store, writeQueue, redact } = params;

  function create(createParams: CreateRecordParams): Promise<boolean> {
    const { queueKey, record } = createParams;
    return writeQueue.enqueue(queueKey, async () => {
      const { collection, key, value } = applyRedact({ redact, record });
      return store.compareAndSet({ collection, key, expectedVersion: undefined, value });
    });
  }

  function update<T>(updateParams: UpdateWrittenRecordParams<T>): Promise<T> {
    const { queueKey, collection, key, update: next } = updateParams;
    // Redacted inside the retry loop, so every attempt's value (not just the last) is redacted before it is written.
    const redacted = (current: T | undefined): T => applyRedact({ redact, record: { collection, key, value: next(current) } }).value as T;
    return writeQueue.enqueue(queueKey, () => updateRecord<T>({ store, collection, key, update: redacted }));
  }

  return { create, update };
}
