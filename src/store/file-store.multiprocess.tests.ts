import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { tempRoot } from '../security/temp-dir.test-support.js';
import { createFileStore } from './file-store.js';

const PROCESSES = 3;
const INCREMENTS_EACH = 50;
const TEST_TIMEOUT_MS = 120_000;
const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, 'file-store.worker.test-support.mjs');

/** Child processes cannot load TypeScript, so the store and `updateRecord` are bundled into one plain module for them. */
async function bundleStore(directory: string): Promise<string> {
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
  });
  return outfile;
}

function runWorker(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`worker exited with ${code}: ${stderr}`))));
  });
}

describe('file store across processes', () => {
  it(`counts exactly ${PROCESSES * INCREMENTS_EACH} when ${PROCESSES} processes increment one record ${INCREMENTS_EACH} times each`, async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), 'aigent-bundle-'));
    const { root, cleanup } = await tempRoot();
    try {
      const bundlePath = resolve(await bundleStore(bundleDir));
      await Promise.all(Array.from({ length: PROCESSES }, () => runWorker([bundlePath, root, String(INCREMENTS_EACH)])));
      const record = await createFileStore({ dir: root }).get<number>('counter', 'total');
      expect(record?.value).toBe(PROCESSES * INCREMENTS_EACH);
      expect(record?.version).toBe(PROCESSES * INCREMENTS_EACH);
    } finally {
      await cleanup();
      await rm(bundleDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
