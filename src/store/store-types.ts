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

/** Persistence contract. Implementations must make `compareAndSet` atomic. */
export interface Store {
  get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined>;
  /** Returns false (and writes nothing) when the stored version differs from `expectedVersion`. */
  compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean>;
  list<T>(collection: string): Promise<StoredRecord<T>[]>;
}
