import { countUnboundedQuantifiers, unsafeShape } from '../tools/packs/regex-shape.js';
import { fieldAccess, FORBIDDEN_KEYS, forbiddenSegment, pathSyntaxError } from './db-field-paths.js';
import type { ResolvedDbCollectionRule } from './db-policy-types.js';
import { checkLiteral, enter, enterArray, FORBIDDEN_OPERATORS, isPlainRecord, refuse, taggedKey } from './filter-walk.js';
import type { DbRefusal, FilterWalk, WalkAt } from './filter-walk.js';
import { stripExtendedSyntax } from './regex-extended.js';

/** The operators a collection allows unless its rule says otherwise. */
export const DEFAULT_FILTER_OPERATORS: readonly string[] = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex',
  '$size', '$all', '$elemMatch',
];
/** Every operator `allowOperators` may name. */
export const SUPPORTED_FILTER_OPERATORS: readonly string[] = [...DEFAULT_FILTER_OPERATORS, '$mod'];
/** Longest `$regex` pattern. */
export const MAX_REGEX_CHARS = 200;
/**
 * Most unbounded repetitions in one `$regex`. The shape scan is a heuristic; capping the count bounds the polynomial
 * degree of any shape it misses, and the database's `maxTimeMS` bounds the rest.
 */
export const MAX_UNBOUNDED_QUANTIFIERS = 3;

const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(['$and', '$or', '$nor']);
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);
const LIST_OPERATORS: ReadonlySet<string> = new Set(['$in', '$nin', '$all']);
const REGEX_OPTIONS = /^[imsx]{0,4}$/;
const MAX_TYPE_NAMES = 20;

function forbidden(path: string, operator: string): DbRefusal {
  return refuse({ code: 'operator_forbidden', path, message: `Operator '${operator}' runs code, reads other collections or writes, and is never allowed` });
}

function badValue(path: string, expected: string): DbRefusal {
  return refuse({ code: 'invalid_operator_value', path, message: `The value at '${path}' must be ${expected}` });
}

/** Refuses an operator the collection does not allow (or that is unknown), with the allowed list. */
function checkAllowed(params: { walk: FilterWalk; operator: string; path: string }): DbRefusal | undefined {
  const { walk: { rule }, operator, path } = params;
  if (FORBIDDEN_OPERATORS.has(operator)) return forbidden(path, operator);
  if (rule.allowOperators.has(operator)) return undefined;
  return refuse({ code: 'operator_not_allowed', path, message: `Operator '${operator}' is not allowed here; allowed: ${[...rule.allowOperators].sort().join(', ')}` });
}

