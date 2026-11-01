import { createAigentError } from '../core/aigent-error.js';
import { MAX_BSON_DOCUMENT_BYTES, bsonSize } from './bson-size.js';
import type { MongoDocument, MongoFilter, MongoPurgeFields, MongoWhereFields } from './mongo-types.js';
import type { ListOptions, PurgeFilter } from './store-types.js';

const MEBIBYTE = 1_048_576;
/** Longest string copied into `fields`: keeps documents small; a longer `where` string is matched on the client. */
const MAX_WHERE_STRING_LENGTH = 256;
/**
 * In `/u` mode a surrogate code point matches only when unpaired. BSON would store a lone surrogate as U+FFFD, so a
 * string holding one is never copied into `fields` and is matched on the client instead.
 */
const LONE_SURROGATE = /\p{Cs}/u;

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

/** A field name MongoDB reads as written: no `$` prefix (an operator), no dot (a path), no NUL, not empty. */
function isServerFieldName(name: string): boolean {
  return name !== '' && !name.startsWith('$') && !name.includes('.') && !name.includes('\u0000');
}

/** A value the server compares exactly as `===` does: short well-formed strings, finite numbers, booleans, null. */
function isServerFieldValue(value: unknown): value is string | number | boolean | null {
  if (typeof value === 'string') return value.length <= MAX_WHERE_STRING_LENGTH && !LONE_SURROGATE.test(value);
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/** The top-level fields of a value that `list({ where })` can match on the server; null when it is not a plain object. */
export function whereFieldsOf(value: unknown): MongoWhereFields | null {
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([name, field]) => isServerFieldName(name) && isServerFieldValue(field))) as MongoWhereFields;
}

/**
 * The server filter for `list({ where })`: equality on `fields.*`, or any document written before `fields` existed
 * (the caller filters those, and every result, again). `{}` when a name or value cannot be matched on the server.
 */
export function listCriteria(where: ListOptions['where']): MongoFilter {
  const entries = Object.entries(where ?? {});
  if (entries.length === 0 || !entries.every(([name, value]) => isServerFieldName(name) && isServerFieldValue(value))) return {};
  return { $or: [Object.fromEntries(entries.map(([name, value]) => [`fields.${name}`, value])), { fields: { $exists: false } }] };
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
  const parsed: unknown = JSON.parse(json);
  const document: MongoDocument = { _id: key, version, json, store: prefix, purge: purgeFieldsOf(parsed), fields: whereFieldsOf(parsed) };
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
