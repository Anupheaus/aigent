import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('produces the same text whatever the key insertion order, at every depth', () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: { x: 2, y: 1 } }));
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"b":{"x":2,"y":1}}');
  });

  it('keeps array order, since it is meaningful', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('drops undefined object values as JSON does, and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('passes primitives through', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(3)).toBe('3');
  });
});
