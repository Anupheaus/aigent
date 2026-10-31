import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAigent } from '../core/create-aigent.js';
import { isAigentError } from '../core/aigent-error.js';
import { tempRoot } from '../security/temp-dir.test-support.js';
import { describeStoreContract } from '../testing/contract/store-contract.js';
import { createFakeProvider, textTurn } from '../testing/fake-provider.js';
import { createFileStore } from './file-store.js';
import type { FileStoreOptions } from './file-store.js';
import { encodeName } from './key-encoding.js';

const STALE_AGE_MS = 60_000;
const TEST_TIMEOUT_MS = 60_000;

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await tempRoot();
  try {
    await body(root);
  } finally {
    await cleanup();
  }
}

/** Each of the 100 writers takes a real file lock in turn, so 20 rounds take about a minute on Windows; 5 still prove exclusivity. */
const FILE_STORE_CONTENTION_ROUNDS = 5;
const CONTENTION_LOCK_TIMEOUT_MS = 100_000;

describeStoreContract({
  name: 'file store',
  contentionRounds: FILE_STORE_CONTENTION_ROUNDS,
  create: async () => {
    const { root, cleanup } = await tempRoot();
    // 100 writers queue on one lock, which can outlast the 10 s default while the whole suite loads the machine.
    return { store: createFileStore({ dir: root, lockTimeoutMs: CONTENTION_LOCK_TIMEOUT_MS }), cleanup };
  },
});

describe('file store', () => {
  it('stores one JSON file per record under an encoded collection directory', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir });
      await store.compareAndSet({ collection: 'runs', key: 'Run/1', expectedVersion: undefined, value: { n: 1 } });
      expect(await readdir(join(dir, 'runs'))).toEqual([`${encodeName('Run/1')}.json`]);
    });
  });

  it('reads back what an earlier instance wrote', async () => {
    await withDir(async dir => {
      await createFileStore({ dir }).compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: [1, 2, 3] });
      expect(await createFileStore({ dir }).get('c', 'k')).toEqual({ key: 'k', value: [1, 2, 3], version: 1 });
    });
  });

  it('leaves the old record whole when a write dies before it is committed', async () => {
    await withDir(async dir => {
      let crash = false;
      const options: FileStoreOptions = { dir, beforeCommit: async () => { if (crash) throw new Error('power cut'); } };
      const store = createFileStore(options);
      await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'old' });
      crash = true;
      await expect(store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: 'new' })).rejects.toThrow('power cut');
      crash = false;
      expect(await store.get('c', 'k')).toEqual({ key: 'k', value: 'old', version: 1 });
      expect(await readdir(join(dir, 'c'))).toEqual([`${encodeName('k')}.json`]);
      expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: 1, value: 'again' })).toBe(true);
    });
  });

  it('ignores temporary and lock files that a crashed writer left behind', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir });
      await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 });
      await writeFile(join(dir, 'c', `${encodeName('k')}.json.abc.tmp`), '{ torn');
      await writeFile(join(dir, 'c', 'other.json.lock'), '');
      expect(await store.list('c')).toEqual([{ key: 'k', value: 1, version: 1 }]);
      expect(await store.get('c', 'k')).toEqual({ key: 'k', value: 1, version: 1 });
    });
  });

  it('takes over a lock whose owner is long gone', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir, staleLockMs: 1_000 });
      await mkdir(join(dir, 'c'));
      await writeFile(join(dir, 'c', `${encodeName('k')}.json.lock`), JSON.stringify({ pid: 1, token: 'dead', at: Date.now() - STALE_AGE_MS }));
      expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'ok' })).toBe(true);
    });
  });

  it('takes over an empty lock file once it is old enough', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir, staleLockMs: 1_000 });
      await mkdir(join(dir, 'c'));
      const lockPath = join(dir, 'c', `${encodeName('k')}.json.lock`);
      await writeFile(lockPath, '');
      const old = new Date(Date.now() - STALE_AGE_MS);
      await utimes(lockPath, old, old);
      expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'ok' })).toBe(true);
    });
  });

  it('fails with store_failed, naming the lock, when a live writer holds it too long', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir, lockTimeoutMs: 50, staleLockMs: STALE_AGE_MS });
      await mkdir(join(dir, 'c'));
      await writeFile(join(dir, 'c', `${encodeName('k')}.json.lock`), JSON.stringify({ pid: 1, token: 'busy', at: Date.now() }));
      const failure = await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 }).catch((error: unknown) => error);
      expect(isAigentError(failure) && failure.code).toBe('store_failed');
      expect((failure as Error).message).toContain('k.json.lock');
    });
  });

  it('reports a record file that is not valid JSON as store_failed', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir });
      await mkdir(join(dir, 'c'));
      await writeFile(join(dir, 'c', `${encodeName('k')}.json`), '{ nope');
      const failure = await store.get('c', 'k').catch((error: unknown) => error);
      expect(isAigentError(failure) && failure.code).toBe('store_failed');
    });
  });

  it('keeps an agent run across a restart', async () => {
    await withDir(async dir => {
      const first = createAigent({ providers: [createFakeProvider({ turns: [textTurn('hello')] })], store: createFileStore({ dir }), enableFeedback: false });
      await first.agent({ name: 'helper', model: 'fake:m' }).task({ task: 'say hello' });
      const second = createAigent({ providers: [createFakeProvider({ turns: [] })], store: createFileStore({ dir }), enableFeedback: false });
      expect((await second.report()).runCount).toBe(1);
    });
  }, TEST_TIMEOUT_MS);
});
