import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryDbAccess } from './memory-db-access.js';
import type { DbFindParams } from './db-access.js';

interface Doc {
  _id: number;
  n?: number | null;
  s: string;
  tags: string[];
}

const docArbitrary = fc.array(fc.record({
  n: fc.option(fc.integer({ min: -20, max: 20 }), { nil: null }),
  hasN: fc.boolean(),
  s: fc.constantFrom('apple', 'avocado', 'banana', 'cherry', ''),
  tags: fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
}), { maxLength: 25 }).map(rows => rows.map(({ n, hasN, s, tags }, index): Doc => ({ _id: index, ...(hasN ? { n } : {}), s, tags })));

const signal = new AbortController().signal;

async function ids(params: { docs: Doc[]; filter: Record<string, unknown> }): Promise<number[]> {
  const { docs, filter } = params;
  const access = createMemoryDbAccess({ collections: { docs: docs as unknown as Record<string, unknown>[] } });
  const { docs: found } = await access.find({ collection: 'docs', filter, limit: 1_000, maxTimeMs: 1_000, signal });
  return found.map(doc => doc._id as number);
}

/** Filters with a reference predicate written independently of the evaluator. */
const CASES: [string, fc.Arbitrary<[Record<string, unknown>, (doc: Doc) => boolean]>][] = [
  ['$gt', fc.integer({ min: -20, max: 20 }).map(value => [{ n: { $gt: value } }, doc => typeof doc.n === 'number' && doc.n > value])],
  ['$lte', fc.integer({ min: -20, max: 20 }).map(value => [{ n: { $lte: value } }, doc => typeof doc.n === 'number' && doc.n <= value])],
  ['$in', fc.array(fc.integer({ min: -20, max: 20 }), { maxLength: 4 }).map(values => [{ n: { $in: values } }, doc => typeof doc.n === 'number' && values.includes(doc.n)])],
  ['$ne', fc.integer({ min: -20, max: 20 }).map(value => [{ n: { $ne: value } }, doc => doc.n !== value])],
  ['$exists', fc.boolean().map(flag => [{ n: { $exists: flag } }, doc => ('n' in doc) === flag])],
  ['equality with null', fc.constant([{ n: null }, (doc: Doc) => doc.n == null])],
  ['array contains', fc.constantFrom('a', 'b', 'c').map(tag => [{ tags: tag }, doc => doc.tags.includes(tag)])],
  ['$all', fc.constantFrom('a', 'b').map(tag => [{ tags: { $all: [tag, 'c'] } }, doc => doc.tags.includes(tag) && doc.tags.includes('c')])],
  ['$size', fc.integer({ min: 0, max: 3 }).map(size => [{ tags: { $size: size } }, doc => doc.tags.length === size])],
  ['$regex', fc.constantFrom('^a', 'an', 'y$').map(pattern => [{ s: { $regex: pattern } }, doc => new RegExp(pattern).test(doc.s)])],
  ['$or', fc.integer({ min: -20, max: 20 }).map(value => [{ $or: [{ n: { $lt: value } }, { s: 'banana' }] }, doc => (typeof doc.n === 'number' && doc.n < value) || doc.s === 'banana'])],
  ['$nor', fc.constantFrom('a', 'b').map(tag => [{ $nor: [{ tags: tag }] }, doc => !doc.tags.includes(tag)])],
  ['$not', fc.integer({ min: -20, max: 20 }).map(value => [{ n: { $not: { $gt: value } } }, doc => !(typeof doc.n === 'number' && doc.n > value)])],
  ['$elemMatch', fc.constantFrom('a', 'b').map(tag => [{ tags: { $elemMatch: { $eq: tag } } }, doc => doc.tags.includes(tag)])],
];

