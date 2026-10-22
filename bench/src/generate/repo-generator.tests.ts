import { describe, expect, it } from 'vitest';
import { buildRepoTree, generateRepo } from './repo-generator.js';
import { FAMILY_IDS, REPO_SIZES } from './repo-types.js';
import type { GeneratedRepo } from './repo-types.js';
import { hashTree } from './materialise.js';

const ALL = [...FAMILY_IDS];
/** Generated sizes stay within this fraction of their nominal file count. */
const SIZE_TOLERANCE = 0.1;
const HUGE_BUDGET_MS = 60_000;

/** Every regular file reachable on the repository's access, repo-relative (links are not followed). */
async function walkFiles(repo: GeneratedRepo): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    for (const { name, type } of await repo.access.readdir(directory)) {
      const path = relative === '' ? name : `${relative}/${name}`;
      if (type === 'directory') await visit(`${directory}/${name}`, path);
      else if (type === 'file') found.push(path);
    }
  }
  await visit(repo.root, '');
  return found.sort();
}

describe('generateRepo', () => {
  it.each([1, 2, 3].flatMap(seed => (['small', 'medium'] as const).map(size => ({ seed, size }))))('is deterministic for seed $seed ($size)', ({ seed, size }) => {
    const first = buildRepoTree({ seed, size, families: ALL });
    const second = buildRepoTree({ seed, size, families: [...ALL].reverse() });
    expect(hashTree(second.tree)).toBe(hashTree(first.tree));
    expect(second.manifest).toEqual(first.manifest);
    expect(hashTree(buildRepoTree({ seed: seed + 100, size, families: ALL }).tree)).not.toBe(hashTree(first.tree));
  });

  it.each(['small', 'medium', 'large'] as const)('generates about the nominal file count (%s)', async size => {
    const repo = await generateRepo({ seed: 1, size, families: ALL });
    expect(Math.abs(repo.files - REPO_SIZES[size]) / REPO_SIZES[size]).toBeLessThan(SIZE_TOLERANCE);
  });

  it('writes exactly the tree, and every manifest path exists on it', async () => {
    const repo = await generateRepo({ seed: 2, size: 'small', families: ALL });
    const onDisk = await walkFiles(repo);
    const regular = [...repo.tree.entries()].filter(([, entry]) => typeof entry === 'string' || entry instanceof Uint8Array).map(([path]) => path).sort();
    expect(onDisk).toEqual(regular);
    for (const { path } of repo.manifest.items) expect(repo.tree.has(path), path).toBe(true);
    expect((await repo.access.lstat(`${repo.root}/${[...repo.tree.entries()].find(([, entry]) => typeof entry === 'object' && !(entry instanceof Uint8Array))?.[0]}`)).type).toBe('symlink');
  });

  it('plants needles and decoys for every family, and each kind of noise', () => {
    const { manifest, tree } = buildRepoTree({ seed: 3, size: 'small', families: ALL });
    for (const family of FAMILY_IDS) {
      const items = manifest.items.filter(item => item.family === family);
      expect(items.some(({ kind }) => kind === 'needle'), `${family} needles`).toBe(true);
      expect(items.some(({ kind }) => kind === 'decoy'), `${family} decoys`).toBe(true);
    }
    const paths = [...tree.keys()];
    expect(paths.some(path => /(^|\/)(package-lock\.json|yarn\.lock)$/.test(path)), 'lockfile').toBe(true);
    expect(paths.some(path => path.startsWith('dist/')), 'build output').toBe(true);
    expect(paths.some(path => path.endsWith('.min.js')), 'minified').toBe(true);
    expect(paths.some(path => path.startsWith('vendor/')), 'vendored').toBe(true);
    expect(paths.some(path => path.startsWith('node_modules/')), 'installed').toBe(true);
    expect([...tree.values()].some(entry => entry instanceof Uint8Array), 'binary').toBe(true);
  });

  it('plants only the requested families', () => {
    const { manifest } = buildRepoTree({ seed: 1, size: 'small', families: ['react', 'theme'] });
    expect(new Set(manifest.items.map(({ family }) => family))).toEqual(new Set(['base', 'react', 'theme']));
  });

  it('writes a real directory when asked (links where the platform allows)', async () => {
    const repo = await generateRepo({ seed: 1, size: 'small', families: ['file-find', 'traps'], target: 'disk' });
    try {
      const name = repo.manifest.terms['find-file.name'] ?? '';
      const needle = repo.manifest.items.find(({ answers = [] }) => answers.includes('find-file'))?.path ?? '';
      expect(needle.endsWith(name)).toBe(true);
      expect(new TextDecoder().decode(await repo.access.readFile(`${repo.root}/${needle}`))).toBe(repo.tree.get(needle));
    } finally { await repo.cleanup(); }
  });

  it(`generates a huge repository in memory within ${HUGE_BUDGET_MS / 1_000} s`, async () => {
    const started = Date.now();
    const repo = await generateRepo({ seed: 1, size: 'huge', families: ALL });
    expect(Date.now() - started).toBeLessThan(HUGE_BUDGET_MS);
    expect(Math.abs(repo.files - REPO_SIZES.huge) / REPO_SIZES.huge).toBeLessThan(SIZE_TOLERANCE);
  }, HUGE_BUDGET_MS * 2);
});
