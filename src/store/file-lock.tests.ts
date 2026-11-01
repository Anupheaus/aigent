import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAigentError } from '../core/aigent-error.js';
import { tempRoot } from '../security/temp-dir.test-support.js';
import { createFileStore } from './file-store.js';
import { encodeName } from './key-encoding.js';

const STALE_AGE_MS = 60_000;
const TEST_TIMEOUT_MS = 60_000;
/** The review reproduced two winners in 49 of 100 trials; 40 trials miss a race that common with odds far below one in a million. */
const TAKEOVER_TRIALS = 40;
const TAKEOVER_CONTENDERS = 8;
/** A write that outlasts `staleLockMs` three times over. */
const SLOW_COMMIT_MS = 300;
const SHORT_STALE_MS = 100;
const STAGGER_MS = 150;
const HOUR_MS = 3_600_000;

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = await tempRoot();
  try {
    await body(root);
  } finally {
    await cleanup();
  }
}

function lockPathIn(dir: string): string {
  return join(dir, 'c', `${encodeName('k')}.json.lock`);
}

function delay(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** The pid of a process that has already exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => (child.pid == null ? reject(new Error('child had no pid')) : resolve(child.pid)));
  });
}

describe('file store locks', () => {
  it(`lets exactly one of ${TAKEOVER_CONTENDERS} writers through when they all find the same stale lock`, async () => {
    const trialsWithOtherThanOneWinner: number[] = [];
    for (let trial = 0; trial < TAKEOVER_TRIALS; trial += 1) {
      await withDir(async dir => {
        await mkdir(join(dir, 'c'));
        await writeFile(lockPathIn(dir), JSON.stringify({ pid: 1, token: 'dead', at: Date.now() - STALE_AGE_MS }));
        const store = createFileStore({ dir, staleLockMs: 1_000 });
        const outcomes = await Promise.all(Array.from({ length: TAKEOVER_CONTENDERS }, () => (
          store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 })
        )));
        if (outcomes.filter(Boolean).length !== 1) trialsWithOtherThanOneWinner.push(trial);
      });
    }
    expect(trialsWithOtherThanOneWinner).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps a live writer\'s lock while its write takes longer than staleLockMs', async () => {
    await withDir(async dir => {
      const store = createFileStore({ dir, staleLockMs: SHORT_STALE_MS, beforeCommit: () => delay(SLOW_COMMIT_MS) });
      const outcomes = await Promise.all([0, 1, 2].map(async position => {
        await delay(position * STAGGER_MS);
        return store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: position });
      }));
      expect(outcomes).toEqual([true, false, false]);
      expect(await store.get('c', 'k')).toEqual({ key: 'k', value: 0, version: 1 });
    });
  }, TEST_TIMEOUT_MS);

  it('takes over at once a lock whose process on this machine has exited, without waiting for staleLockMs', async () => {
    await withDir(async dir => {
      await mkdir(join(dir, 'c'));
      await writeFile(lockPathIn(dir), JSON.stringify({ pid: await exitedPid(), host: hostname(), token: 'crashed', at: Date.now() }));
      const store = createFileStore({ dir, staleLockMs: STALE_AGE_MS, lockTimeoutMs: 5_000 });
      expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'ok' })).toBe(true);
    });
  }, TEST_TIMEOUT_MS);

  it('ages an unreadable lock file by the real clock, not the injected one', async () => {
    await withDir(async dir => {
      await mkdir(join(dir, 'c'));
      // Just created and not yet written by its owner: young, whatever the injected clock says.
      await writeFile(lockPathIn(dir), '');
      const store = createFileStore({ dir, staleLockMs: STALE_AGE_MS, lockTimeoutMs: 200, clock: () => Date.now() + HOUR_MS });
      const failure = await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 }).catch((error: unknown) => error);
      expect(isAigentError(failure) && failure.code).toBe('store_failed');
    });
  }, TEST_TIMEOUT_MS);

  it('removes the temporary file a crashed writer left when it takes the crashed writer\'s lock over', async () => {
    await withDir(async dir => {
      await mkdir(join(dir, 'c'));
      await writeFile(lockPathIn(dir), JSON.stringify({ pid: 1, token: 'dead', at: Date.now() - STALE_AGE_MS }));
      await writeFile(join(dir, 'c', `${encodeName('k')}.json.00000000-0000-4000-8000-000000000000.tmp`), '{ torn');
      const store = createFileStore({ dir, staleLockMs: 1_000 });
      expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 'ok' })).toBe(true);
      expect(await readdir(join(dir, 'c'))).toEqual([`${encodeName('k')}.json`]);
    });
  }, TEST_TIMEOUT_MS);
});
