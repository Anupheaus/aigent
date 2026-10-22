import { describe, expect, it } from 'vitest';
import { fieldAccess, pathSyntaxError, pruneDocument } from './db-field-paths.js';

describe('pathSyntaxError', () => {
  it('accepts dotted paths with array indexes', () => {
    expect(pathSyntaxError('a.b.0.c')).toBeUndefined();
    expect(pathSyntaxError('_id')).toBeUndefined();
  });

  it('names what is wrong with a bad path', () => {
    expect(pathSyntaxError('')).toMatch(/empty/);
    expect(pathSyntaxError('a..b')).toMatch(/empty segment/);
    expect(pathSyntaxError('a.$b')).toMatch(/\$/);
    expect(pathSyntaxError('a\u0000b')).toMatch(/control/);
    expect(pathSyntaxError('x'.repeat(201))).toMatch(/200/);
  });
});

describe('fieldAccess', () => {
  const rule = { denyFields: ['password', 'profile.ssn'] };
  const listed = { allowFields: ['status', 'items.sku'], denyFields: [] };

  it('refuses denied fields, fields below them, their parents, and array-indexed spellings', () => {
    expect(fieldAccess(rule, 'name')).toBe('ok');
    expect(fieldAccess(rule, 'password')).toBe('denied');
    expect(fieldAccess(rule, 'profile.ssn.last4')).toBe('denied');
    expect(fieldAccess(rule, 'profile')).toBe('denied');
    expect(fieldAccess(rule, 'profile.0.ssn')).toBe('denied');
    expect(fieldAccess(rule, 'profile.name')).toBe('ok');
  });

  it('allows only listed fields and fields below them', () => {
    expect(fieldAccess(listed, 'status')).toBe('ok');
    expect(fieldAccess(listed, 'items.sku')).toBe('ok');
    expect(fieldAccess(listed, 'items.3.sku')).toBe('ok');
    expect(fieldAccess(listed, 'items')).toBe('not_allowed');
    expect(fieldAccess(listed, 'customer')).toBe('not_allowed');
  });
});

describe('pruneDocument', () => {
  it('removes denied fields wherever they are, inside arrays too', () => {
    const doc = { name: 'a', password: 'p', profile: { ssn: '1', city: 'x' }, cards: [{ number: '4111', brand: 'v' }, { number: '5500' }] };
    expect(pruneDocument({ denyFields: ['password', 'profile.ssn', 'cards.number'] }, doc)).toEqual({ name: 'a', profile: { city: 'x' }, cards: [{ brand: 'v' }, {}] });
  });

  it('keeps only allowed fields (and the parents leading to them), without changing the input', () => {
    const doc = { _id: { $oid: 'ab' }, status: 'open', customer: { email: 'e' }, items: [{ sku: 's1', cost: 3 }, { sku: 's2' }] };
    const pruned = pruneDocument({ allowFields: ['_id', 'status', 'items.sku'], denyFields: [] }, doc);
    expect(pruned).toEqual({ _id: { $oid: 'ab' }, status: 'open', items: [{ sku: 's1' }, { sku: 's2' }] });
    expect(doc.customer).toEqual({ email: 'e' });
  });

  it('walks into a subdocument whose keys only look tagged, so it cannot carry fields past allowFields (review M4)', () => {
    const doc = { meta: { $secret: 's' }, info: { $secret: 's', $other: 't' }, when: { $date: '2020-01-01T00:00:00.000Z' }, re: { $regex: 'a', $options: 'i' } };
    const pruned = pruneDocument({ allowFields: ['meta.public', 'info.public', 'when', 're'], denyFields: [] }, doc);
    expect(pruned).toEqual({ when: { $date: '2020-01-01T00:00:00.000Z' }, re: { $regex: 'a', $options: 'i' } });
  });

  it('treats tagged values as leaves and drops prototype keys', () => {
    const doc = JSON.parse('{"__proto__":{"polluted":true},"when":{"$date":"2020-01-01T00:00:00.000Z"}}') as Record<string, unknown>;
    const pruned = pruneDocument({ denyFields: [] }, doc);
    expect(pruned).toEqual({ when: { $date: '2020-01-01T00:00:00.000Z' } });
    expect(Object.prototype.hasOwnProperty.call(pruned, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
