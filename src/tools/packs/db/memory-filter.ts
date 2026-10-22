import { createAigentError } from '../../../core/aigent-error.js';
import type { RegexTest } from './memory-regex.js';

/** A value's comparison bracket and key: MongoDB compares only values of the same bracket (`$gt: 5` never matches text). */
interface Comparable {
  bracket: 'null' | 'number' | 'string' | 'oid' | 'bool' | 'date' | 'other';
  key: number | string;
}

const ARRAY_INDEX = /^\d+$/;
/** Sort order of brackets, as MongoDB orders BSON types (null, numbers, text, objects, arrays, ObjectId, booleans, dates). */
const BRACKET_ORDER: Readonly<Record<Comparable['bracket'], number>> = { null: 0, number: 1, string: 2, other: 3, oid: 4, bool: 5, date: 6 };
/** `$type` names and numbers, mapped to the bracket or shape they match. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  1: 'number', 2: 'string', 3: 'object', 4: 'array', 7: 'objectId', 8: 'bool', 9: 'date', 10: 'null', 16: 'number', 18: 'number', 19: 'number',
  double: 'number', int: 'number', long: 'number', decimal: 'number', number: 'number', string: 'string', object: 'object', array: 'array', objectId: 'objectId', bool: 'bool', date: 'date', null: 'null',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOperatorDocument(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const isTagged = keys.length === 1 && ['$oid', '$date', '$numberDecimal', '$numberLong'].includes(keys[0] ?? '');
  return keys.length > 0 && !isTagged && keys.every(key => key.startsWith('$'));
}

function comparable(value: unknown): Comparable {
  if (value === null || value === undefined) return { bracket: 'null', key: 0 };
  if (typeof value === 'number') return { bracket: 'number', key: value };
  if (typeof value === 'string') return { bracket: 'string', key: value };
  if (typeof value === 'boolean') return { bracket: 'bool', key: value ? 1 : 0 };
  if (isRecord(value)) {
    if (typeof value.$oid === 'string') return { bracket: 'oid', key: value.$oid.toLowerCase() };
    if (typeof value.$date === 'string' || typeof value.$date === 'number') return { bracket: 'date', key: new Date(value.$date).getTime() };
    if (typeof value.$numberDecimal === 'string') return { bracket: 'number', key: Number(value.$numberDecimal) };
    if (typeof value.$numberLong === 'string') return { bracket: 'number', key: Number(value.$numberLong) };
  }
  return { bracket: 'other', key: JSON.stringify(value) };
}

/** Orders two values as MongoDB sorts them (bracket first, then value). */
export function compareValues(left: unknown, right: unknown): number {
  const one = comparable(left);
  const other = comparable(right);
  if (one.bracket !== other.bracket) return BRACKET_ORDER[one.bracket] - BRACKET_ORDER[other.bracket];
  if (one.key === other.key) return 0;
  return one.key < other.key ? -1 : 1;
}

function equals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return compareValues(left, right) === 0;
}

/** Every value a dotted path reaches, through arrays (MongoDB's implicit array traversal). */
export function valuesAt(params: { doc: unknown; path: string }): unknown[] {
  const { doc, path } = params;
  let current: unknown[] = [doc];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        if (ARRAY_INDEX.test(segment) && Number(segment) < value.length) next.push(value[Number(segment)]);
        for (const element of value) if (isRecord(element) && Object.hasOwn(element, segment)) next.push(element[segment]);
      } else if (isRecord(value) && Object.hasOwn(value, segment)) next.push(value[segment]);
    }
    current = next;
  }
  return current;
}

/** A leaf array matches through its elements as well as itself. */
function candidatesOf(values: unknown[]): unknown[] {
  return values.flatMap(value => (Array.isArray(value) ? [value, ...value] : [value]));
}

function typeMatches(params: { value: unknown; name: string }): boolean {
  const { value, name } = params;
  const wanted = TYPE_ALIASES[name] ?? name;
  if (wanted === 'array') return Array.isArray(value);
  if (wanted === 'object') return isRecord(value) && comparable(value).bracket === 'other';
  if (wanted === 'objectId') return comparable(value).bracket === 'oid';
  return !Array.isArray(value) && comparable(value).bracket === wanted;
}

