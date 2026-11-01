import { describe, expect, it } from 'vitest';
import { MAX_LEAF_STRING_LENGTH, MAX_RESULT_LEAVES, readPointer, resultHash, resultLeaves } from './result-leaves.js';

describe('result leaves', () => {
  it('lists scalar leaves at JSON pointers, keys sorted, escaping ~ and /', () => {
    expect(resultLeaves({ b: [true, 2], a: { 'x/y~z': 'v' } })).toEqual([{ path: '/a/x~1y~0z', value: 'v' }, { path: '/b/0', value: true }, { path: '/b/1', value: 2 }]);
    expect(resultLeaves('plain')).toEqual([{ path: '', value: 'plain' }]);
  });

  it('leaves out long strings and stops at the leaf limit', () => {
    expect(resultLeaves({ body: 'x'.repeat(MAX_LEAF_STRING_LENGTH + 1) })).toEqual([]);
    expect(resultLeaves(Array.from({ length: 100 }, (_, index) => index))).toHaveLength(MAX_RESULT_LEAVES);
  });

  it('reads pointers back, only own properties, never evaluating anything', () => {
    const value = { a: { 'x/y~z': 'v' }, list: ['p'] };
    expect(readPointer(value, '/a/x~1y~0z')).toBe('v');
    expect(readPointer(value, '/list/0')).toBe('p');
    expect(readPointer(value, '/list/9')).toBeUndefined();
    expect(readPointer(value, '/a/constructor')).toBeUndefined();
    expect(readPointer(value, '')).toBe(value);
  });

  it('hashes canonical JSON, so key order does not matter', () => {
    expect(resultHash({ a: 1, b: 2 })).toBe(resultHash({ b: 2, a: 1 }));
    expect(resultHash({ a: 1 })).not.toBe(resultHash({ a: 2 }));
  });
});
