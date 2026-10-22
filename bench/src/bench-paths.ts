import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchError } from './bench-error.js';

/** The `bench/` project directory, from the source tree or from its compiled copy under `bench/dist`. */
export function benchRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!(basename(directory) === 'bench' && existsSync(join(directory, 'package.json')))) {
    const parent = dirname(directory);
    if (parent === directory) throw benchError('benchRoot: no bench/package.json above the running module', { from: fileURLToPath(import.meta.url) });
    directory = parent;
  }
  return directory;
}

/** Committed task specs. */
export const tasksDir = (): string => join(benchRoot(), 'tasks');
/** Committed round results and write-ups. */
export const resultsDir = (): string => join(benchRoot(), 'results');
