import type { DbSortKey } from '../../../security/db-policy-types.js';

/** One `find`, already checked by the `DbPolicy`: every value in `filter` is data, passed as a parameter. */
export interface DbFindParams {
  collection: string;
  filter: Record<string, unknown>;
  /** Inclusion (1) or exclusion (0) by field path; absent returns whole documents. */
  projection?: Record<string, 0 | 1>;
  sort?: DbSortKey[];
  limit: number;
  skip?: number;
  /** Server-side time limit. */
  maxTimeMs: number;
  /** Aborts the query; an adapter closes its cursor. */
  signal: AbortSignal;
}

/** What `find` returns. */
export interface DbFindResult {
  /** Documents as plain JSON, with database types tagged (`{ $oid }`, `{ $date }`...; see `toTaggedJson`). */
  docs: Record<string, unknown>[];
  /** More documents matched than `limit`. */
  truncated: boolean;
}

/** One `count`, already checked by the `DbPolicy`. */
export interface DbCountParams {
  collection: string;
  filter: Record<string, unknown>;
  maxTimeMs: number;
  signal: AbortSignal;
}

/**
 * How the database pack reaches a database. Read-only by construction: there is no method that writes, runs a pipeline
 * or runs code. The pack only ever calls it with queries the `DbPolicy` accepted.
 */
export interface DbAccess {
  find(params: DbFindParams): Promise<DbFindResult>;
  count(params: DbCountParams): Promise<number>;
}
