export interface StoredRecord<T> {
  key: string;
  value: T;
  /** Starts at 1 and increases by 1 on every successful write. */
  version: number;
}

export interface CompareAndSetParams<T> {
  collection: string;
  key: string;
  /** `undefined` means the record must not exist yet. */
  expectedVersion: number | undefined;
  value: T;
}

/** Which telemetry records to delete; every given field must match (records carry `agentName`, `runId`, `recordedAt`). */
export interface PurgeFilter {
  agentName?: string;
  runId?: string;
  /** Epoch ms: records whose `recordedAt` is earlier. */
  before?: number;
}

/** A value a `list` filter compares a top-level field with (exactly, `===`). */
export type ListFieldValue = string | number | boolean | null;

/** What `list` returns: an optional filter, so a store with an index (a database) need not return a whole collection. */
export interface ListOptions {
  /**
   * Only records whose value is a plain object with every one of these top-level fields equal (`===`) to the given
   * value: a missing field never equals `null`, `'1'` never equals `1`, and a key such as `a.b` names the top-level
   * field `a.b`. Empty or absent: every record.
   */
  where?: Readonly<Record<string, ListFieldValue>>;
}

/** Persistence contract. Implementations must make `compareAndSet` atomic. */
export interface Store {
  get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined>;
  /** Returns false (and writes nothing) when the stored version differs from `expectedVersion`. */
  compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean>;
  /**
   * The records of a collection. `options.where` is optional to honour: a store written before it existed lists every
   * record, so callers that pass it filter the result again (see `listWhere`).
   */
  list<T>(collection: string, options?: ListOptions): Promise<StoredRecord<T>[]>;
  /**
   * Optional: deletes one record (a no-op when it does not exist). The tool-result cache uses it to drop evicted
   * entries; without it they stay behind as small tombstones (value dropped, statistics kept).
   */
  delete?(collection: string, key: string): Promise<void>;
  /** Optional: deletes matching records in every collection and resolves with how many went. */
  purge?(filter: PurgeFilter): Promise<number>;
}
