import { createAigentError } from '../core/aigent-error.js';
import { MAX_BSON_DOCUMENT_BYTES, bsonSize } from './bson-size.js';
import type { MongoDocument, MongoFilter, MongoPurgeFields } from './mongo-types.js';
import type { PurgeFilter } from './store-types.js';

const MEBIBYTE = 1_048_576;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The purge criteria a value carries, by the rule every store shares (`matchesPurge`): plain objects only, typed fields only. */
export function purgeFieldsOf(value: unknown): MongoPurgeFields | null {
  if (!isPlainObject(value)) return null;
  const { agentName, runId, recordedAt } = value;
  return {
    ...(typeof agentName === 'string' ? { agentName } : {}),
    ...(typeof runId === 'string' ? { runId } : {}),
    ...(typeof recordedAt === 'number' ? { recordedAt } : {}),
  };
}

/** The filter `purge` sends: this store's records only; with no criteria, every record whose value is a plain object. */
export function purgeCriteria(params: { filter: PurgeFilter; prefix: string }): MongoFilter {
  const { filter: { agentName, runId, before }, prefix } = params;
  const criteria: MongoFilter = { store: prefix };
  if (agentName != null) criteria['purge.agentName'] = agentName;
  if (runId != null) criteria['purge.runId'] = runId;
  if (before != null) criteria['purge.recordedAt'] = { $lt: before };
  return Object.keys(criteria).length === 1 ? { ...criteria, purge: { $type: 'object' } } : criteria;
}

/**
 * The document for a record. The value is kept as JSON text (dropping `undefined` fields as the file store does), so
 * field names like `$schema` or `a.b` round-trip; a document over MongoDB's 16 MiB limit is refused before it is sent.
 */
export function documentFor(params: { key: string; version: number; value: unknown; prefix: string; collection: string }): MongoDocument {
  const { key, version, value, prefix, collection } = params;
  const json = JSON.stringify(value ?? null);
  const document: MongoDocument = { _id: key, version, json, store: prefix, purge: purgeFieldsOf(JSON.parse(json)) };
  const size = bsonSize({ ...document });
  if (size > MAX_BSON_DOCUMENT_BYTES) {
    throw createAigentError({
      code: 'invalid_input',
      message: `Record '${collection}/${key}' is ${size} bytes as a MongoDB document; MongoDB stores at most 16 MiB (${MAX_BSON_DOCUMENT_BYTES} bytes) per document, so keep values under about ${Math.floor(MAX_BSON_DOCUMENT_BYTES / MEBIBYTE)} MiB of JSON`,
      details: { collection, key, bytes: size, maxBytes: MAX_BSON_DOCUMENT_BYTES },
    });
  }
  return document;
}

/** The value a document holds; one this store did not write (no JSON text) fails with `store_failed`. */
export function valueOf(params: { document: MongoDocument; collection: string }): unknown {
  const { document, collection } = params;
  if (typeof document.json !== 'string') {
    throw createAigentError({
      code: 'store_failed',
      message: `MongoDB document '${collection}/${document._id}' has no 'json' text; it was not written by this version of the store`,
      details: { collection, key: document._id },
    });
  }
  return JSON.parse(document.json) as unknown;
}
