import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Every `import ... from '<specifier>'`, `export ... from` and dynamic `import('<specifier>')`. */
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
/** Plugin packages (and the SDKs only they may use): the core package must never depend on them. */
const FORBIDDEN_SPECIFIERS = [/^@anupheaus\/aigent-/, /^@anthropic-ai\//, /(?:^|\/)packages\//];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

describe('core package imports', () => {
  it('never imports a plugin package or a plugin-only SDK', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC_ROOT)) {
      // This file names the forbidden specifiers itself.
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = await readFile(file, 'utf8');
      for (const [, specifier] of text.matchAll(IMPORT_SPECIFIER)) {
        if (specifier != null && FORBIDDEN_SPECIFIERS.some(pattern => pattern.test(specifier))) offenders.push(`${relative(SRC_ROOT, file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
