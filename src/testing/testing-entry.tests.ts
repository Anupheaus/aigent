import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `@anupheaus/aigent/testing` must load without vitest installed (e.g. for jest users), so only the separate
// `./testing/contract` entry may reach vitest. This walks the static runtime import graph of each barrel's source.

const TESTING_DIR = dirname(fileURLToPath(import.meta.url));
const TESTING_BARREL = resolve(TESTING_DIR, 'index.ts');
const CONTRACT_BARREL = resolve(TESTING_DIR, 'contract', 'index.ts');
const VITEST_SPECIFIER = /^vitest(\/|$)/;
/** Import/export statements with a `from` clause, plus bare side-effect imports; `[^;]` lets a statement span lines. */
const MODULE_REFERENCE = /(?:^|\n)\s*(import|export)(\s+type\b)?([^;'"]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/g;
const JS_EXTENSION = /\.js$/;

interface ModuleReference {
  specifier: string;
  isTypeOnly: boolean;
}

function moduleReferences(source: string): ModuleReference[] {
  return [...source.matchAll(MODULE_REFERENCE)].map(([, , typeKeyword, , specifier = '']) => ({ specifier, isTypeOnly: typeKeyword != null }));
}

/** Every bare (package) specifier reachable from `entry` through runtime imports of relative source files. */
function reachablePackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() ?? '';
    if (visited.has(file)) continue;
    visited.add(file);
    moduleReferences(readFileSync(file, 'utf8'))
      .filter(({ isTypeOnly }) => !isTypeOnly)
      .forEach(({ specifier }) => {
        if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier.replace(JS_EXTENSION, '.ts')));
        else packages.add(specifier);
      });
  }
  return packages;
}

function importsVitest(entry: string): boolean {
  return [...reachablePackages(entry)].some(specifier => VITEST_SPECIFIER.test(specifier));
}

describe('testing entry points', () => {
  it('lets @anupheaus/aigent/testing load without vitest', () => {
    expect(importsVitest(TESTING_BARREL)).toBe(false);
  });

  it('reaches vitest from @anupheaus/aigent/testing/contract (proves the scan follows imports)', () => {
    expect(importsVitest(CONTRACT_BARREL)).toBe(true);
  });

  it('ignores type-only imports and follows multi-line runtime ones', () => {
    const source = "import type { A } from 'vitest';\nexport {\n  b,\n} from './b.js';\nimport 'side-effect';\n";
    expect(moduleReferences(source)).toEqual([
      { specifier: 'vitest', isTypeOnly: true },
      { specifier: './b.js', isTypeOnly: false },
      { specifier: 'side-effect', isTypeOnly: false },
    ]);
  });
});
