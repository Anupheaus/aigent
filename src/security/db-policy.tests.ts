import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { createDbPolicy, DEFAULT_MAX_TIME_MS, validateQuery } from './db-policy.js';
import type { DbPolicyOptions, DbQueryRequest } from './db-policy-types.js';

const OPTIONS: DbPolicyOptions = {
  collections: {
    users: { permissions: ['read'], denyFields: ['password', 'profile.ssn', 'cards.number'] },
    orders: { permissions: ['read'], allowFields: ['_id', 'status', 'total', 'items.sku'], maxLimit: 50, maxTimeMs: 2_000 },
    narrow: { permissions: ['read'], allowOperators: ['$eq'] },
    secrets: { permissions: [] },
  },
};
const policy = createDbPolicy(OPTIONS);

function refusal(request: DbQueryRequest): { code: string; path: string } {
  const result = validateQuery(policy, request);
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(request)}`);
  expect(result.message.length).toBeGreaterThan(10);
  return { code: result.code, path: result.path };
}

const users = (filter: unknown): DbQueryRequest => ({ collection: 'users', filter });

/** Nested objects `depth` levels deep: `{ a: { a: ... { a: 1 } } }`. */
function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < depth; level += 1) value = { a: value };
  return value;
}

describe('validateQuery: operator injection corpus (each refused before reaching the database)', () => {
  const cases: [string, unknown, string, string][] = [
    ['$where at the top', { $where: 'sleep(1000)' }, 'operator_forbidden', 'filter.$where'],
    ['$where under a field', { age: { $where: 'x' } }, 'operator_forbidden', 'filter.age.$where'],
    ['$function', { $function: { body: 'return 1', args: [], lang: 'js' } }, 'operator_forbidden', 'filter.$function'],
    ['$expr', { $expr: { $gt: ['$a', '$b'] } }, 'operator_forbidden', 'filter.$expr'],
    ['$accumulator inside $or', { $or: [{ name: 'a' }, { $accumulator: {} }] }, 'operator_forbidden', 'filter.$or[1].$accumulator'],
    ['$jsonSchema', { $jsonSchema: { required: ['x'] } }, 'operator_forbidden', 'filter.$jsonSchema'],
    ['$lookup', { $lookup: { from: 'secrets' } }, 'operator_forbidden', 'filter.$lookup'],
    ['$out', { $out: 'copy' }, 'operator_forbidden', 'filter.$out'],
    ['$merge', { $merge: { into: 'users' } }, 'operator_forbidden', 'filter.$merge'],
    ['$where inside $elemMatch', { tags: { $elemMatch: { $where: 'x' } } }, 'operator_forbidden', 'filter.tags.$elemMatch.$where'],
    ['$where hidden in a literal document', { name: { first: { $where: 'x' } } }, 'operator_forbidden', 'filter.name.first.$where'],
    ['$where inside $not', { name: { $not: { $where: 'x' } } }, 'operator_forbidden', 'filter.name.$not.$where'],
    ['an unknown top-level operator', { $text: { $search: 'x' } }, 'operator_not_allowed', 'filter.$text'],
    ['an unknown field operator', { name: { $near: [0, 0] } }, 'operator_not_allowed', 'filter.name.$near'],
    ['nested quantifiers in $regex', { name: { $regex: '(a+)+$' } }, 'unsafe_regex', 'filter.name.$regex'],
    ['an over-long $regex', { name: { $regex: 'a'.repeat(201) } }, 'unsafe_regex', 'filter.name.$regex'],
    ['an unsafe $regex under $not', { name: { $not: { $regex: '(x*)*y' } } }, 'unsafe_regex', 'filter.name.$not.$regex'],
    // Review I1: an empty group, x-mode whitespace or an x-mode comment between quantifiers hid the adjacency.
    ['a $regex chaining \\d+ through empty groups', { name: { $regex: '\\d+()\\d+()\\d+()\\d+()\\d+()\\d+()!' } }, 'unsafe_regex', 'filter.name.$regex'],
    ['a $regex chaining \\d+ through x-mode whitespace', { name: { $regex: '\\d+ \\d+ \\d+ \\d+!', $options: 'x' } }, 'unsafe_regex', 'filter.name.$regex'],
    ['a $regex chaining \\d+ through an x-mode comment', { name: { $regex: '\\d+#c\n\\d+!', $options: 'x' } }, 'unsafe_regex', 'filter.name.$regex'],
    ['a $regex with more unbounded quantifiers than allowed', { name: { $regex: 'a+,b+,c+,d+' } }, 'unsafe_regex', 'filter.name.$regex'],
    ['bad $options',{ name: { $regex: 'ab', $options: 'g' } }, 'invalid_operator_value', 'filter.name.$options'],
    ['$options without $regex', { name: { $options: 'i' } }, 'invalid_operator_value', 'filter.name.$options'],
    ['a __proto__ key', JSON.parse('{"__proto__":{"isAdmin":true}}'), 'forbidden_key', 'filter.__proto__'],
    ['a constructor key', { constructor: { prototype: 1 } }, 'forbidden_key', 'filter.constructor'],
    ['a prototype path segment', { 'a.prototype': 1 }, 'forbidden_key', 'filter.a.prototype'],
    ['a filter nested too deep', nested(9), 'too_deep', 'filter.a.a.a.a.a.a.a.a'],
    ['a huge $in', { name: { $in: Array.from({ length: 1_001 }, (_, index) => index) } }, 'array_too_long', 'filter.name.$in'],
    ['a $-prefixed path segment', { 'profile.$secret': 1 }, 'invalid_field', 'filter.profile.$secret'],
    ['an empty path segment', { 'a..b': 1 }, 'invalid_field', 'filter.a..b'],
    ['a denied field', { password: 'hunter2' }, 'field_denied', 'filter.password'],
    ['a field below a denied one', { 'profile.ssn.last4': '1234' }, 'field_denied', 'filter.profile.ssn.last4'],
    ['a parent of a denied field', { profile: { ssn: '1' } }, 'field_denied', 'filter.profile'],
    ['an array index around a denied field', { 'cards.0.number': '4111' }, 'field_denied', 'filter.cards.0.number'],
    ['$elemMatch on the array holding a denied field', { cards: { $elemMatch: { number: '4111' } } }, 'field_denied', 'filter.cards'],
    ['a denied field inside $or', { $or: [{ password: { $exists: true } }] }, 'field_denied', 'filter.$or[0].password'],
    ['operators mixed with fields', { age: { $gt: 1, years: 2 } }, 'invalid_filter', 'filter.age'],
    ['$or that is not an array', { $or: { a: 1 } }, 'invalid_operator_value', 'filter.$or'],
    ['an empty $or', { $or: [] }, 'invalid_operator_value', 'filter.$or'],
    ['a negative $size', { tags: { $size: -1 } }, 'invalid_operator_value', 'filter.tags.$size'],
    ['a non-boolean $exists', { tags: { $exists: 'yes' } }, 'invalid_operator_value', 'filter.tags.$exists'],
    ['a malformed $oid', { _id: { $oid: 'not-hex' } }, 'invalid_operator_value', 'filter._id.$oid'],
    ['a malformed $date', { created: { $gt: { $date: 'yesterday' } } }, 'invalid_operator_value', 'filter.created.$gt.$date'],
    ['a non-finite number', { age: { $gt: Number.POSITIVE_INFINITY } }, 'invalid_operator_value', 'filter.age.$gt'],
    ['a filter that is an array', [{ a: 1 }], 'invalid_filter', 'filter'],
    ['a filter that is text', 'name == "x"', 'invalid_filter', 'filter'],
  ];

  for (const [label, filter, code, path] of cases) {
    it(`refuses ${label}`, () => {
      expect(refusal(users(filter))).toEqual({ code, path });
    });
  }

  it('refuses a filter with too many nodes even when every array is short', () => {
    const wide = { $and: Array.from({ length: 500 }, (_, index) => ({ name: { $in: Array.from({ length: 50 }, () => `v${index}`) } })) };
    expect(refusal(users(wide))).toEqual({ code: 'too_large', path: 'filter' });
  });

  it('refuses operators a collection narrowed away', () => {
    expect(refusal({ collection: 'narrow', filter: { age: { $gt: 1 } } })).toEqual({ code: 'operator_not_allowed', path: 'filter.age.$gt' });
    expect(validateQuery(policy, { collection: 'narrow', filter: { age: { $eq: 1 } } }).ok).toBe(true);
  });
});

describe('validateQuery: collections, projections, sorts and limits', () => {
  it('refuses collections that are not listed or not readable, including prototype names', () => {
    for (const collection of ['secrets', 'nothere', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(refusal({ collection })).toEqual({ code: 'collection_denied', path: 'collection' });
    }
  });

  it('refuses projections and sorts that would expose denied or unlisted fields', () => {
    expect(refusal({ collection: 'users', projection: ['name', 'password'] })).toEqual({ code: 'field_denied', path: 'projection[1]' });
    expect(refusal({ collection: 'users', projection: ['profile'] })).toEqual({ code: 'field_denied', path: 'projection[0]' });
    expect(refusal({ collection: 'users', projection: ['$name'] })).toEqual({ code: 'invalid_field', path: 'projection[0]' });
    expect(refusal({ collection: 'orders', projection: ['customer'] })).toEqual({ code: 'field_denied', path: 'projection[0]' });
    expect(refusal({ collection: 'orders', projection: ['items'] })).toEqual({ code: 'field_denied', path: 'projection[0]' });
    expect(refusal({ collection: 'users', sort: [{ field: 'password', direction: 'asc' }] })).toEqual({ code: 'field_denied', path: 'sort[0].field' });
    expect(refusal({ collection: 'users', sort: Array.from({ length: 9 }, () => ({ field: 'name', direction: 'asc' as const })) })).toEqual({ code: 'invalid_sort', path: 'sort' });
  });

  it('refuses limits over the collection maximum and negative skips', () => {
    expect(refusal({ collection: 'users', limit: 201 })).toEqual({ code: 'limit_exceeded', path: 'limit' });
    expect(refusal({ collection: 'orders', limit: 51 })).toEqual({ code: 'limit_exceeded', path: 'limit' });
    expect(refusal({ collection: 'users', limit: 0 })).toEqual({ code: 'limit_exceeded', path: 'limit' });
    expect(refusal({ collection: 'users', skip: -1 })).toEqual({ code: 'invalid_skip', path: 'skip' });
  });

  it('accepts a rich allowed query and passes its values through unchanged, as parameters', () => {
    const filter = {
      status: 'open', age: { $gte: 18, $lt: 65 }, $or: [{ name: 'a' }, { tier: { $in: [1, 2] } }],
      name: { $regex: '^Al', $options: 'i' }, tags: { $elemMatch: { $eq: 'x' } }, _id: { $oid: '5f1d7f1b2c3a4b5c6d7e8f90' },
      created: { $gt: { $date: '2020-01-01T00:00:00.000Z' } }, nick: { $not: { $type: 'string' } }, notes: "'; db.dropDatabase(); //",
    };
    const result = validateQuery(policy, { collection: 'users', filter, sort: [{ field: 'age', direction: 'desc' }], skip: 5 });
    expect(result).toEqual({
      ok: true,
      query: { collection: 'users', filter, projection: { password: 0, 'profile.ssn': 0, 'cards.number': 0 }, sort: [{ field: 'age', direction: 'desc' }], limit: 20, skip: 5, maxTimeMs: DEFAULT_MAX_TIME_MS },
    });
  });

  it('projects to the allowed fields by default, and keeps a requested projection inside them', () => {
    const byDefault = validateQuery(policy, { collection: 'orders' });
    expect(byDefault).toMatchObject({ ok: true, query: { projection: { _id: 1, status: 1, total: 1, 'items.sku': 1 }, limit: 20, maxTimeMs: 2_000 } });
    expect(validateQuery(policy, { collection: 'orders', projection: ['status', 'items.sku'], limit: 50 })).toMatchObject({ ok: true, query: { projection: { status: 1, 'items.sku': 1 }, limit: 50 } });
    expect(validateQuery(policy, { collection: 'users', projection: ['name'] })).toMatchObject({ ok: true, query: { projection: { name: 1 } } });
  });

  it('excludes _id from a projection when the rules hide it', () => {
    const hidden = createDbPolicy({ collections: { logs: { permissions: ['read'], allowFields: ['level', 'message'] } } });
    expect(validateQuery(hidden, { collection: 'logs', projection: ['level'] })).toMatchObject({ ok: true, query: { projection: { level: 1, _id: 0 } } });
    expect(validateQuery(hidden, { collection: 'logs' })).toMatchObject({ ok: true, query: { projection: { level: 1, message: 1, _id: 0 } } });
  });

  it('never throws, whatever the request', () => {
    for (const request of [{ collection: 'users', filter: null }, { collection: 'users', filter: undefined }, { collection: 'users', filter: { a: undefined } }, { collection: 'users', projection: [] }]) {
      expect(() => validateQuery(policy, request as DbQueryRequest)).not.toThrow();
    }
  });
});

describe('createDbPolicy', () => {
  function definitionError(options: unknown): string {
    try {
      createDbPolicy(options as DbPolicyOptions);
    } catch (error) {
      if (isAigentError(error) && error.code === 'invalid_definition') return error.message;
      throw error;
    }
    throw new Error('expected an invalid_definition error');
  }

  it('is read-only by construction: any other permission is refused', () => {
    expect(definitionError({ collections: { users: { permissions: ['write'] } } })).toMatch(/users.*'read'/);
  });

  it('never lets code-running or writing operators be allowed', () => {
    expect(definitionError({ collections: { users: { permissions: ['read'], allowOperators: ['$eq', '$where'] } } })).toMatch(/\$where/);
    expect(definitionError({ collections: { users: { permissions: ['read'], allowOperators: ['$nearSphere'] } } })).toMatch(/\$nearSphere/);
  });

  it('checks limits and the collections map', () => {
    expect(definitionError({})).toMatch(/collections/);
    expect(definitionError({ collections: { users: { permissions: ['read'], maxLimit: 0 } } })).toMatch(/maxLimit/);
    expect(definitionError({ collections: { users: { permissions: ['read'], maxTimeMs: -5 } } })).toMatch(/maxTimeMs/);
    expect(definitionError({ collections: { users: { permissions: ['read'], denyFields: ['$x'] } } })).toMatch(/denyFields/);
    expect(definitionError({ collections: {}, maxDepth: 0 })).toMatch(/maxDepth/);
  });

  it('lists the readable collections only, sorted', () => {
    expect(policy.collections()).toEqual(['narrow', 'orders', 'users']);
  });
});
