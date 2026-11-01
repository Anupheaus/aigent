import { checkWhere, matchesWhere } from './list-where.js';
import { matchesPurge } from './purge-match.js';
import type { CompareAndSetParams, ListOptions, PurgeFilter, Store, StoredRecord } from './store-types.js';

export function createInMemoryStore(): Store {
  const collections = new Map<string, Map<string, StoredRecord<unknown>>>();

  function collectionFor(name: string): Map<string, StoredRecord<unknown>> {
    const existing = collections.get(name);
    if (existing != null) return existing;
    const created = new Map<string, StoredRecord<unknown>>();
    collections.set(name, created);
    return created;
  }

  async function get<T>(collection: string, key: string): Promise<StoredRecord<T> | undefined> {
    const record = collectionFor(collection).get(key);
    return record == null ? undefined : structuredClone(record) as StoredRecord<T>;
  }

  // No awaits between the version check and the write, so the operation is atomic in a single-threaded runtime.
  async function compareAndSet<T>(params: CompareAndSetParams<T>): Promise<boolean> {
    const { collection, key, expectedVersion, value } = params;
    const records = collectionFor(collection);
    const current = records.get(key);
    if (current?.version !== expectedVersion) return false;
    records.set(key, { key, value: structuredClone(value), version: (current?.version ?? 0) + 1 });
    return true;
  }

  async function list<T>(collection: string, options: ListOptions = {}): Promise<StoredRecord<T>[]> {
    const { where } = options;
    checkWhere(where);
    return [...collectionFor(collection).values()].filter(({ value }) => matchesWhere({ value, where })).map(record => structuredClone(record) as StoredRecord<T>);
  }

  async function deleteRecord(collection: string, key: string): Promise<void> {
    collectionFor(collection).delete(key);
  }

  async function purge(filter: PurgeFilter): Promise<number> {
    let purged = 0;
    for (const records of collections.values()) {
      for (const [key, record] of records) {
        if (!matchesPurge(record.value, filter)) continue;
        records.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  return { get, compareAndSet, list, delete: deleteRecord, purge };
}