describe('createMemoryDbAccess: operator semantics against reference predicates', () => {
  for (const [label, filterArbitrary] of CASES) {
    it(`matches the reference for ${label}`, async () => {
      await fc.assert(fc.asyncProperty(docArbitrary, filterArbitrary, async (docs, [filter, predicate]) => {
        expect(await ids({ docs, filter })).toEqual(docs.filter(predicate).map(doc => doc._id));
      }), { numRuns: 60 });
    });
  }

  it('runs $regex off the main thread, bounded by maxTimeMs (review I1)', async () => {
    // A catastrophic pattern the policy would refuse, sent straight to the access to prove the bound is the adapter's own.
    const access = createMemoryDbAccess({ collections: { docs: [{ _id: 1, s: `${'a'.repeat(40)}!` }] } });
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    try {
      await expect(access.find({ collection: 'docs', filter: { s: { $regex: '(a+)+$' } }, limit: 10, maxTimeMs: 300, signal })).rejects.toThrow(/300 ms/);
    } finally {
      clearInterval(ticker);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // The event loop kept running while the pattern backtracked.
    expect(ticks).toBeGreaterThan(5);
  });

  it('applies x-mode $options by dropping whitespace and comments, as MongoDB does', async () => {
    const access = createMemoryDbAccess({ collections: { docs: [{ _id: 1, s: 'ab' }, { _id: 2, s: 'a b' }] } });
    const { docs: found } = await access.find({ collection: 'docs', filter: { s: { $regex: '^a b # comment\n$', $options: 'x' } }, limit: 10, maxTimeMs: 1_000, signal });
    expect(found.map(doc => doc._id)).toEqual([1]);
  });

  it('matches an empty $regex against every text, as MongoDB does', async () => {
    const access = createMemoryDbAccess({ collections: { docs: [{ _id: 1, s: '' }, { _id: 2, s: 'x' }, { _id: 3, s: 5 }] } });
    const { docs: found } = await access.find({ collection: 'docs', filter: { s: { $regex: '' } }, limit: 10, maxTimeMs: 1_000, signal });
    expect(found.map(doc => doc._id)).toEqual([1, 2]);
  });

  it('never matches across types: $gt on a number ignores text', async () => {
    const docs = [{ _id: 1, v: 5 }, { _id: 2, v: 'z' }, { _id: 3, v: [1, 9] }];
    const access = createMemoryDbAccess({ collections: { docs } });
    const { docs: found } = await access.find({ collection: 'docs', filter: { v: { $gt: 4 } }, limit: 10, maxTimeMs: 1_000, signal });
    expect(found.map(doc => doc._id)).toEqual([1, 3]);
  });
});

describe('createMemoryDbAccess: sorting, paging, projection and types', () => {
  const docs = [
    { _id: 1, name: 'b', age: 30, when: new Date('2021-01-01T00:00:00Z'), secret: 's1', nested: { a: 1, b: 2 } },
    { _id: 2, name: 'a', age: 20, when: new Date('2020-01-01T00:00:00Z'), secret: 's2', nested: { a: 3, b: 4 } },
    { _id: 3, name: 'c', when: new Date('2022-01-01T00:00:00Z'), secret: 's3', nested: { a: 5, b: 6 } },
  ];
  const access = createMemoryDbAccess({ collections: { people: docs } });
  const base: DbFindParams = { collection: 'people', filter: {}, limit: 10, maxTimeMs: 1_000, signal };

  it('sorts (missing first ascending), skips, limits and reports more matches as truncated', async () => {
    const page = await access.find({ ...base, sort: [{ field: 'age', direction: 'asc' }], skip: 1, limit: 1 });
    expect(page).toEqual({ docs: [expect.objectContaining({ _id: 2 })], truncated: true });
    const last = await access.find({ ...base, sort: [{ field: 'age', direction: 'desc' }], skip: 2, limit: 5 });
    expect(last).toEqual({ docs: [expect.objectContaining({ _id: 3 })], truncated: false });
  });

  it('projects by inclusion (keeping _id unless excluded) and by exclusion', async () => {
    expect((await access.find({ ...base, projection: { name: 1, 'nested.a': 1 }, limit: 1 })).docs).toEqual([{ _id: 1, name: 'b', nested: { a: 1 } }]);
    expect((await access.find({ ...base, projection: { name: 1, _id: 0 }, limit: 1 })).docs).toEqual([{ name: 'b' }]);
    expect((await access.find({ ...base, projection: { secret: 0, nested: 0, when: 0 }, limit: 1 })).docs).toEqual([{ _id: 1, name: 'b', age: 30 }]);
  });

  it('stores dates as tagged JSON and compares them by time', async () => {
    const { docs: found } = await access.find({ ...base, filter: { when: { $gte: { $date: '2021-01-01T00:00:00.000Z' } } }, projection: { when: 1 } });
    expect(found).toEqual([{ _id: 1, when: { $date: '2021-01-01T00:00:00.000Z' } }, { _id: 3, when: { $date: '2022-01-01T00:00:00.000Z' } }]);
  });

  it('counts matches, finds nothing in an unknown collection, and refuses to run once aborted', async () => {
    expect(await access.count({ collection: 'people', filter: { age: { $exists: true } }, maxTimeMs: 1_000, signal })).toBe(2);
    expect(await access.find({ ...base, collection: 'nothing' })).toEqual({ docs: [], truncated: false });
    const controller = new AbortController();
    controller.abort();
    await expect(access.find({ ...base, signal: controller.signal })).rejects.toThrow();
  });
});
