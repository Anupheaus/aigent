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

export interface MergePatchParams<T, P> {
  /** The stored value (already redacted when it was written), undefined when absent. */
  current: T | undefined;
  /** The update's new content, as redact returned it. */
  patch: P;
}

export interface UpdateWrittenRecordParams<T, P> {
  queueKey: string;
  collection: string;
  key: string;
  /**
   * The update's new content only, built from the stored value. Only this passes through redact, so content that was
   * already redacted is never redacted again (a hashing or encrypting hook would compound). May be async (e.g. to read
   * another record) and runs again on every compare-and-set retry.
   */
  patch(current: T | undefined): P | Promise<P>;
  /** Combines the stored value with the redacted patch into the record to write; its result is not redacted again. */
  merge(params: MergePatchParams<T, P>): T;
}

/** The only way telemetry reaches the store: every write is queued per key and passes through `redact` first. */
export interface RecordWriter {
  /** Creates a record that must not exist yet; resolves false (writing nothing) when it does. */
  create(params: CreateRecordParams): Promise<boolean>;
  /** Read-modify-write with compare-and-set retry; resolves with the value as stored. */
  update<T, P>(params: UpdateWrittenRecordParams<T, P>): Promise<T>;
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

  function update<T, P>(updateParams: UpdateWrittenRecordParams<T, P>): Promise<T> {
    const { queueKey, collection, key, patch, merge } = updateParams;
    // Redacted inside the retry loop, so every attempt's new content (not just the last) is redacted before it is written.
    const next = async (current: T | undefined): Promise<T> => {
      const redacted = applyRedact({ redact, record: { collection, key, value: await patch(current) } }).value as P;
      return merge({ current, patch: redacted });
    };
    return writeQueue.enqueue(queueKey, () => updateRecord<T>({ store, collection, key, update: next }));
  }

  return { create, update };
}
