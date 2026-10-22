import { createAigentError } from '../core/aigent-error.js';
import { fieldAccess, forbiddenSegment, pathSyntaxError } from './db-field-paths.js';
import type { DbCollectionRule, DbPolicy, DbPolicyOptions, DbQueryRequest, DbQueryValidation, ResolvedDbCollectionRule } from './db-policy-types.js';
import { DEFAULT_FILTER_OPERATORS, SUPPORTED_FILTER_OPERATORS, validateFilter } from './filter-validate.js';
import { FORBIDDEN_OPERATORS, refuse } from './filter-walk.js';
import type { DbRefusal } from './filter-walk.js';

/** Most documents one query returns unless the collection's rule says otherwise. */
export const DEFAULT_MAX_LIMIT = 200;
/** Server-side time limit of one query unless the collection's rule says otherwise. */
export const DEFAULT_MAX_TIME_MS = 5_000;
/** Documents returned when a query names no limit (or the collection maximum, if lower). */
export const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY_LENGTH = 1_000;
const MAX_SORT_KEYS = 8;
const MAX_SKIP = 1_000_000;
const ID_FIELD = '_id';
const ARRAY_INDEX_SEGMENT = /^\d+$/;

function invalidDefinition(message: string, details: Record<string, unknown>): never {
  throw createAigentError({ code: 'invalid_definition', message: `createDbPolicy: ${message}`, details });
}

function positiveInteger(params: { value: unknown; fallback: number; label: string }): number {
  const { value, fallback, label } = params;
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidDefinition(`${label} must be a positive integer, got ${String(value)}`, { option: label });
  return value as number;
}

function checkFieldList(params: { fields: unknown; label: string }): string[] | undefined {
  const { fields, label } = params;
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields)) return invalidDefinition(`${label} must be an array of field paths`, { option: label });
  for (const field of fields) {
    const problem = typeof field === 'string' ? pathSyntaxError(field) ?? (forbiddenSegment(field) == null ? undefined : 'a prototype key') : 'not text';
    if (problem != null) invalidDefinition(`${label} entry ${JSON.stringify(field)} is not a valid field path (${problem})`, { option: label });
    // A rule names a field, which covers every array element; an index would guard (or allow) one spelling only.
    const segments = (field as string).split('.');
    if (segments.some(segment => ARRAY_INDEX_SEGMENT.test(segment))) {
      invalidDefinition(`${label} entry '${String(field)}' holds an array index; name the field without it ('${segments.filter(segment => !ARRAY_INDEX_SEGMENT.test(segment)).join('.')}'), which covers every element`, { option: label });
    }
  }
  return [...fields] as string[];
}

function resolveOperators(params: { allowOperators: unknown; label: string }): ReadonlySet<string> {
  const { allowOperators, label } = params;
  if (allowOperators === undefined) return new Set(DEFAULT_FILTER_OPERATORS);
  if (!Array.isArray(allowOperators)) return invalidDefinition(`${label} must be an array of operators`, { option: label });
  for (const operator of allowOperators) {
    if (FORBIDDEN_OPERATORS.has(operator)) invalidDefinition(`${label} names '${String(operator)}', which runs code, reads other collections or writes and can never be allowed`, { option: label, operator });
    if (!SUPPORTED_FILTER_OPERATORS.includes(operator)) invalidDefinition(`${label} names '${String(operator)}'; supported: ${SUPPORTED_FILTER_OPERATORS.join(', ')}`, { option: label, operator });
  }
  return new Set(allowOperators as string[]);
}

function resolveRule(params: { name: string; rule: DbCollectionRule }): ResolvedDbCollectionRule | undefined {
  const { name, rule } = params;
  const label = `collections.${name}`;
  const { permissions } = rule ?? {};
  if (!Array.isArray(permissions) || permissions.some(permission => permission !== 'read')) {
    invalidDefinition(`${label}.permissions must list only 'read' (the database pack is read-only), got ${JSON.stringify(permissions)}`, { collection: name });
  }
  const allowFields = checkFieldList({ fields: rule.allowFields, label: `${label}.allowFields` });
  const resolved: ResolvedDbCollectionRule = {
    ...(allowFields == null ? {} : { allowFields }),
    denyFields: checkFieldList({ fields: rule.denyFields, label: `${label}.denyFields` }) ?? [],
    maxLimit: positiveInteger({ value: rule.maxLimit, fallback: DEFAULT_MAX_LIMIT, label: `${label}.maxLimit` }),
    maxTimeMs: positiveInteger({ value: rule.maxTimeMs, fallback: DEFAULT_MAX_TIME_MS, label: `${label}.maxTimeMs` }),
    allowOperators: resolveOperators({ allowOperators: rule.allowOperators, label: `${label}.allowOperators` }),
    requiresApproval: rule.requiresApproval === true,
  };
  return permissions.includes('read') ? resolved : undefined;
}

