import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import { evaluateExpression } from './expression.js';

describe('evaluateExpression', () => {
  it.each<[string, number]>([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['24 / 4 / 2', 3],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['2 ^ -1', 0.5],
    ['7 % 4', 3],
    ['--3', 3],
    ['1.5e3 + .5', 1500.5],
    ['min(3, 1, 2) + max(4, 9)', 10],
    ['abs(-2) + round(2.5) + floor(2.9) + ceil(2.1)', 10],
    ['sqrt(16) + pow(2, 10)', 1028],
    ['log(e) + log(100, 10)', 3],
    ['round(pi * 100)', 314],
  ])('%s = %s', (expression, value) => {
    expect(evaluateExpression(expression)).toBeCloseTo(value, 10);
  });

  it.each<[string, string]>([
    ['1 / 0', 'division_by_zero'],
    ['5 % 0', 'division_by_zero'],
    ['sqrt(-1)', 'not_a_number'],
    ['log(0)', 'not_a_number'],
    ['10 ^ 400', 'not_a_number'],
    ['1 +', 'syntax_error'],
    ['(1 + 2', 'syntax_error'],
    ['1 2', 'syntax_error'],
    ['', 'syntax_error'],
    ['x + 1', 'unknown_identifier'],
    ['process.exit()', 'unknown_identifier'],
    ['constructor', 'unknown_identifier'],
    ['sqrt(1, 2)', 'wrong_arity'],
    ['min()', 'wrong_arity'],
    ['1; 2', 'syntax_error'],
    [`${'('.repeat(200)}1${')'.repeat(200)}`, 'too_deep'],
  ])('%s fails with %s', (expression, reason) => {
    expect(() => evaluateExpression(expression)).toThrow(expect.objectContaining({ code: 'invalid_input', details: expect.objectContaining({ reason }) }));
  });

  it('fuzz: any input gives a finite number or a structured error, never anything else', () => {
    const token = fc.constantFrom('1', '2.5', '+', '-', '*', '/', '%', '^', '(', ')', ',', 'min', 'sqrt', 'pi', 'e', 'x', ' ', '.', 'e3', '"', ';', '[', 'this', '0');
    fc.assert(fc.property(fc.oneof(fc.string(), fc.array(token, { maxLength: 30 }).map(tokens => tokens.join(''))), input => {
      try {
        const value = evaluateExpression(input);
        expect(Number.isFinite(value)).toBe(true);
      } catch (error) {
        expect(isAigentError(error)).toBe(true);
      }
    }), { numRuns: 2_000 });
  });
});
