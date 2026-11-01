import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../core/canonical-json.js';
import { createAigentError } from '../core/aigent-error.js';
import type { Store, StoredRecord } from '../store/store-types.js';
import type { IndexedChunk } from './knowledge-types.js';

/** The store collection every store-backed vector index keeps its records in. */
export const STORE_VECTOR_COLLECTION = 'vector-index';

/** Version of the stored index and page records; another version is refused rather than misread. */
export const STORE_VECTOR_SCHEMA_VERSION = 1;

/** Chunks per page record: a page of 1,536-number vectors and 800-character texts stays well under 16 MB (MongoDB's cap). */
export const PAGE_SIZE = 200;

/** The index record: which pages hold the namespace's chunks, in order. */
export interface StoredVectorManifest {
  schemaVersion: number;
  namespace: string;
  /** Page record keys. */
  pages: string[];
}

/** One page record; a replaced page on a store without `delete` is emptied and marked `removed`. */
export interface StoredVectorPage {
  schemaVersion: number;
  namespace: string;
  chunks: IndexedChunk[];
  removed?: boolean;
}

/** `encodeURIComponent` never yields `:`, so no namespace's keys can equal another's. */
export function manifestKey(namespace: string): string {
  return `${encodeURIComponent(namespace)}:manifest`;
}

/** A fresh page key: unique per write, so two writers never write the same page record. */
export function newPageKey(namespace: string): string {
  return `${encodeURIComponent(namespace)}:page:${randomUUID()}`;
}

function refused(params: { key: string; found: unknown }): Error {
  const { key, found } = params;
  return createAigentError({
    code: 'store_failed',
    message: `Vector index record '${STORE_VECTOR_COLLECTION}/${key}' has schemaVersion ${String(found)}; expected ${STORE_VECTOR_SCHEMA_VERSION}`,
    details: { collection: STORE_VECTOR_COLLECTION, key, schemaVersion: found },
  });
}

/** The namespace's index record (undefined before the first write); another schema version throws `store_failed`. */
export async function readManifest(params: { store: Store; namespace: string }): Promise<StoredRecord<StoredVectorManifest> | undefined> {
  const { store, namespace } = params;
  const key = manifestKey(namespace);
  const record = await store.get<StoredVectorManifest>(STORE_VECTOR_COLLECTION, key);
  if (record != null && record.value.schemaVersion !== STORE_VECTOR_SCHEMA_VERSION) throw refused({ key, found: record.value.schemaVersion });
  return record;
}

/** A page's chunks, or undefined when it is gone (a writer replaced it after the index record was read). */
export async function readPage(params: { store: Store; key: string }): Promise<IndexedChunk[] | undefined> {
  const { store, key } = params;
  const record = await store.get<StoredVectorPage>(STORE_VECTOR_COLLECTION, key);
  if (record == null || record.value.removed === true) return undefined;
  if (record.value.schemaVersion !== STORE_VECTOR_SCHEMA_VERSION) throw refused({ key, found: record.value.schemaVersion });
  return record.value.chunks;
}

/** Splits chunks (already in place order) into pages of `PAGE_SIZE`. */
export function paginate(chunks: IndexedChunk[]): IndexedChunk[][] {
  const pages: IndexedChunk[][] = [];
  for (let start = 0; start < chunks.length; start += PAGE_SIZE) pages.push(chunks.slice(start, start + PAGE_SIZE));
  return pages;
}

/** Whether two pages hold the same chunks, field for field. */
export function samePage(left: IndexedChunk[] | undefined, right: IndexedChunk[]): boolean {
  return left != null && left.length === right.length && canonicalJson(left) === canonicalJson(right);
}

/** Drops page records no index record points at any more: deleted, or (stores without `delete`) emptied. */
export async function discardPages(params: { store: Store; namespace: string; keys: string[] }): Promise<void> {
  const { store, namespace, keys } = params;
  for (const key of keys) {
    if (store.delete != null) {
      await store.delete(STORE_VECTOR_COLLECTION, key);
      continue;
    }
    const current = await store.get<StoredVectorPage>(STORE_VECTOR_COLLECTION, key);
    if (current == null) continue;
    const emptied: StoredVectorPage = { schemaVersion: STORE_VECTOR_SCHEMA_VERSION, namespace, chunks: [], removed: true };
    // Page records are written once and never updated, so a lost compare-and-set means someone else emptied it.
    await store.compareAndSet({ collection: STORE_VECTOR_COLLECTION, key, expectedVersion: current.version, value: emptied });
  }
}
