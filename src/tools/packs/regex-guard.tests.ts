import { describe, expect, it } from 'vitest';
import { compileGuardedRegex, literalPattern } from './regex-guard.js';

describe('compileGuardedRegex', () => {
  it.each(['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(a|aa)+$', '(.|\\s)*x', '(x+x+)+y', '(a{1,5})+', '(\\d+)*', '(a)\\1', '(?<n>a)\\k<n>', 'a'.repeat(1_001), ''])('refuses %s', pattern => {
    expect(() => compileGuardedRegex({ pattern })).toThrow(expect.objectContaining({ init: expect.objectContaining({ code: 'unsafe_pattern', category: 'denied' }) }));
  });

  it.each(['foo', 'fo+', '(foo|bar)+', '\\bword\\b', '[a-z]+\\d{2,4}', '^import .* from', '(?:get|set)Value'])('accepts %s', pattern => {
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

  it('escapes plain text into a literal pattern', () => {
    expect(new RegExp(literalPattern('a.b*(c)')).test('xa.b*(c)y')).toBe(true);
    expect(new RegExp(literalPattern('a.b')).test('axb')).toBe(false);
  });
});
