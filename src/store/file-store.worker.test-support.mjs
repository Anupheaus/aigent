// Child process for the multi-process test: increments one counter record `count` times through the real file store.
// Usage: node file-store.worker.test-support.mjs <bundle.mjs> <dir> <count>
const [bundlePath, dir, countText] = process.argv.slice(2);
const { createFileStore, updateRecord } = await import(new URL(`file:///${bundlePath.replace(/\\/g, '/')}`).href);

const MAX_ATTEMPTS = 5_000;
const store = createFileStore({ dir });
for (let increment = 0; increment < Number(countText); increment += 1) {
  await updateRecord({ store, collection: 'counter', key: 'total', update: current => (current ?? 0) + 1, maxAttempts: MAX_ATTEMPTS });
}
