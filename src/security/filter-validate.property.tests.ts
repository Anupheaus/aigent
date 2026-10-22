import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDbPolicy, validateQuery } from './db-policy.js';
import { FORBIDDEN_OPERATORS } from './filter-walk.js';

const policy = createDbPolicy({ collections: { docs: { permissions: ['read'], denyFields: ['secret', 'nested.key'] } } });
const KNOWN_CODES = ['invalid_filter', 'forbidden_key', 'operator_forbidden', 'operator_not_allowed', 'invalid_operator_value', 'invalid_field', 'field_denied', 'too_deep', 'array_too_long', 'too_large', 'unsafe_regex'];

const literal = fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean(), fc.constant(null));
const condition = fc.oneof(
  literal,
  fc.record({ $gt: fc.integer() }),
  fc.record({ $in: fc.array(literal, { maxLength: 5 }) }),
  fc.record({ $exists: fc.boolean() }),
  fc.record({ $ne: literal }),
  fc.record({ $regex: fc.stringMatching(/^[a-z]{1,6}$/) }),
);
const simpleFilter = fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd.e'), condition, { minKeys: 1, maxKeys: 3 });
const allowedFilter = fc.oneof(simpleFilter, fc.record({ $or: fc.array(simpleFilter, { minLength: 1, maxLength: 3 }) }));
const forbiddenOperator = fc.constantFrom(...FORBIDDEN_OPERATORS);
const position = fc.constantFrom('top', 'or', 'field', 'not', 'elemMatch');

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

/** The filter with a forbidden operator placed at `where`, and the path the refusal must name. */
function inject(params: { filter: Record<string, unknown>; operator: string; where: string }): { filter: Record<string, unknown>; path: string } {
  const { filter, operator, where } = params;
  const payload = { [operator]: 'return 1' };
  if (where === 'top') return { filter: { ...filter, ...payload }, path: `filter.${operator}` };
  if (where === 'or') return { filter: { $or: [filter, payload] }, path: `filter.$or[1].${operator}` };
  if (where === 'field') return { filter: { ...filter, z: { $gt: 1, ...payload } }, path: `filter.z.${operator}` };
  if (where === 'not') return { filter: { ...filter, z: { $not: payload } }, path: `filter.z.$not.${operator}` };
  return { filter: { ...filter, z: { $elemMatch: payload } }, path: `filter.z.$elemMatch.${operator}` };
}

describe('filter validation properties', () => {
  it('never throws on arbitrary JSON, and never accepts a forbidden operator anywhere', () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 6 }), filter => {
      const result = validateQuery(policy, { collection: 'docs', filter });
      if (!result.ok) {
        expect(KNOWN_CODES).toContain(result.code);
        return;
      }
      expect(keysOf(result.query.filter).filter(key => FORBIDDEN_OPERATORS.has(key))).toEqual([]);
    }), { numRuns: 500 });
  });

  it('accepts generated filters made only of allowed operators and fields', () => {
    fc.assert(fc.property(allowedFilter, filter => {
      expect(validateQuery(policy, { collection: 'docs', filter })).toMatchObject({ ok: true });
    }), { numRuns: 300 });
  });

  it('refuses a forbidden operator wherever it is injected, naming its exact path', () => {
    fc.assert(fc.property(simpleFilter, forbiddenOperator, position, (filter, operator, where) => {
      const injected = inject({ filter, operator, where });
      expect(validateQuery(policy, { collection: 'docs', filter: injected.filter })).toMatchObject({ ok: false, code: 'operator_forbidden', path: injected.path });
    }), { numRuns: 300 });
  });

  it('refuses a denied field however its path is spelt with array indexes', () => {
    const spelling = fc.constantFrom('secret', 'secret.inner', 'nested.key', 'nested.0.key', 'nested.3.key.deeper', 'nested');
    fc.assert(fc.property(spelling, condition, (field, value) => {
      expect(validateQuery(policy, { collection: 'docs', filter: { [field]: value } })).toMatchObject({ ok: false, code: 'field_denied', path: `filter.${field}` });
    }), { numRuns: 100 });
  });
});
