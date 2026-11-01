import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import type { Store } from '../../store/store-types.js';

/** A store under test, plus how to tidy up after it. */
export interface StoreContractInstance {
  store: Store;
  cleanup?(): Promise<void>;
}

export interface StoreContractSubject {
  /** Name shown in the test report. */
  name: string;
  /** Builds a fresh, empty store for every test. */
  create(): Promise<StoreContractInstance>;
  /** Concurrent writers per contention round. Default 100. */
  contentionWriters?: number;
  /** Contention rounds. Default 20. */
  contentionRounds?: number;
  /** Size in bytes of the large-value test. Default 5 MB; stores with a hard cap may lower it. */
  largeValueBytes?: number;
}

const DEFAULT_WRITERS = 100;
const DEFAULT_ROUNDS = 20;
const DEFAULT_LARGE_VALUE_BYTES = 5_000_000;
const LONG_KEY_LENGTH = 300;
const TEST_TIMEOUT_MS = 120_000;
/** Big enough that a file write is not one disk block, so a store that is not atomic shows a torn value. */
const TORN_READ_VALUE_BYTES = 200_000;
const TORN_READ_WRITES = 30;

/** Keys that have broken stores before: path tricks, Windows device names, separators, case, escapes, length. */
const AWKWARD_KEYS = ['../x', '..', '.', 'CON', 'nul', 'a/b', 'a\\b', 'ünïcode ✓', ' ', 'Key', 'key', 'KEY', 'x.', '%41', 'A', 'a', 'a.json', 'tab\tkey', 'a'.repeat(LONG_KEY_LENGTH), 'a'.repeat(LONG_KEY_LENGTH - 1) + 'b'];

/**
 * Strings with a lone surrogate, each beside what UTF-8 encoding turns it into (U+FFFD): a store must keep the two
 * apart or refuse the ill-formed one.
 */
const LONE_SURROGATE_PAIRS = [['x\uD800', 'x�'], ['\uDC00y', '�y']] as const;

async function withStore(subject: StoreContractSubject, body: (store: Store) => Promise<void>): Promise<void> {
  const { store, cleanup } = await subject.create();
  try {
    await body(store);
  } finally {
    await cleanup?.();
  }
}

function sortedKeys(records: { key: string }[]): string[] {
  return records.map(record => record.key).sort();
}

/**
 * Registers the tests every `Store` must pass: compare-and-set exclusivity under contention, copy semantics, awkward
 * keys and collection names (lone surrogates kept apart from U+FFFD or refused with `invalid_input`), large values, and (when the store has them) `delete` and `purge`.
 */
