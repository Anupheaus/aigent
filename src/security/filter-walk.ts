import { FORBIDDEN_KEYS } from './db-field-paths.js';
import type { DbDenialCode, ResolvedDbCollectionRule } from './db-policy-types.js';

/** Operators that run code, read other collections or write: refused wherever they appear, and never allowable. */
export const FORBIDDEN_OPERATORS: ReadonlySet<string> = new Set([
  '$where', '$function', '$accumulator', '$expr', '$jsonSchema', '$lookup', '$graphLookup', '$unionWith', '$out', '$merge',
  '$eval', '$code', '$javascript', '$facet', '$set', '$unset', '$replaceRoot', '$replaceWith',
]);
/** Most nodes (objects, arrays and values) in one filter. */
export const MAX_FILTER_NODES = 10_000;
/** Longest string value in a filter. */
const MAX_STRING_CHARS = 10_000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DECIMAL = /^-?\d{1,34}(?:\.\d{1,34})?(?:[eE][-+]?\d{1,4})?$/;
/** Literal wrappers for values JSON cannot spell (MongoDB extended JSON), checked by their own rule. */
const TAGGED_LITERALS: Readonly<Record<string, (value: unknown) => boolean>> = {
  $oid: value => typeof value === 'string' && OBJECT_ID.test(value),
  $date: value => (typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))) || (typeof value === 'number' && Number.isFinite(value)),
  $numberDecimal: value => typeof value === 'string' && DECIMAL.test(value),
};
const TAGGED_SPELLING: Readonly<Record<string, string>> = { $oid: '24 hexadecimal characters', $date: 'an ISO 8601 date text or epoch milliseconds', $numberDecimal: 'a decimal number as text' };

/** A refused filter: what is wrong and where. */
export interface DbRefusal {
  ok: false;
  code: DbDenialCode;
  message: string;
  path: string;
}

/** The state of one filter walk. */
export interface FilterWalk {
  rule: ResolvedDbCollectionRule;
  limits: { maxDepth: number; maxArrayLength: number };
  /** Nodes seen so far (shared across the whole filter). */
  nodes: { count: number };
}

/** Where a walk is: the node's label (`filter.$or[1].age`) and its nesting depth. */
export interface WalkAt {
  path: string;
  depth: number;
}

export function refuse(params: { code: DbDenialCode; path: string; message: string }): DbRefusal {
  return { ok: false, ...params };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Counts one node; a filter over `MAX_FILTER_NODES` is refused as soon as it gets there. */
function countNode(walk: FilterWalk): DbRefusal | undefined {
  const { nodes } = walk;
  nodes.count += 1;
  if (nodes.count <= MAX_FILTER_NODES) return undefined;
  return refuse({ code: 'too_large', path: 'filter', message: `The filter has more than ${MAX_FILTER_NODES} objects, arrays and values; make it smaller` });
}

/** Counts one object or array node and checks the depth and node limits. */
export function enter(params: { walk: FilterWalk; at: WalkAt }): DbRefusal | undefined {
  const { walk, at: { path, depth } } = params;
  const { maxDepth } = walk.limits;
  const counted = countNode(walk);
  if (counted != null) return counted;
  if (depth > maxDepth) return refuse({ code: 'too_deep', path, message: `The filter is nested deeper than ${maxDepth} levels at '${path}'; flatten it` });
  return undefined;
}

/** Checks an array's length (and counts it as a node). */
export function enterArray(params: { walk: FilterWalk; at: WalkAt; list: unknown[] }): DbRefusal | undefined {
  const { walk, at, list } = params;
  const { maxArrayLength } = walk.limits;
  if (list.length > maxArrayLength) return refuse({ code: 'array_too_long', path: at.path, message: `The array at '${at.path}' has ${list.length} entries; at most ${maxArrayLength} are allowed` });
  return enter({ walk, at });
}

/** The single tagged-literal key of `value` (`$oid`, `$date`, `$numberDecimal`), if that is all it holds. */
export function taggedKey(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  const [only] = keys;
  return keys.length === 1 && only != null && Object.hasOwn(TAGGED_LITERALS, only) ? only : undefined;
}

function checkTagged(params: { key: string; value: unknown; path: string }): DbRefusal | undefined {
  const { key, value, path } = params;
  const isValid = TAGGED_LITERALS[key]?.(value) ?? false;
  if (isValid) return undefined;
  return refuse({ code: 'invalid_operator_value', path: `${path}.${key}`, message: `'${key}' at '${path}' must be ${TAGGED_SPELLING[key] ?? 'a valid value'}, got ${JSON.stringify(value)?.slice(0, 60)}` });
}

function checkLiteralObject(params: { walk: FilterWalk; value: Record<string, unknown>; at: WalkAt }): DbRefusal | undefined {
  const { walk, value, at: { path, depth } } = params;
  const tagged = taggedKey(value);
  if (tagged != null) return checkTagged({ key: tagged, value: value[tagged], path });
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return refuse({ code: 'forbidden_key', path: childPath, message: `Key '${key}' is not allowed in a filter (it could reach an object prototype)` });
    if (FORBIDDEN_OPERATORS.has(key)) return refuse({ code: 'operator_forbidden', path: childPath, message: `Operator '${key}' runs code, reads other collections or writes, and is never allowed` });
    if (key.startsWith('$')) return refuse({ code: 'invalid_operator_value', path: childPath, message: `Field names inside a literal document may not start with '$' (got '${key}' at '${path}')` });
    const refused = checkLiteral({ walk, value: child, at: { path: childPath, depth: depth + 1 } });
    if (refused != null) return refused;
  }
  return undefined;
}

/** A value compared against: JSON primitives, arrays and documents of them, and the tagged literals. Never code. */
export function checkLiteral(params: { walk: FilterWalk; value: unknown; at: WalkAt }): DbRefusal | undefined {
  const { walk, value, at } = params;
  const { path } = at;
  if (!isPlainRecord(value) && !Array.isArray(value)) {
    const counted = countNode(walk);
    if (counted != null) return counted;
  }
  if (value === null || typeof value === 'boolean') return undefined;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? refuse({ code: 'invalid_operator_value', path, message: `The text at '${path}' is ${value.length} characters; at most ${MAX_STRING_CHARS} are allowed` }) : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : refuse({ code: 'invalid_operator_value', path, message: `The number at '${path}' must be finite, got ${String(value)}` });
  if (Array.isArray(value)) {
    const refused = enterArray({ walk, at, list: value });
    if (refused != null) return refused;
    for (const [index, element] of value.entries()) {
      const elementRefused = checkLiteral({ walk, value: element, at: { path: `${path}[${index}]`, depth: at.depth + 1 } });
      if (elementRefused != null) return elementRefused;
    }
    return undefined;
  }
  if (isPlainRecord(value)) return enter({ walk, at }) ?? checkLiteralObject({ walk, value, at });
  return refuse({ code: 'invalid_operator_value', path, message: `The value at '${path}' must be JSON (text, number, boolean, null, array or object), got ${typeof value}` });
}
