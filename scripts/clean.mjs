// Removes build output before `tsc`, so modules of deleted source files are never published. Cross-platform, no deps.
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

rmSync(BUILD_DIR, { recursive: true, force: true });
