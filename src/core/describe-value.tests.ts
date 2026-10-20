import { describe, expect, it } from 'vitest';
import { describeError, describeValue } from './describe-value.js';

const hostileToStringTag = new Proxy({}, { get: () => { throw new Error('trap'); } });

describe('describeValue', () => {
  const printable: [string, unknown, string][] = [
    ['a string', 'text', 'text'], ['a number', 42, '42'], ['null', null, 'null'], ['undefined', undefined, 'undefined'],
    ['a symbol', Symbol('s'), 'Symbol(s)'], ['a plain object', {}, '[object Object]'],
  ];
  const unprintable: [string, unknown, string][] = [
    ['a null-prototype object', Object.create(null), '[object Object]'],
    ['an object whose toString throws', { toString() { throw new Error('no'); } }, '[object Object]'],
    ['a proxy whose every property access throws', hostileToStringTag, '<unprintable value>'],
  ];

  it.each(printable)('describes %s as its normal string form', (_label, value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });

  it.each(unprintable)('never throws for %s', (_label, value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });
});

describe('describeError', () => {
  it('uses the message of an Error and a safe description otherwise', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(Object.create(null))).toBe('[object Object]');
  });
});
