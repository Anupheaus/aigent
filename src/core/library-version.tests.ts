import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIBRARY_VERSION } from './library-version.js';

describe('LIBRARY_VERSION', () => {
  // Hand-maintained because ESM cannot import package.json without import attributes; this keeps it honest.
  it('equals the version in package.json', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(LIBRARY_VERSION).toBe(packageJson.version);
  });
});
