import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { createInMemoryStore } from './in-memory-store.js';
import { listWhere, matchesWhere } from './list-where.js';
import type { Store } from './store-types.js';

/** A third-party store written before `list` took options: it ignores them and lists everything. */
function legacyStore(): Store {
  const { get, compareAndSet, list } = createInMemoryStore();
  return { get, compareAndSet, list: collection => list(collection) };
}

describe('matchesWhere', () => {
  it('needs every field to equal the same top-level field of a plain-object value', () => {
    expect(matchesWhere({ value: { a: 1, b: 'x' }, where: { a: 1, b: 'x' } })).toBe(true);
    expect(matchesWhere({ value: { a: 1, b: 'y' }, where: { a: 1, b: 'x' } })).toBe(false);
    expect(matchesWhere({ value: { a: '1' }, where: { a: 1 } })).toBe(false);
    expect(matchesWhere({ value: {}, where: { a: null } })).toBe(false);
    expect(matchesWhere({ value: { a: null }, where: { a: null } })).toBe(true);
    expect(matchesWhere({ value: { a: { b: 1 } }, where: { 'a.b': 1 } })).toBe(false);
  });

  it('matches anything with no fields, and never a value that is not a plain object otherwise', () => {
    expect(matchesWhere({ value: 'text', where: {} })).toBe(true);
    expect(matchesWhere({ value: 'text', where: undefined })).toBe(true);
    expect(matchesWhere({ value: ['a'], where: { 0: 'a' } })).toBe(false);
    expect(matchesWhere({ value: null, where: { a: null } })).toBe(false);
  });

  it('refuses a where value that is not a string, finite number, boolean or null', () => {
    for (const bad of [{ nested: 1 }, [1], Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      let caught: unknown;
      try {
        matchesWhere({ value: {}, where: { field: bad as never } });
      } catch (error) {
        caught = error;
      }
      expect(isAigentError(caught) && caught.code === 'invalid_input', String(bad)).toBe(true);
    }
  });
});

describe('listWhere', () => {
  it('passes where to the store and filters again, so a store that ignores it still gives only matches', async () => {
    for (const store of [createInMemoryStore(), legacyStore()]) {
      await store.compareAndSet({ collection: 'c', key: 'mine', expectedVersion: undefined, value: { agentName: 'a', scopeKey: 's' } });
      await store.compareAndSet({ collection: 'c', key: 'other', expectedVersion: undefined, value: { agentName: 'b', scopeKey: 's' } });
      const listed = await listWhere({ store, collection: 'c', where: { agentName: 'a', scopeKey: 's' } });
      expect(listed.map(({ key }) => key)).toEqual(['mine']);
    }
  });

  it('asks the store for the filtered list', async () => {
    const seen: unknown[] = [];
    const base = createInMemoryStore();
    const store: Store = { ...base, list: (collection, options) => { seen.push(options); return base.list(collection, options); } };
    await listWhere({ store, collection: 'c', where: { agentName: 'a' } });
    expect(seen).toEqual([{ where: { agentName: 'a' } }]);
  });
});
