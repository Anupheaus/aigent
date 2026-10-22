import { pruneDocument } from '../../../security/db-field-paths.js';
import type { DbSortKey } from '../../../security/db-policy-types.js';
import type { DbAccess, DbFindParams } from './db-access.js';
import { compareValues, matchesFilter, valuesAt } from './memory-filter.js';
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

/** The first value of the sort path (missing sorts as null), as MongoDB's ascending order would. */
function sortValue(params: { doc: Record<string, unknown>; field: string }): unknown {
  const { doc, field } = params;
  return valuesAt({ doc, path: field })[0] ?? null;
}

function sortDocs(params: { docs: Record<string, unknown>[]; sort?: DbSortKey[] }): Record<string, unknown>[] {
  const { docs, sort = [] } = params;
  if (sort.length === 0) return docs;
  // Array#sort is stable, so equal keys keep insertion order.
  return [...docs].sort((left, right) => {
    for (const { field, direction } of sort) {
      const order = compareValues(sortValue({ doc: left, field }), sortValue({ doc: right, field }));
      if (order !== 0) return direction === 'asc' ? order : -order;
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
  const matching = (params: { collection: string; filter: Record<string, unknown>; signal: AbortSignal }): Record<string, unknown>[] => {
    const { collection, filter, signal } = params;
    signal.throwIfAborted();
    return (collections.get(collection) ?? []).filter(doc => matchesFilter({ doc, filter }));
  };
  return {
    find: async (params: DbFindParams) => {
      const { projection, sort, limit, skip = 0 } = params;
      const sorted = sortDocs({ docs: matching(params), ...(sort == null ? {} : { sort }) });
      const page = sorted.slice(skip, skip + limit);
      return { docs: page.map(doc => project({ doc: structuredClone(doc), ...(projection == null ? {} : { projection }) })), truncated: sorted.length > skip + limit };
    },
    count: async params => matching(params).length,
  };
}