export function describeStoreContract(subject: StoreContractSubject): void {
  const writers = subject.contentionWriters ?? DEFAULT_WRITERS;
  const rounds = subject.contentionRounds ?? DEFAULT_ROUNDS;
  const largeValueBytes = subject.largeValueBytes ?? DEFAULT_LARGE_VALUE_BYTES;

  describe(`store contract: ${subject.name}`, () => {
    it('returns undefined for a record that does not exist', async () => {
      await withStore(subject, async store => {
        expect(await store.get('things', 'missing')).toBeUndefined();
        expect(await store.list('things')).toEqual([]);
      });
    });

    it('creates a record only when it is absent, starting at version 1', async () => {
      await withStore(subject, async store => {
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: { n: 1 } })).toBe(true);
        expect(await store.get('things', 'a')).toEqual({ key: 'a', value: { n: 1 }, version: 1 });
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: { n: 2 } })).toBe(false);
        expect(await store.get('things', 'a')).toEqual({ key: 'a', value: { n: 1 }, version: 1 });
      });
    });

    it('bumps the version by one per write and refuses a stale or wrong expected version', async () => {
      await withStore(subject, async store => {
        await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: 'one' });
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: 1, value: 'two' })).toBe(true);
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: 1, value: 'stale' })).toBe(false);
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: 7, value: 'future' })).toBe(false);
        expect(await store.compareAndSet({ collection: 'things', key: 'missing', expectedVersion: 1, value: 'no record' })).toBe(false);
        expect(await store.get('things', 'a')).toEqual({ key: 'a', value: 'two', version: 2 });
        expect(await store.get('things', 'missing')).toBeUndefined();
      });
    });

    it('keeps its own copy of what it is given and returns copies', async () => {
      await withStore(subject, async store => {
        const input = { list: [1, 2], nested: { x: 1 } };
        await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: input });
        input.list.push(3);
        input.nested.x = 99;
        const first = await store.get<typeof input>('things', 'a');
        expect(first?.value).toEqual({ list: [1, 2], nested: { x: 1 } });
        first?.value.list.push(4);
        const listed = await store.list<typeof input>('things');
        expect(listed[0]?.value).toEqual({ list: [1, 2], nested: { x: 1 } });
      });
    });

    it('lists the records of one collection only', async () => {
      await withStore(subject, async store => {
        await store.compareAndSet({ collection: 'one', key: 'a', expectedVersion: undefined, value: 1 });
        await store.compareAndSet({ collection: 'one', key: 'b', expectedVersion: undefined, value: 2 });
        await store.compareAndSet({ collection: 'two', key: 'a', expectedVersion: undefined, value: 3 });
        expect(sortedKeys(await store.list('one'))).toEqual(['a', 'b']);
        expect(await store.list('two')).toEqual([{ key: 'a', value: 3, version: 1 }]);
        expect(await store.list('three')).toEqual([]);
      });
    });

    it('stores awkward keys and collection names exactly, keeping case-only differences apart', async () => {
      await withStore(subject, async store => {
        for (const key of AWKWARD_KEYS) {
          expect(await store.compareAndSet({ collection: 'awkward', key, expectedVersion: undefined, value: `value of ${key}` })).toBe(true);
        }
        for (const key of AWKWARD_KEYS) {
          expect(await store.get('awkward', key), `key ${JSON.stringify(key)}`).toEqual({ key, value: `value of ${key}`, version: 1 });
        }
        expect(sortedKeys(await store.list('awkward'))).toEqual([...AWKWARD_KEYS].sort());
        for (const collection of AWKWARD_KEYS) {
          expect(await store.compareAndSet({ collection, key: 'k', expectedVersion: undefined, value: collection })).toBe(true);
        }
        for (const collection of AWKWARD_KEYS) {
          expect((await store.list(collection)).map(record => record.value), `collection ${JSON.stringify(collection)}`).toEqual([collection]);
        }
      });
    }, TEST_TIMEOUT_MS);

    it('keeps keys and collections with lone surrogates apart from U+FFFD, or refuses them with invalid_input', async () => {
      await withStore(subject, async store => {
        for (const [ill, replaced] of LONE_SURROGATE_PAIRS) {
          const created = await store.compareAndSet({ collection: 'surrogates', key: ill, expectedVersion: undefined, value: 'ill' }).catch((error: unknown) => error);
          if (created !== true) {
            expect(isAigentError(created) && created.code, `key ${JSON.stringify(ill)}`).toBe('invalid_input');
            continue;
          }
          expect(await store.compareAndSet({ collection: 'surrogates', key: replaced, expectedVersion: undefined, value: 'replaced' })).toBe(true);
          expect(await store.get('surrogates', ill)).toEqual({ key: ill, value: 'ill', version: 1 });
          expect(await store.get('surrogates', replaced)).toEqual({ key: replaced, value: 'replaced', version: 1 });
          expect(await store.compareAndSet({ collection: ill, key: 'k', expectedVersion: undefined, value: 'ill' })).toBe(true);
          expect(await store.compareAndSet({ collection: replaced, key: 'k', expectedVersion: undefined, value: 'replaced' })).toBe(true);
          expect((await store.list(ill)).map(record => record.value)).toEqual(['ill']);
        }
      });
    });

    it('stores and returns a large value intact', async () => {
      await withStore(subject, async store => {
        const big = 'x'.repeat(largeValueBytes);
        expect(await store.compareAndSet({ collection: 'big', key: 'a', expectedVersion: undefined, value: { big } })).toBe(true);
        const read = await store.get<{ big: string }>('big', 'a');
        expect(read?.value.big.length).toBe(largeValueBytes);
        expect(read?.value.big === big).toBe(true);
      });
    }, TEST_TIMEOUT_MS);

    it('never shows a reader half of a write: every read is one whole version', async () => {
      await withStore(subject, async store => {
        const valueFor = (version: number): { version: number; body: string } => ({ version, body: String(version % 10).repeat(TORN_READ_VALUE_BYTES) });
        let written = 0;
        let isWriting = true;
        const writing = (async () => {
          for (let version = 1; version <= TORN_READ_WRITES; version += 1) {
            expect(await store.compareAndSet({ collection: 'torn', key: 'k', expectedVersion: version === 1 ? undefined : version - 1, value: valueFor(version) })).toBe(true);
            written = version;
          }
          isWriting = false;
        })();
        const torn: string[] = [];
        let reads = 0;
        while (isWriting || reads === 0) {
          const writtenBefore = written;
          const read = await store.get<{ version: number; body: string }>('torn', 'k');
          reads += 1;
          if (read == null) continue;
          const expected = valueFor(read.version);
          if (read.value.version !== read.version || read.value.body !== expected.body) torn.push(`read ${reads}: record version ${read.version}, value version ${read.value.version}`);
          if (read.version < writtenBefore) torn.push(`read ${reads}: version ${read.version} after version ${writtenBefore} was written`);
        }
        await writing;
        expect(torn).toEqual([]);
      });
    }, TEST_TIMEOUT_MS);

    it(`lets exactly one of ${writers} concurrent writers win each of ${rounds} rounds`, async () => {
      await withStore(subject, async store => {
        let version: number | undefined;
        for (let round = 1; round <= rounds; round += 1) {
          const attempts = Array.from({ length: writers }, (_, writer) => (
            store.compareAndSet({ collection: 'race', key: 'k', expectedVersion: version, value: { round, writer } })
          ));
          const outcomes = await Promise.all(attempts);
          const winners = outcomes.flatMap((won, writer) => (won ? [writer] : []));
          expect(winners, `round ${round}`).toHaveLength(1);
          version = (version ?? 0) + 1;
          expect(await store.get('race', 'k')).toEqual({ key: 'k', value: { round, writer: winners[0] }, version });
        }
      });
    }, TEST_TIMEOUT_MS);

    it('deletes one record, ignores a missing one, and allows recreating it (when the store can delete)', async () => {
      await withStore(subject, async store => {
        if (store.delete == null) return;
        await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: 1 });
        await store.compareAndSet({ collection: 'things', key: 'b', expectedVersion: undefined, value: 2 });
        await store.delete('things', 'a');
        await store.delete('things', 'never-existed');
        expect(await store.get('things', 'a')).toBeUndefined();
        expect(sortedKeys(await store.list('things'))).toEqual(['b']);
        expect(await store.compareAndSet({ collection: 'things', key: 'a', expectedVersion: undefined, value: 3 })).toBe(true);
        expect(await store.get('things', 'a')).toEqual({ key: 'a', value: 3, version: 1 });
      });
    });

    it('purges only records matching every given field, across collections (when the store can purge)', async () => {
      await withStore(subject, async store => {
        if (store.purge == null) return;
        const write = (collection: string, key: string, value: unknown): Promise<boolean> => (
          store.compareAndSet({ collection, key, expectedVersion: undefined, value })
        );
        await write('runs', 'r1', { agentName: 'alpha', runId: 'r1', recordedAt: 100 });
        await write('runs', 'r2', { agentName: 'alpha', runId: 'r2', recordedAt: 300 });
        await write('traces', 't1', { agentName: 'beta', runId: 'r1', recordedAt: 100 });
        await write('other', 'plain', 'not a record object');
        expect(await store.purge({ agentName: 'alpha', before: 200 })).toBe(1);
        expect(sortedKeys(await store.list('runs'))).toEqual(['r2']);
        expect(await store.purge({ runId: 'r1' })).toBe(1);
        expect(await store.list('traces')).toEqual([]);
        expect(await store.purge({ agentName: 'nobody' })).toBe(0);
        expect(await store.list('other')).toHaveLength(1);
        // No criteria: every record whose value is an object goes, a bare string stays.
        expect(await store.purge({})).toBe(1);
        expect(await store.list('runs')).toEqual([]);
        expect(await store.list('other')).toHaveLength(1);
      });
    });
  });
}
