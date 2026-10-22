/** What a collection allows. Only `read` exists: the database pack is read-only by construction. */
export type DbPermission = 'read';

/** The rules for one collection the database pack may query. */
export interface DbCollectionRule {
  /** Without `read` every query on the collection is refused. */
  permissions: DbPermission[];
  /**
   * Only these field paths (and fields below them) may be filtered on, sorted by, projected and returned. Default: every
   * field not in `denyFields`. `_id` counts as a field.
   */
  allowFields?: string[];
  /** These field paths (and fields below them) are never filtered on, sorted by, projected or returned. */
  denyFields?: string[];
  /** Most documents one query may return (default `DEFAULT_MAX_LIMIT`, 200). */
  maxLimit?: number;
  /** Server-side time limit of one query in milliseconds (default `DEFAULT_MAX_TIME_MS`, 5000). */
  maxTimeMs?: number;
  /**
   * The filter operators allowed on this collection (default `DEFAULT_FILTER_OPERATORS`). Must be a subset of
   * `SUPPORTED_FILTER_OPERATORS`; operators that run code or write (`$where`, `$function`, `$out`...) can never be allowed.
   */
  allowOperators?: string[];
  /** Every query on this collection needs a person's approval first (for sensitive data). Default false. */
  requiresApproval?: boolean;
}

/** `createDbPolicy(options)`. Deny by default: a collection that is not listed (or lacks `read`) is refused. */
export interface DbPolicyOptions {
  collections: Record<string, DbCollectionRule>;
  /** Deepest nesting of a filter, counting objects and arrays (default 8). */
  maxDepth?: number;
  /** Longest array anywhere in a filter (`$in`, `$or`, literals; default 1000). */
  maxArrayLength?: number;
}

/** A collection's rule with every default filled in. */
export interface ResolvedDbCollectionRule {
  allowFields?: string[];
  denyFields: string[];
  maxLimit: number;
  maxTimeMs: number;
  allowOperators: ReadonlySet<string>;
  requiresApproval: boolean;
}

/** The only authority on which collections, fields and operators the database pack may use. */
export interface DbPolicy {
  /** The readable collection's rule, or undefined when the collection is refused. */
  rule(collection: string): ResolvedDbCollectionRule | undefined;
  /** Names of the collections that allow `read`, sorted. */
  collections(): string[];
  limits: { maxDepth: number; maxArrayLength: number };
}

/** One sort key. */
export interface DbSortKey {
  field: string;
  direction: 'asc' | 'desc';
}

/** A query as the model asks for it, before validation. */
export interface DbQueryRequest {
  collection: string;
  /** A MongoDB-style filter (parsed JSON); absent matches every document. */
  filter?: unknown;
  projection?: string[];
  sort?: DbSortKey[];
  limit?: number;
  skip?: number;
}

/** A query that passed the policy, ready for a `DbAccess`. */
export interface ValidatedDbQuery {
  collection: string;
  filter: Record<string, unknown>;
  /** Inclusion (1) or exclusion (0) by field path, MongoDB style; absent returns whole documents. */
  projection?: Record<string, 0 | 1>;
  sort?: DbSortKey[];
  limit: number;
  skip?: number;
  maxTimeMs: number;
}

/** Why a query was refused. */
export type DbDenialCode =
  | 'collection_denied' | 'invalid_filter' | 'forbidden_key' | 'operator_forbidden' | 'operator_not_allowed'
  | 'invalid_operator_value' | 'invalid_field' | 'field_denied' | 'too_deep' | 'array_too_long' | 'too_large'
  | 'unsafe_regex' | 'limit_exceeded' | 'invalid_sort' | 'invalid_projection' | 'invalid_skip';

/** `validateQuery`: the query to run, or why it is refused and where (e.g. `filter.$or[1].age.$where`). */
export type DbQueryValidation =
  | { ok: true; query: ValidatedDbQuery }
  | { ok: false; code: DbDenialCode; message: string; path: string };
