// Child process for the multi-process test: increments one counter record `count` times through the real file store.
// Usage: node file-store.worker.test-support.mjs <bundle.mjs> <dir> <count> <go-file>
// It prints `ready` once loaded, then waits for <go-file> to exist, so every worker starts incrementing at once.
import { existsSync } from 'node:fs';

const [bundlePath, dir, countText, goPath] = process.argv.slice(2);
const { createFileStore, updateRecord } = await import(new URL(`file:///${bundlePath.replace(/\\/g, '/')}`).href);

const MAX_ATTEMPTS = 5_000;
const BARRIER_POLL_MS = 1;
const store = createFileStore({ dir });
process.stdout.write('ready\n');
while (!existsSync(goPath)) await new Promise(resolve => setTimeout(resolve, BARRIER_POLL_MS));
for (let increment = 0; increment < Number(countText); increment += 1) {
  await updateRecord({ store, collection: 'counter', key: 'total', update: current => (current ?? 0) + 1, maxAttempts: MAX_ATTEMPTS });
}
