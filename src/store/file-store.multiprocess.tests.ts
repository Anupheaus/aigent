import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { tempRoot } from '../security/temp-dir.test-support.js';
import { createFileStore } from './file-store.js';

const PROCESSES = 3;
/** Enough that the processes overlap for seconds: the review's unlocked run lost 595 of 1,500 updates at 500 each. */
const INCREMENTS_EACH = 300;
const TEST_TIMEOUT_MS = 240_000;
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, 'file-store.worker.test-support.mjs');

/** The control: the store with its lock replaced by one that excludes no one. */
const NO_LOCK: Plugin = {
  name: 'no-lock',
  setup(builder) {
    builder.onResolve({ filter: /file-lock\.js$/ }, () => ({ path: 'no-lock', namespace: 'no-lock' }));
    builder.onLoad({ filter: /.*/, namespace: 'no-lock' }, () => ({
      contents: 'export async function acquireFileLock() { return { release: async () => {}, tookOver: false }; }',
      loader: 'js',
    }));
  },
};

/** Child processes cannot load TypeScript, so the store and `updateRecord` are bundled into one plain module for them. */
async function bundleStore(params: { directory: string; plugins: Plugin[] }): Promise<string> {
  const { directory, plugins } = params;
  const outfile = join(directory, 'store-bundle.mjs');
  await build({
    stdin: {
      contents: "export { createFileStore } from './file-store.ts'; export { updateRecord } from './update-record.ts';",
      resolveDir: here,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
    plugins,
  });
  return resolve(outfile);
}

interface RunningWorker {
  ready: Promise<void>;
  exited: Promise<void>;
}

function startWorker(args: string[]): RunningWorker {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const ready = new Promise<void>((resolveReady, reject) => {
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('ready')) resolveReady();
    });
    child.on('exit', code => reject(new Error(`worker exited with ${code} before it was ready: ${stderr}`)));
  });
  const exited = new Promise<void>((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolveExit() : reject(new Error(`worker exited with ${code}: ${stderr}`))));
  });
  ready.catch(() => undefined);
  return { ready, exited };
}

/** Starts the workers, waits until all are loaded, then releases them together through the go file. */
async function incrementTogether(params: { bundlePath: string; root: string }): Promise<PromiseSettledResult<void>[]> {
  const { bundlePath, root } = params;
  const goPath = join(root, 'go');
  const workers = Array.from({ length: PROCESSES }, () => startWorker([bundlePath, root, String(INCREMENTS_EACH), goPath]));
  await Promise.all(workers.map(({ ready }) => ready));
  await writeFile(goPath, '');
  return Promise.allSettled(workers.map(({ exited }) => exited));
}

async function withBundle(params: { plugins: Plugin[]; body(context: { bundlePath: string; root: string }): Promise<void> }): Promise<void> {
  const { plugins, body } = params;
  const bundleDir = await mkdtemp(join(tmpdir(), 'aigent-bundle-'));
  const { root, cleanup } = await tempRoot();
  try {
    await body({ bundlePath: await bundleStore({ directory: bundleDir, plugins }), root });
  } finally {
    await cleanup();
    await rm(bundleDir, { recursive: true, force: true });
  }
}

describe('file store across processes', () => {
  it(`counts exactly ${PROCESSES * INCREMENTS_EACH} when ${PROCESSES} processes started together increment one record ${INCREMENTS_EACH} times each`, async () => {
    await withBundle({
      plugins: [],
      body: async ({ bundlePath, root }) => {
        const outcomes = await incrementTogether({ bundlePath, root });
        expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual([]);
        const record = await createFileStore({ dir: root }).get<number>('counter', 'total');
        expect(record?.value).toBe(PROCESSES * INCREMENTS_EACH);
        expect(record?.version).toBe(PROCESSES * INCREMENTS_EACH);
      },
    });
  }, TEST_TIMEOUT_MS);

  it('control: the same run without the lock loses updates, so the test above can tell a lock from none', async () => {
    await withBundle({
      plugins: [NO_LOCK],
      body: async ({ bundlePath, root }) => {
        await incrementTogether({ bundlePath, root });
        const record = await createFileStore({ dir: root }).get<number>('counter', 'total');
        expect(record?.value ?? 0).toBeLessThan(PROCESSES * INCREMENTS_EACH);
      },
    });
  }, TEST_TIMEOUT_MS);
});
