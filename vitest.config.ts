import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** The workspace packages import the core by its public name; tests resolve it to the core's source. */
const coreEntry = (path: string): string => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  test: { include: ['src/**/*.tests.ts', 'packages/*/src/**/*.tests.ts'] },
  resolve: {
    alias: [
      { find: /^@anupheaus\/aigent$/, replacement: coreEntry('index.ts') },
      { find: /^@anupheaus\/aigent\/testing$/, replacement: coreEntry('testing/index.ts') },
      { find: /^@anupheaus\/aigent\/testing\/contract$/, replacement: coreEntry('testing/contract/index.ts') },
    ],
  },
});