function matchesEquality(params: { values: unknown[]; literal: unknown }): boolean {
  const { values, literal } = params;
  if (literal === null && values.length === 0) return true;
  return candidatesOf(values).some(candidate => equals(candidate, literal));
}

function matchesOperator(params: { values: unknown[]; operator: string; operand: unknown; expression: Record<string, unknown>; testRegex: RegexTest }): boolean {
  const { values, operator, operand, expression, testRegex } = params;
  const candidates = candidatesOf(values);
  const ordered = (test: (order: number) => boolean): boolean => candidates.some(candidate => !Array.isArray(candidate) && comparable(candidate).bracket === comparable(operand).bracket && test(compareValues(candidate, operand)));
  switch (operator) {
    case '$eq': return matchesEquality({ values, literal: operand });
    case '$ne': return !matchesEquality({ values, literal: operand });
    case '$gt': return ordered(order => order > 0);
    case '$gte': return ordered(order => order >= 0);
    case '$lt': return ordered(order => order < 0);
    case '$lte': return ordered(order => order <= 0);
    case '$in': return (operand as unknown[]).some(literal => matchesEquality({ values, literal }));
    case '$nin': return !(operand as unknown[]).some(literal => matchesEquality({ values, literal }));
    case '$all': return values.some(value => Array.isArray(value) && (operand as unknown[]).every(literal => value.some(element => equals(element, literal))));
    case '$exists': return (values.length > 0) === operand;
    case '$size': return values.some(value => Array.isArray(value) && value.length === operand);
    case '$type': return (Array.isArray(operand) ? operand : [operand]).some(name => candidates.some(value => typeMatches({ value, name: String(name) })));
    case '$regex': {
      const options = typeof expression.$options === 'string' ? expression.$options : '';
      return candidates.some(candidate => typeof candidate === 'string' && testRegex({ pattern: operand as string, options, text: candidate }));
    }
    case '$options': return true;
    case '$mod': {
      const [divisor, remainder] = operand as [number, number];
      return candidates.some(candidate => typeof candidate === 'number' && Math.trunc(candidate) % Math.trunc(divisor) === Math.trunc(remainder));
    }
    case '$not': return !matchesExpression({ values, expression: operand as Record<string, unknown>, testRegex });
    case '$elemMatch': return values.some(value => Array.isArray(value) && value.some(element => (isOperatorDocument(operand) ? matchesExpression({ values: [element], expression: operand, testRegex }) : isRecord(element) && matchesFilter({ doc: element, filter: operand as Record<string, unknown>, testRegex }))));
    default: throw createAigentError({ code: 'invalid_input', message: `The in-memory database does not support operator '${operator}'; it supports the database pack's operators only`, details: { operator } });
  }
}

function matchesExpression(params: { values: unknown[]; expression: Record<string, unknown>; testRegex: RegexTest }): boolean {
  const { values, expression, testRegex } = params;
  return Object.entries(expression).every(([operator, operand]) => matchesOperator({ values, operator, operand, expression, testRegex }));
}

/**
 * Whether a document (tagged JSON) matches a filter in the operator subset the database pack allows. `$regex`
 * answers come from `testRegex` (see `prepareRegexTest`), so no model pattern runs on this thread.
 */
export function matchesFilter(params: { doc: Record<string, unknown>; filter: Record<string, unknown>; testRegex: RegexTest }): boolean {
  const { doc, filter, testRegex } = params;
  return Object.entries(filter).every(([key, condition]) => {
    const branches = condition as Record<string, unknown>[];
    if (key === '$and') return branches.every(branch => matchesFilter({ doc, filter: branch, testRegex }));
    if (key === '$or') return branches.some(branch => matchesFilter({ doc, filter: branch, testRegex }));
    if (key === '$nor') return !branches.some(branch => matchesFilter({ doc, filter: branch, testRegex }));
    const values = valuesAt({ doc, path: key });
    return isOperatorDocument(condition) ? matchesExpression({ values, expression: condition, testRegex }) : matchesEquality({ values, literal: condition });
  });
}