function checkRegex(params: { expression: Record<string, unknown>; path: string }): DbRefusal | undefined {
  const { expression, path } = params;
  const { $regex: pattern, $options: options } = expression;
  if (typeof pattern !== 'string') return badValue(path, 'a regular expression as text');
  const flags = typeof options === 'string' ? options : '';
  if (pattern.length > MAX_REGEX_CHARS) return refuse({ code: 'unsafe_regex', path, message: `The pattern at '${path}' is ${pattern.length} characters; at most ${MAX_REGEX_CHARS} are allowed` });
  const validFlags = REGEX_OPTIONS.test(flags) ? flags : '';
  // Under `x` the engine ignores whitespace and comments, so the scan must see the pattern without them.
  const effective = validFlags.includes('x') ? stripExtendedSyntax(pattern) : pattern;
  const unbounded = countUnboundedQuantifiers(effective);
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return refuse({ code: 'unsafe_regex', path, message: `The pattern at '${path}' has ${unbounded} unbounded repetitions (*, + or {n,}); at most ${MAX_UNBOUNDED_QUANTIFIERS} are allowed, so bound the rest, e.g. {1,20}` });
  const shape = unsafeShape({ pattern: effective, flags: validFlags.replace(/x/g, '') });
  if (shape != null) return refuse({ code: 'unsafe_regex', path, message: `The pattern at '${path}' can backtrack catastrophically (${shape}); simplify it` });
  try {
    new RegExp(effective);
  } catch (error) {
    return badValue(path, `a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
  }
  return undefined;
}

/** One operator's operand. */
function checkOperand(params: { walk: FilterWalk; expression: Record<string, unknown>; operator: string; at: WalkAt; field: string }): DbRefusal | undefined {
  const { walk, expression, operator, at, field } = params;
  const operand = expression[operator];
  const { path, depth } = at;
  if (COMPARISON_OPERATORS.has(operator)) return checkLiteral({ walk, value: operand, at });
  if (LIST_OPERATORS.has(operator)) return Array.isArray(operand) ? checkLiteral({ walk, value: operand, at }) : badValue(path, 'an array of values');
  if (operator === '$exists') return typeof operand === 'boolean' ? undefined : badValue(path, 'true or false');
  if (operator === '$size') return Number.isSafeInteger(operand) && (operand as number) >= 0 ? undefined : badValue(path, 'a non-negative integer');
  if (operator === '$regex') return checkRegex({ expression, path });
  if (operator === '$type') {
    const names = Array.isArray(operand) ? operand : [operand];
    const isValid = names.length > 0 && names.length <= MAX_TYPE_NAMES && names.every(name => typeof name === 'string' || Number.isSafeInteger(name));
    return isValid ? undefined : badValue(path, `a type name or number, or a list of up to ${MAX_TYPE_NAMES}`);
  }
  if (operator === '$mod') {
    const isValid = Array.isArray(operand) && operand.length === 2 && operand.every(Number.isFinite) && operand[0] !== 0;
    return isValid ? undefined : badValue(path, 'a [divisor, remainder] pair of numbers with a non-zero divisor');
  }
  if (operator === '$not') return isPlainRecord(operand) && Object.keys(operand).length > 0 && Object.keys(operand).every(key => key.startsWith('$')) ? checkExpression({ walk, expression: operand, at, field }) : badValue(path, 'an operator document such as {"$gt": 5}');
  if (!isPlainRecord(operand)) return badValue(path, 'a filter document or operator document');
  // `$elemMatch` takes operators on the elements themselves, or a filter over the elements' fields.
  const isOperatorDocument = Object.keys(operand).length > 0 && Object.keys(operand).every(key => key.startsWith('$')) && taggedKey(operand) == null;
  if (isOperatorDocument) return checkExpression({ walk, expression: operand, at, field });
  return checkFilterDocument({ walk, filter: operand, at: { path, depth }, prefix: field });
}

/** An operator document on one field (`{ "$gt": 1, "$lt": 9 }`). */
function checkExpression(params: { walk: FilterWalk; expression: Record<string, unknown>; at: WalkAt; field: string }): DbRefusal | undefined {
  const { walk, expression, at, field } = params;
  const entered = enter({ walk, at });
  if (entered != null) return entered;
  for (const operator of Object.keys(expression)) {
    const path = `${at.path}.${operator}`;
    if (operator === '$options') {
      const options = expression.$options;
      if (!('$regex' in expression) || typeof options !== 'string' || !REGEX_OPTIONS.test(options)) return badValue(path, "flags from 'imsx' next to a $regex");
      continue;
    }
    if (LOGICAL_OPERATORS.has(operator)) return refuse({ code: 'operator_not_allowed', path, message: `Operator '${operator}' is only valid at the top of a filter, not on field '${field}'` });
    const refused = checkAllowed({ walk, operator, path }) ?? checkOperand({ walk, expression, operator, at: { path, depth: at.depth + 1 }, field });
    if (refused != null) return refused;
  }
  return undefined;
}

/** A field's condition: a literal (equality), a tagged literal, or an operator document. */
function checkCondition(params: { walk: FilterWalk; value: unknown; at: WalkAt; field: string }): DbRefusal | undefined {
  const { walk, value, at, field } = params;
  if (!isPlainRecord(value) || taggedKey(value) != null) return checkLiteral({ walk, value, at });
  const keys = Object.keys(value);
  const operators = keys.filter(key => key.startsWith('$'));
  if (operators.length === 0) return checkLiteral({ walk, value, at });
  if (operators.length !== keys.length) return refuse({ code: 'invalid_filter', path: at.path, message: `The condition at '${at.path}' mixes operators (${operators.join(', ')}) with field names; use one or the other` });
  return checkExpression({ walk, expression: value, at, field });
}

function checkField(params: { walk: FilterWalk; key: string; prefix: string; path: string }): DbRefusal | undefined {
  const { walk: { rule }, key, prefix, path } = params;
  const syntax = pathSyntaxError(key);
  if (syntax != null) return refuse({ code: 'invalid_field', path, message: syntax });
  const segment = forbiddenSegment(key);
  if (segment != null) return refuse({ code: 'forbidden_key', path, message: `Field path '${key}' holds '${segment}', which could reach an object prototype` });
  const field = prefix === '' ? key : `${prefix}.${key}`;
  const access = fieldAccess(rule, field);
  if (access === 'denied') return refuse({ code: 'field_denied', path, message: `Field '${field}' is denied (or holds a denied field) and cannot be queried` });
  if (access === 'not_allowed') return refuse({ code: 'field_denied', path, message: `Field '${field}' is not one of the allowed fields: ${(rule.allowFields ?? []).join(', ')}` });
  return undefined;
}

function checkLogical(params: { walk: FilterWalk; operand: unknown; at: WalkAt; prefix: string }): DbRefusal | undefined {
  const { walk, operand, at, prefix } = params;
  if (!Array.isArray(operand) || operand.length === 0) return badValue(at.path, 'a non-empty array of filter documents');
  const refused = enterArray({ walk, at, list: operand });
  if (refused != null) return refused;
  for (const [index, filter] of operand.entries()) {
    const childRefused = checkFilterDocument({ walk, filter, at: { path: `${at.path}[${index}]`, depth: at.depth + 1 }, prefix });
    if (childRefused != null) return childRefused;
  }
  return undefined;
}

/** A filter document: field conditions and logical operators, with field paths relative to `prefix`. */
function checkFilterDocument(params: { walk: FilterWalk; filter: unknown; at: WalkAt; prefix: string }): DbRefusal | undefined {
  const { walk, filter, at, prefix } = params;
  if (!isPlainRecord(filter)) return refuse({ code: 'invalid_filter', path: at.path, message: `The filter at '${at.path}' must be a JSON object such as {"status": "open"}, got ${Array.isArray(filter) ? 'an array' : typeof filter}` });
  const entered = enter({ walk, at });
  if (entered != null) return entered;
  for (const [key, value] of Object.entries(filter)) {
    const path = `${at.path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) return refuse({ code: 'forbidden_key', path, message: `Key '${key}' is not allowed in a filter (it could reach an object prototype)` });
    const child: WalkAt = { path, depth: at.depth + 1 };
    const refused = key.startsWith('$')
      ? checkAllowed({ walk, operator: key, path }) ?? (LOGICAL_OPERATORS.has(key) ? checkLogical({ walk, operand: value, at: child, prefix }) : refuse({ code: 'operator_not_allowed', path, message: `Operator '${key}' is not valid at the top of a filter; use $and, $or or $nor, or put it on a field` }))
      : checkField({ walk, key, prefix, path }) ?? checkCondition({ walk, value, at: child, field: prefix === '' ? key : `${prefix}.${key}` });
    if (refused != null) return refused;
  }
  return undefined;
}

/** Checks a whole filter against a collection's rule: the first problem found, or undefined when it may run. */
export function validateFilter(params: { filter: unknown; rule: ResolvedDbCollectionRule; limits: { maxDepth: number; maxArrayLength: number } }): DbRefusal | undefined {
  const { filter, rule, limits } = params;
  const walk: FilterWalk = { rule, limits, nodes: { count: 0 } };
  return checkFilterDocument({ walk, filter, at: { path: 'filter', depth: 1 }, prefix: '' });
}