/** The database authority: deny by default, read-only, per-collection fields, operators and limits. */
export function createDbPolicy(options: DbPolicyOptions): DbPolicy {
  const { collections, maxDepth, maxArrayLength } = options ?? {};
  if (typeof collections !== 'object' || collections === null) invalidDefinition('collections must be an object of collection rules', { option: 'collections' });
  // A map without a prototype, so names such as `constructor` or `__proto__` are never found by accident.
  const rules = new Map<string, ResolvedDbCollectionRule>();
  for (const [name, rule] of Object.entries(collections)) {
    const resolved = resolveRule({ name, rule });
    if (resolved != null) rules.set(name, resolved);
  }
  const limits = {
    maxDepth: positiveInteger({ value: maxDepth, fallback: DEFAULT_MAX_DEPTH, label: 'maxDepth' }),
    maxArrayLength: positiveInteger({ value: maxArrayLength, fallback: DEFAULT_MAX_ARRAY_LENGTH, label: 'maxArrayLength' }),
  };
  return { rule: collection => rules.get(collection), collections: () => [...rules.keys()].sort(), limits };
}

function checkPath(params: { rule: ResolvedDbCollectionRule; field: unknown; path: string }): DbRefusal | undefined {
  const { rule, field, path } = params;
  if (typeof field !== 'string') return refuse({ code: 'invalid_field', path, message: `The field at '${path}' must be a field path as text` });
  const problem = pathSyntaxError(field) ?? (forbiddenSegment(field) == null ? undefined : `field path '${field}' holds a prototype key`);
  if (problem != null) return refuse({ code: 'invalid_field', path, message: problem });
  const access = fieldAccess(rule, field);
  if (access === 'ok') return undefined;
  const why = access === 'denied' ? 'is denied (or would carry a denied field)' : `is not one of the allowed fields (${(rule.allowFields ?? []).join(', ')})`;
  return refuse({ code: 'field_denied', path, message: `Field '${field}' ${why}` });
}

/** The server-side projection: the requested (checked) fields, else the allowed fields, else every field but the denied ones. */
function projectionFor(params: { rule: ResolvedDbCollectionRule; requested?: string[] }): Record<string, 0 | 1> | undefined {
  const { rule, requested } = params;
  const { allowFields, denyFields } = rule;
  const included = requested != null && requested.length > 0 ? requested : allowFields;
  if (included == null) return denyFields.length === 0 ? undefined : Object.fromEntries(denyFields.map(field => [field, 0 as const]));
  const projection: Record<string, 0 | 1> = Object.fromEntries(included.map(field => [field, 1 as const]));
  // MongoDB returns _id unless told not to; hide it when the rules do.
  if (!included.includes(ID_FIELD) && fieldAccess(rule, ID_FIELD) !== 'ok') projection[ID_FIELD] = 0;
  return projection;
}

function checkShape(params: { rule: ResolvedDbCollectionRule; request: DbQueryRequest }): DbRefusal | undefined {
  const { rule, request: { projection = [], sort = [], limit, skip } } = params;
  for (const [index, field] of projection.entries()) {
    const refused = checkPath({ rule, field, path: `projection[${index}]` });
    if (refused != null) return refused;
  }
  if (sort.length > MAX_SORT_KEYS) return refuse({ code: 'invalid_sort', path: 'sort', message: `At most ${MAX_SORT_KEYS} sort keys are allowed, got ${sort.length}` });
  for (const [index, key] of sort.entries()) {
    if (key?.direction !== 'asc' && key?.direction !== 'desc') return refuse({ code: 'invalid_sort', path: `sort[${index}].direction`, message: `Sort direction must be 'asc' or 'desc', got ${JSON.stringify(key?.direction)}` });
    const refused = checkPath({ rule, field: key.field, path: `sort[${index}].field` });
    if (refused != null) return refused;
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > rule.maxLimit)) return refuse({ code: 'limit_exceeded', path: 'limit', message: `limit must be an integer from 1 to ${rule.maxLimit} for this collection, got ${String(limit)}` });
  if (skip !== undefined && (!Number.isSafeInteger(skip) || skip < 0 || skip > MAX_SKIP)) return refuse({ code: 'invalid_skip', path: 'skip', message: `skip must be an integer from 0 to ${MAX_SKIP}, got ${String(skip)}` });
  return undefined;
}

/**
 * Checks a query against the policy: the collection, every filter operator, field, value and size, the projection,
 * sort, limit and skip. Never throws; a refusal names its code and where in the request the problem is.
 */
export function validateQuery(policy: DbPolicy, request: DbQueryRequest): DbQueryValidation {
  const { collection, filter = {}, projection, sort, limit, skip } = request;
  const rule = typeof collection === 'string' ? policy.rule(collection) : undefined;
  if (rule == null) return refuse({ code: 'collection_denied', path: 'collection', message: `Collection ${JSON.stringify(collection)} is not readable; readable collections: ${policy.collections().join(', ') || '(none)'}` });
  const refused = checkShape({ rule, request }) ?? validateFilter({ filter: filter ?? {}, rule, limits: policy.limits });
  if (refused != null) return refused;
  const resolvedProjection = projectionFor({ rule, ...(projection == null ? {} : { requested: projection }) });
  return {
    ok: true,
    query: {
      collection, filter: (filter ?? {}) as Record<string, unknown>,
      ...(resolvedProjection == null ? {} : { projection: resolvedProjection }),
      ...(sort == null || sort.length === 0 ? {} : { sort }),
      limit: limit ?? Math.min(DEFAULT_QUERY_LIMIT, rule.maxLimit),
      ...(skip == null ? {} : { skip }),
      maxTimeMs: rule.maxTimeMs,
    },
  };
}
