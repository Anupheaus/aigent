import { createAigentError } from '../../core/aigent-error.js';

/** Longest expression accepted. */
const MAX_EXPRESSION_CHARS = 1_000;
/** Deepest nesting of parentheses, unary signs and powers. */
const MAX_DEPTH = 100;

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

interface MathFunction {
  minArgs: number;
  maxArgs: number;
  apply(args: number[]): number;
}

const FUNCTIONS: Readonly<Record<string, MathFunction>> = {
  min: { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, apply: args => Math.min(...args) },
  max: { minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, apply: args => Math.max(...args) },
  abs: { minArgs: 1, maxArgs: 1, apply: ([value = 0]) => Math.abs(value) },
  round: { minArgs: 1, maxArgs: 1, apply: ([value = 0]) => Math.round(value) },
  floor: { minArgs: 1, maxArgs: 1, apply: ([value = 0]) => Math.floor(value) },
  ceil: { minArgs: 1, maxArgs: 1, apply: ([value = 0]) => Math.ceil(value) },
  sqrt: { minArgs: 1, maxArgs: 1, apply: ([value = 0]) => Math.sqrt(value) },
  pow: { minArgs: 2, maxArgs: 2, apply: ([base = 0, exponent = 0]) => base ** exponent },
  // log(x) is the natural logarithm; log(x, base) takes a base.
  log: { minArgs: 1, maxArgs: 2, apply: ([value = 0, base]) => (base == null ? Math.log(value) : Math.log(value) / Math.log(base)) },
};

/** Which reason an expression failed for, as `details.reason`. */
export type ExpressionErrorReason = 'syntax_error' | 'unknown_identifier' | 'wrong_arity' | 'division_by_zero' | 'not_a_number' | 'too_long' | 'too_deep';

function fail(params: { reason: ExpressionErrorReason; message: string; position?: number }): never {
  const { reason, message, position } = params;
  throw createAigentError({ code: 'invalid_input', message: position == null ? message : `${message} (at character ${position + 1})`, details: { reason, ...(position == null ? {} : { position }) } });
}

function finite(params: { value: number; what: string }): number {
  const { value, what } = params;
  if (!Number.isFinite(value)) fail({ reason: 'not_a_number', message: `${what} is not a finite number` });
  return value;
}

/**
 * Evaluates arithmetic: numbers, `+ - * / % ^` (`^` binds tightest and to the right; `-2^2` is -4), parentheses, the
 * functions min, max, abs, round, floor, ceil, sqrt, pow and log, and the constants pi and e. Nothing else is ever
 * looked up or run. Throws `invalid_input` with `details.reason` (and `position`) for anything wrong.
 */
export function evaluateExpression(text: string): number {
  if (text.length > MAX_EXPRESSION_CHARS) fail({ reason: 'too_long', message: `The expression is longer than ${MAX_EXPRESSION_CHARS} characters` });
  let position = 0;
  let depth = 0;
  const skipSpaces = (): void => { while (/\s/.test(text[position] ?? '')) position += 1; };
  const peek = (): string => { skipSpaces(); return text[position] ?? ''; };
  const enter = (): void => { depth += 1; if (depth > MAX_DEPTH) fail({ reason: 'too_deep', message: `The expression nests deeper than ${MAX_DEPTH} levels`, position }); };

  function number(): number {
    const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (match == null) fail({ reason: 'syntax_error', message: `Expected a number, a name or '(' but found ${peek() === '' ? 'the end' : `'${peek()}'`}`, position });
    position += match[0].length;
    return Number(match[0]);
  }

  function call(name: string): number {
    const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (fn == null) fail({ reason: 'unknown_identifier', message: `Unknown function '${name}'`, position });
    position += 1;
    const args: number[] = [];
    if (peek() !== ')') {
      args.push(sum());
      while (peek() === ',') { position += 1; args.push(sum()); }
    }
    if (peek() !== ')') fail({ reason: 'syntax_error', message: `Expected ')' after the arguments of ${name}`, position });
    position += 1;
    if (args.length < fn.minArgs || args.length > fn.maxArgs) fail({ reason: 'wrong_arity', message: `${name} takes ${fn.minArgs === fn.maxArgs ? fn.minArgs : `${fn.minArgs} or more`} argument(s), got ${args.length}` });
    return finite({ value: fn.apply(args), what: `${name}(${args.join(', ')})` });
  }

  function primary(): number {
    const next = peek();
    if (next === '(') {
      enter();
      position += 1;
      const value = sum();
      if (peek() !== ')') fail({ reason: 'syntax_error', message: "Expected ')'", position });
      position += 1;
      depth -= 1;
      return value;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(position))?.[0];
    if (name == null) return number();
    position += name.length;
    if (peek() === '(') return call(name);
    if (!Object.hasOwn(CONSTANTS, name)) fail({ reason: 'unknown_identifier', message: `Unknown name '${name}' (only pi and e)`, position: position - name.length });
    return CONSTANTS[name] ?? 0;
  }

  function power(): number {
    const base = primary();
    if (peek() !== '^') return base;
    position += 1;
    enter();
    const exponent = unary();
    depth -= 1;
    return finite({ value: base ** exponent, what: `${base} ^ ${exponent}` });
  }

  function unary(): number {
    const next = peek();
    if (next !== '-' && next !== '+') return power();
    position += 1;
    enter();
    const value = unary();
    depth -= 1;
    return next === '-' ? -value : value;
  }

  function product(): number {
    let value = unary();
    for (let operator = peek(); operator === '*' || operator === '/' || operator === '%'; operator = peek()) {
      position += 1;
      const right = unary();
      if (operator !== '*' && right === 0) fail({ reason: 'division_by_zero', message: `${value} ${operator} 0 divides by zero` });
      value = finite({ value: operator === '*' ? value * right : operator === '/' ? value / right : value % right, what: 'The result' });
    }
    return value;
  }

  function sum(): number {
    let value = product();
    for (let operator = peek(); operator === '+' || operator === '-'; operator = peek()) {
      position += 1;
      const right = product();
      value = finite({ value: operator === '+' ? value + right : value - right, what: 'The result' });
    }
    return value;
  }

  const value = sum();
  if (peek() !== '') fail({ reason: 'syntax_error', message: `Unexpected '${peek()}'`, position });
  return finite({ value: value === 0 ? 0 : value, what: 'The result' });
}
