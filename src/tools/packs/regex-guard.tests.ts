import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileGuardedRegex, literalPattern } from './regex-guard.js';

const refusal = expect.objectContaining({ init: expect.objectContaining({ code: 'unsafe_pattern', category: 'denied' }) });

describe('compileGuardedRegex', () => {
  it.each(['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(a|aa)+$', '(.|\\s)*x', '(x+x+)+y', '(a{1,5})+', '(\\d+)*', '(a)\\1', '(?<n>a)\\k<n>', 'a'.repeat(1_001), ''])('refuses %s', pattern => {
    expect(() => compileGuardedRegex({ pattern })).toThrow(refusal);
  });

  // The bypasses found in review: nested groups, named groups, case folding, `{n}` repetition, adjacent quantifiers.
  it.each([
    ['((a+))+$', ''], ['(?:(a+))+$', ''], ['(?<x>a|aa)+$', ''], ['(a|A)+$', 'i'], ['(a|aa){30}$', ''],
    ['\\w*\\w*\\w*\\w*\\w*\\w*!', ''], ['a*a+b', ''], ['[a-z]+\\w*$', ''], ['((?:x|xx))*y', ''], ['(a?){30}a{30}', ''],
  ])('refuses the review bypass %s (flags %s)', (pattern, flags) => {
    expect(() => compileGuardedRegex({ pattern, flags })).toThrow(refusal);
  });

  it.each(['foo', 'fo+', '(foo|bar)+', '\\bword\\b', '[a-z]+\\d{2,4}', '^import .* from', '(?:get|set)Value', '\\d+\\s+\\w+', 'a*b*c*', '(?:ab)+', '[^"]*"', '\\[\\(x\\)\\]+'])('accepts %s', pattern => {
    expect(compileGuardedRegex({ pattern })).toBeInstanceOf(RegExp);
  });

  it('reports a syntax error and refuses unknown flags', () => {
    expect(() => compileGuardedRegex({ pattern: '(open' })).toThrow(expect.objectContaining({ init: expect.objectContaining({ code: 'invalid_pattern' }) }));
    expect(() => compileGuardedRegex({ pattern: 'a', flags: 'y' })).toThrow(expect.objectContaining({ init: expect.objectContaining({ code: 'unsafe_pattern' }) }));
  });

  it('rejects pathological patterns quickly', () => {
    const started = Date.now();
    for (let attempt = 0; attempt < 1_000; attempt += 1) expect(() => compileGuardedRegex({ pattern: '(a+)+$' })).toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('property: any pattern compiles or is refused with a structured failure, never a raw error', () => {
    const pieces = fc.constantFrom('a', 'b', '(', ')', '(?:', '(?<n>', '|', '*', '+', '?', '{2}', '{1,}', '[a-z]', '\\w', '\\d', '.', '^', '$', '\\');
    fc.assert(fc.property(fc.array(pieces, { maxLength: 20 }), fc.constantFrom('', 'i'), (parts, flags) => {
      try {
        expect(compileGuardedRegex({ pattern: parts.join(''), flags })).toBeInstanceOf(RegExp);
      } catch (error) {
        expect(['unsafe_pattern', 'invalid_pattern']).toContain((error as { init?: { code?: string } }).init?.code);
      }
    }), { numRuns: 2_000 });
  });

  it('escapes plain text into a literal pattern', () => {
    expect(new RegExp(literalPattern('a.b*(c)')).test('xa.b*(c)y')).toBe(true);
    expect(new RegExp(literalPattern('a.b')).test('axb')).toBe(false);
  });
});
