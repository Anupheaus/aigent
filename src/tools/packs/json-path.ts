import { createAigentError } from '../../core/aigent-error.js';

type JsonValue = unknown;

type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** One step of a parsed query. */
type Step =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'descend'; then: Step }
  | { kind: 'filter'; path: string[]; op?: CompareOp; value?: JsonValue };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const OPERATORS: readonly CompareOp[] = ['==', '!=', '<=', '>=', '<', '>'];

function invalid(params: { query: string; position: number; expected: string }): never {
  const { query, position, expected } = params;
  throw createAigentError({ code: 'invalid_input', message: `Query '${query}': expected ${expected} at character ${position + 1}`, details: { reason: 'invalid_query', position } });
}

/** Parses the supported JSONPath subset into steps. */
function parse(query: string): Step[] {
  let position = 0;
  const at = (expected: string): never => invalid({ query, position, expected });
  if (query[0] !== '$') at("'$' to start the query");
  position = 1;
  const steps: Step[] = [];

  function literal(): JsonValue {
    const rest = query.slice(position);
    const quoted = /^'([^']*)'|^"([^"]*)"/.exec(rest);
    if (quoted != null) { position += quoted[0].length; return quoted[1] ?? quoted[2]; }
    const plain = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(rest);
    if (plain == null) return at('a number, a quoted string, true, false or null');
    position += plain[0].length;
    return JSON.parse(plain[0]);
  }

  function filter(): Step {
    // [?(@.a.b op value)] or [?(@.a)]
    if (!query.startsWith('?(@', position)) at("'?(@' to start a filter");
    position += 3;
    const path: string[] = [];
    while (query[position] === '.') {
      position += 1;
      const name = IDENTIFIER.exec(query.slice(position))?.[0];
      if (name == null) return at('a field name after @.');
      path.push(name);
      position += name.length;
    }
    while (query[position] === ' ') position += 1;
    if (query[position] === ')') { position += 1; return { kind: 'filter', path }; }
    const op = OPERATORS.find(candidate => query.startsWith(candidate, position));
    if (op == null) return at('a comparison (==, !=, <, <=, >, >=) or )');
    position += op.length;
    while (query[position] === ' ') position += 1;
    const value = literal();
    while (query[position] === ' ') position += 1;
    if (query[position] !== ')') at("')' to close the filter");
    position += 1;
    return { kind: 'filter', path, op, value };
  }

  function bracket(): Step {
    position += 1;
    let step: Step;
    const rest = query.slice(position);
    const quoted = /^'([^']*)'|^"([^"]*)"/.exec(rest);
    const index = /^-?\d+/.exec(rest);
    if (rest.startsWith('*')) { position += 1; step = { kind: 'wildcard' }; }
    else if (rest.startsWith('?')) step = filter();
    else if (quoted != null) { position += quoted[0].length; step = { kind: 'key', key: quoted[1] ?? quoted[2] ?? '' }; }
    else if (index != null) { position += index[0].length; step = { kind: 'index', index: Number(index[0]) }; }
    else return at("an index, '*', a quoted key or a filter inside [ ]");
    if (query[position] !== ']') at("']'");
    position += 1;
    return step;
  }

  function dotted(): Step {
    if (query[position] === '*') { position += 1; return { kind: 'wildcard' }; }
    const name = IDENTIFIER.exec(query.slice(position))?.[0];
    if (name == null) return at("a field name or '*' after '.'");
    position += name.length;
    return { kind: 'key', key: name };
  }

  while (position < query.length) {
    if (query.startsWith('..', position)) {
      position += 2;
      steps.push({ kind: 'descend', then: query[position] === '[' ? bracket() : dotted() });
    } else if (query[position] === '.') {
      position += 1;
      steps.push(dotted());
    } else if (query[position] === '[') {
      steps.push(bracket());
    } else {
      at("'.', '..' or '['");
    }
  }
  return steps;
}

function children(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'object' && value !== null ? Object.values(value) : [];
}

/** Most values a query may produce at any step: `..` chains grow fast, and every value is materialised. */
export const MAX_JSON_RESULTS = 100_000;

function tooMany(): never {
  throw createAigentError({ code: 'invalid_input', message: `The query produces more than ${MAX_JSON_RESULTS} values`, details: { reason: 'too_many_results', limit: MAX_JSON_RESULTS } });
}

/** The value and everything below it, in document order (iterative, so deep documents cannot overflow the stack). */
function descendants(value: JsonValue): JsonValue[] {
  const found: JsonValue[] = [];
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const next = pending.pop() as JsonValue;
    found.push(next);
    if (found.length > MAX_JSON_RESULTS) tooMany();
    const below = children(next);
    for (let at = below.length - 1; at >= 0; at -= 1) pending.push(below[at] as JsonValue);
  }
  return found;
}

function compare(params: { left: JsonValue; op: CompareOp; right: JsonValue }): boolean {
  const { left, op, right } = params;
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (typeof left !== typeof right || (typeof left !== 'number' && typeof left !== 'string')) return false;
  const [a, b] = [left as number | string, right as number | string];
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}

function apply(params: { step: Step; value: JsonValue }): JsonValue[] {
  const { step, value } = params;
  switch (step.kind) {
    case 'key': return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, step.key) ? [(value as Record<string, JsonValue>)[step.key]] : [];
    case 'index': {
      if (!Array.isArray(value)) return [];
      const index = step.index < 0 ? value.length + step.index : step.index;
      return index >= 0 && index < value.length ? [value[index]] : [];
    }
    case 'wildcard': return children(value);
    case 'descend': return descendants(value).flatMap(node => apply({ step: step.then, value: node }));
    case 'filter': return children(value).filter(child => {
      let field: JsonValue = child;
      for (const key of step.path) field = typeof field === 'object' && field !== null && Object.hasOwn(field, key) ? (field as Record<string, JsonValue>)[key] : undefined;
      return step.op == null ? field !== undefined : compare({ left: field, op: step.op, right: step.value });
    });
  }
}

/**
 * Runs a JSONPath subset over a parsed document: `$`, `.key` / `['key']`, `[n]` (negative from the end), `*` / `[*]`,
 * `..key` (recursive descent) and filters `[?(@.a.b op literal)]` (`== != < <= > >=`) or `[?(@.a)]` (field present).
 * Returns the matches in document order. Throws `invalid_input` (`details.reason: 'invalid_query'`, `position`), or `too_many_results` past `MAX_JSON_RESULTS`.
 */
export function queryJsonPath(params: { document: JsonValue; query: string }): JsonValue[] {
  const { document, query } = params;
  let current: JsonValue[] = [document];
  for (const step of parse(query)) {
    const next: JsonValue[] = [];
    for (const value of current) {
      for (const result of apply({ step, value })) next.push(result);
      if (next.length > MAX_JSON_RESULTS) tooMany();
    }
    current = next;
  }
  return current;
}
