import { pruneDocument } from '../../../security/db-field-paths.js';
import type { DbSortKey } from '../../../security/db-policy-types.js';
import type { DbAccess, DbFindParams } from './db-access.js';
import { compareValues, matchesFilter, valuesAt } from './memory-filter.js';
import { prepareRegexTest } from './memory-regex.js';
import { toTaggedJson } from './tagged-json.js';

/** `createMemoryDbAccess(options)`. */
export interface MemoryDbAccessOptions {
  /** Documents per collection; Dates and other values are stored as tagged JSON (`toTaggedJson`). */
  collections: Record<string, Record<string, unknown>[]>;
}

const ID_FIELD = '_id';

function project(params: { doc: Record<string, unknown>; projection?: Record<string, 0 | 1> }): Record<string, unknown> {
  const { doc, projection } = params;
  if (projection == null) return doc;
  const entries = Object.entries(projection);
  const included = entries.filter(([, flag]) => flag === 1).map(([field]) => field);
  const excluded = entries.filter(([, flag]) => flag === 0).map(([field]) => field);
  if (included.length === 0) return pruneDocument({ denyFields: excluded }, doc);
  // As in MongoDB, an inclusion projection keeps _id unless it is excluded by name.
  const allowFields = excluded.includes(ID_FIELD) || included.includes(ID_FIELD) ? included : [...included, ID_FIELD];
  return pruneDocument({ allowFields, denyFields: excluded }, doc);
}

/**
 * The sort key of a document, as MongoDB picks it: an array sorts by its smallest element ascending and its largest
 * descending; a missing field sorts as null.
 */
function sortValue(params: { doc: Record<string, unknown>; key: DbSortKey }): unknown {
  const { doc, key: { field, direction } } = params;
  const values = valuesAt({ doc, path: field }).flatMap(value => (Array.isArray(value) ? value : [value])).filter(value => value !== undefined);
  if (values.length === 0) return null;
  return values.reduce((chosen, value) => {
    const order = compareValues(value, chosen);
    return (direction === 'asc' ? order < 0 : order > 0) ? value : chosen;
  });
}

function sortDocs(params: { docs: Record<string, unknown>[]; sort?: DbSortKey[] }): Record<string, unknown>[] {
  const { docs, sort = [] } = params;
  if (sort.length === 0) return docs;
  // Array#sort is stable, so equal keys keep insertion order.
  return [...docs].sort((left, right) => {
    for (const key of sort) {
      const order = compareValues(sortValue({ doc: left, key }), sortValue({ doc: right, key }));
      if (order !== 0) return key.direction === 'asc' ? order : -order;
    }
    return 0;
  });
}

/**
 * An in-memory `DbAccess` over plain documents, for tests and examples. It evaluates the same operator subset the
 * `DbPolicy` allows, with MongoDB's semantics for comparisons across types, arrays, `null` and missing fields.
 */
export function createMemoryDbAccess(options: MemoryDbAccessOptions): DbAccess {
  const collections = new Map(Object.entries(options.collections).map(([name, docs]) => [name, docs.map(doc => toTaggedJson(doc) as Record<string, unknown>)]));
  const matching = async (params: { collection: string; filter: Record<string, unknown>; maxTimeMs: number; signal: AbortSignal }): Promise<Record<string, unknown>[]> => {
    const { collection, filter, maxTimeMs, signal } = params;
    signal.throwIfAborted();
    const docs = collections.get(collection) ?? [];
    const testRegex = await prepareRegexTest({ filter, docs, maxTimeMs, signal });
    return docs.filter(doc => matchesFilter({ doc, filter, testRegex }));
  };
  return {
    find: async (params: DbFindParams) => {
      const { projection, sort, limit, skip = 0 } = params;
      const sorted = sortDocs({ docs: await matching(params), ...(sort == null ? {} : { sort }) });
      const page = sorted.slice(skip, skip + limit);
      return { docs: page.map(doc => project({ doc: structuredClone(doc), ...(projection == null ? {} : { projection }) })), truncated: sorted.length > skip + limit };
    },
    count: async params => (await matching(params)).length,
  };
}
