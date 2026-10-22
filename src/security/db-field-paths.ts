/** Longest field path accepted. */
const MAX_PATH_CHARS = 200;
/** Keys that could reach an object's prototype when a document or filter is copied or merged. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^\d+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The field rules `fieldAccess` and `pruneDocument` read. */
export interface FieldRules {
  allowFields?: readonly string[];
  denyFields: readonly string[];
}

/** Whether a field may be used: `not_allowed` when outside `allowFields`, `denied` when it touches a denied field. */
export type FieldAccess = 'ok' | 'not_allowed' | 'denied';

/** Why a field path is malformed, or undefined when it is well formed. */
export function pathSyntaxError(path: string): string | undefined {
  if (path === '') return 'a field path is empty';
  if (path.length > MAX_PATH_CHARS) return `a field path is longer than ${MAX_PATH_CHARS} characters`;
  if (CONTROL_CHARACTER.test(path)) return `field path '${path.slice(0, 40)}' holds a control character`;
  const segments = path.split('.');
  if (segments.some(segment => segment === '')) return `field path '${path}' has an empty segment`;
  const operator = segments.find(segment => segment.startsWith('$'));
  if (operator != null) return `field path '${path}' has a segment starting with '$' (${operator}); field names may not start with '$'`;
  return undefined;
}

/** The prototype-reaching segment of a path, if any. */
export function forbiddenSegment(path: string): string | undefined {
  return path.split('.').find(segment => FORBIDDEN_KEYS.has(segment));
}

/** The path without array indexes, so `cards.0.number` is compared as `cards.number`. */
function normalised(path: string): string {
  return path.split('.').filter(segment => !ARRAY_INDEX.test(segment)).join('.');
}

function isAtOrBelow(params: { path: string; base: string }): boolean {
  const { path, base } = params;
  return path === base || path.startsWith(`${base}.`);
}

/**
 * Whether `path` may be filtered on, sorted by or projected: never a denied field, a field below one, or a parent of
 * one (which would carry it); with `allowFields`, only a listed field or one below it.
 */
export function fieldAccess(rules: FieldRules, path: string): FieldAccess {
  const { allowFields, denyFields } = rules;
  const field = normalised(path);
  const touchesDenied = denyFields.some(denied => isAtOrBelow({ path: field, base: denied }) || isAtOrBelow({ path: denied, base: field }));
  if (touchesDenied) return 'denied';
  if (allowFields != null && !allowFields.some(allowed => isAtOrBelow({ path: field, base: allowed }))) return 'not_allowed';
  return 'ok';
}

/**
 * The key sets of the tagged values `toTaggedJson` produces (sorted, comma-joined). Only these are whole values; any
 * other subdocument is walked, even when every key starts with `$`, so it cannot carry fields past `allowFields`.
 */
const TAGGED_SHAPES: ReadonlySet<string> = new Set([
  '$oid', '$date', '$numberDecimal', '$numberLong', '$numberDouble', '$binary', '$options,$regex', '$truncated', '$bsontype,value',
]);

/** Tagged values (`{ $oid }`, `{ $date }`...) are whole values, never walked into. */
function isTaggedValue(value: Record<string, unknown>): boolean {
  return TAGGED_SHAPES.has(Object.keys(value).sort().join(','));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What happens to the field at `path`: dropped, kept whole (still pruned of denied fields below), or walked into. */
function decide(params: { rules: FieldRules; path: string }): 'drop' | 'keep' | 'walk' {
  const { rules: { allowFields, denyFields }, path } = params;
  const field = normalised(path);
  if (denyFields.some(denied => isAtOrBelow({ path: field, base: denied }))) return 'drop';
  if (allowFields == null || allowFields.some(allowed => isAtOrBelow({ path: field, base: allowed }))) return 'keep';
  return allowFields.some(allowed => isAtOrBelow({ path: allowed, base: field })) ? 'walk' : 'drop';
}

function pruneValue(params: { rules: FieldRules; value: unknown; prefix: string; restricted: boolean }): unknown {
  const { rules, value, prefix, restricted } = params;
  if (Array.isArray(value)) return value.map(element => pruneValue({ rules, value: element, prefix, restricted }));
  if (!isPlainRecord(value) || isTaggedValue(value)) return value;
  const pruned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const decision = decide({ rules: restricted ? rules : { denyFields: rules.denyFields }, path });
    if (decision === 'drop') continue;
    // A walked-into parent keeps only what leads to allowed fields; inside an allowed field everything but denied fields stays.
    const kept = pruneValue({ rules, value: child, prefix: path, restricted: decision === 'walk' });
    // A parent only walked through that kept nothing is left out (as a projection would).
    if (decision === 'walk' && isPlainRecord(kept) && Object.keys(kept).length === 0) continue;
    pruned[key] = kept;
  }
  return pruned;
}

/**
 * A copy of `doc` without denied fields (at any depth, through arrays) and, with `allowFields`, with only the allowed
 * fields and the parents leading to them. Prototype keys are never copied.
 */
export function pruneDocument(rules: FieldRules, doc: Record<string, unknown>): Record<string, unknown> {
  return pruneValue({ rules, value: doc, prefix: '', restricted: rules.allowFields != null }) as Record<string, unknown>;
}
