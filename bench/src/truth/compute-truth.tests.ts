import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRepoTree } from '../generate/repo-generator.js';
import { FAMILY_IDS } from '../generate/repo-types.js';
import { computeTruth, globToRegExp } from './compute-truth.js';
import { TRUTH_QUERIES } from './truth-types.js';

const SEEDS = [1, 2, 3];
const SIZES = ['small', 'medium'] as const;
/** What truth scripts may import: each other, plain types and the bug-cause vocabulary, the error helper. */
const ALLOWED_IMPORTS = /^(\.\/|\.\.\/generate\/repo-types\.js$|\.\.\/generate\/families\/bug-constructs\.js$|\.\.\/bench-error\.js$|node:)/;

describe('ground truth agrees with the generator manifest', () => {
  it.each(SEEDS.flatMap(seed => SIZES.map(size => ({ seed, size }))))('seed $seed, $size: every query', ({ seed, size }) => {
    const { tree, manifest } = buildRepoTree({ seed, size, families: [...FAMILY_IDS] });
    for (const query of TRUTH_QUERIES) {
      const truth = computeTruth({ tree, manifest, query });
      const planted = manifest.items.filter(({ answers = [] }) => answers.includes(query));
      const decoys = manifest.items.filter(({ decoyFor = [] }) => decoyFor.includes(query));
      if (truth.kind === 'files') {
        expect(truth.files, query).toEqual([...new Set(planted.map(({ path }) => path))].sort());
        expect(truth.files.filter(path => decoys.some(decoy => decoy.path === path && decoy.line == null)), `${query} decoys`).toEqual([]);
      } else if (truth.kind === 'bugs') {
        expect(truth.bugs.map(({ path, line, cause }) => ({ path, line, cause })), query).toEqual(planted.map(({ path, line, cause }) => ({ path, line, cause })));
      } else if (truth.kind === 'criteria') {
        expect(truth.required, query).toEqual(manifest.criteria[query]?.required);
        expect(truth.required.filter(item => truth.forbidden.includes(item)), query).toEqual([]);
      } else {
        expect(planted, query).toEqual([]);
      }
    }
  });

  it('answers none-exist with none, and lists both ambiguous files as alternatives', () => {
    const { tree, manifest } = buildRepoTree({ seed: 4, size: 'small', families: [...FAMILY_IDS] });
    expect(computeTruth({ tree, manifest, query: 'none-exist' })).toEqual({ kind: 'none' });
    const ambiguous = computeTruth({ tree, manifest, query: 'ambiguous' });
    expect(ambiguous.kind === 'files' ? ambiguous.alternatives : undefined).toHaveLength(3);
  });

  it('refuses a query whose family was not generated', () => {
    const { tree, manifest } = buildRepoTree({ seed: 1, size: 'small', families: ['react'] });
    expect(() => computeTruth({ tree, manifest, query: 'find-file' })).toThrow(/find-file\.name/);
  });

  it('matches deny globs the way the policy reads them', () => {
    expect(globToRegExp('**/vault/**').test('src/vault/a.ts')).toBe(true);
    expect(globToRegExp('**/vault/**').test('src/vaults/a.ts')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('ground truth is independent of the tools under test', () => {
  it('imports nothing from the library or the generator beyond types and the cause vocabulary', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const sources = (await readdir(directory)).filter(name => name.endsWith('.ts') && !name.endsWith('.tests.ts'));
    for (const name of sources) {
      const text = await readFile(`${directory}/${name}`, 'utf8');
      for (const [, specifier] of text.matchAll(/from '([^']+)'/g)) expect(specifier, `${name} imports ${specifier}`).toMatch(ALLOWED_IMPORTS);
    }
  });
});
