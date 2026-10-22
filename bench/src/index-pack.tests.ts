import { describe, expect, it } from 'vitest';
import { createFsPolicy } from '../../src/tools/packs/fs/index.js';
import { createRepoIndex, indexTools } from '../../src/tools/packs/index/index.js';
import { call, entriesOf } from '../../src/tools/packs/fs/fs-tools.test-support.js';
import { generateRepo } from './generate/repo-generator.js';
import { FAMILY_IDS } from './generate/repo-types.js';
import type { GeneratedRepo } from './generate/repo-types.js';
import { isGeneratedOrVendored } from './truth/file-kinds.js';
import { computeTruth } from './truth/compute-truth.js';

/** Fresh seeds, never used for the committed specs or tuning. */
const FRESH = [{ seed: 31, size: 'small' as const }, { seed: 32, size: 'medium' as const }];
const MAX_READ_BYTES = 1_048_576;

/** What the index should hold, by an exhaustive scan of the tree: visible, non-generated, non-binary files within the read limit. */
function expectedPaths(repo: GeneratedRepo): string[] {
  return [...repo.tree.entries()].filter(([path, entry]) => typeof entry === 'string' && !isGeneratedOrVendored(path) && !path.split('/').some(part => part.startsWith('.')) && new TextEncoder().encode(entry).length <= MAX_READ_BYTES).map(([path]) => path).sort();
}
const files = (repo: GeneratedRepo, query: Parameters<typeof computeTruth>[0]['query']): string[] => {
  const truth = computeTruth({ tree: repo.tree, manifest: repo.manifest, query });
  return truth.kind === 'files' ? truth.files : [];
};

describe.each(FRESH)('the index on fresh seed $seed ($size)', ({ seed, size }) => {
  it('has no missed or phantom entries, and its tags and graph agree with the exhaustive ground truth', async () => {
    const repo = await generateRepo({ seed, size, families: [...FAMILY_IDS] });
    const snapshot = await createRepoIndex({ policy: createFsPolicy({ roots: [{ path: repo.root, permissions: ['read'] }] }), access: repo.access }).refresh();
    expect([...snapshot.files.keys()].sort()).toEqual(expectedPaths(repo));
    const tagged = (tag: string): string[] => [...snapshot.files.values()].filter(({ tags }) => tags.includes(tag as never)).map(({ path }) => path).sort();
    expect(tagged('react-component')).toEqual(files(repo, 'react'));
    expect(tagged('renders-customer-data')).toEqual(files(repo, 'ui-customer'));
    expect(tagged('personal-data-fields')).toEqual(files(repo, 'pii-fields'));
    const gdpr = [...snapshot.files.values()].filter(({ tags }) => tags.includes('api-handler') && tags.some(entry => entry.startsWith('gdpr-'))).map(({ path }) => path).sort();
    expect(gdpr).toEqual(files(repo, 'gdpr'));
    const theme = [...snapshot.files.values()].filter(({ tags, importers }) => tags.includes('theme-definition') && importers.length > 0).map(({ path }) => path).sort();
    expect(theme).toEqual(files(repo, 'theme'));
    const dead = computeTruth({ tree: repo.tree, manifest: repo.manifest, query: 'dead-exports' });
    expect([...snapshot.files.values()].flatMap(({ unusedExports }) => unusedExports).sort()).toEqual(dead.kind === 'criteria' ? dead.required : []);
  });

  it('finds every match of a search the exhaustive scan finds (completeness counts equal), and never leaves the root', async () => {
    const repo = await generateRepo({ seed, size, families: [...FAMILY_IDS] });
    const tools = indexTools({ policy: createFsPolicy({ roots: [{ path: repo.root, permissions: ['read'] }] }), access: repo.access });
    const search = tools.find(({ name }) => name === 'search_layers');
    expect(search).toBeDefined();
    if (search == null) return;
    const word = repo.manifest.terms['string-word.identifier'] ?? '';
    const [result] = entriesOf(await call({ tool: search, items: [{ pattern: word, layer: 'files', wholeWord: true, limit: 500 }] }));
    const pattern = new RegExp(`(?<![\\w$])${word}(?![\\w$])`);
    const expected = expectedPaths(repo).map(path => ({ path, count: String(repo.tree.get(path)).split('\n').filter(line => pattern.test(line)).length })).filter(({ count }) => count > 0);
    expect(result?.result?.['totalMatches']).toBe(expected.reduce((sum, { count }) => sum + count, 0));
    expect((result?.result?.['files'] as { path: string }[]).map(({ path }) => path).sort()).toEqual(expected.map(({ path }) => path));
    expect((result?.result?.['files'] as { path: string }[]).every(({ path }) => !path.startsWith('/') && !path.includes('..'))).toBe(true);
  });

  it('traces the generated route the way the ground truth does', async () => {
    const repo = await generateRepo({ seed, size, families: [...FAMILY_IDS] });
    const find = indexTools({ policy: createFsPolicy({ roots: [{ path: repo.root, permissions: ['read'] }] }), access: repo.access }).find(({ name }) => name === 'repo_find');
    if (find == null) return;
    const [entry] = entriesOf(await call({ tool: find, items: [{ route: repo.manifest.terms['route-trace.endpoint'] ?? '' }] }));
    const [registration] = (entry?.result?.['registrations'] ?? []) as { registeredIn: string; handlerFile: string; callees: { path: string; tags: string[] }[] }[];
    const chain = [registration?.registeredIn, registration?.handlerFile, ...(registration?.callees ?? []).filter(({ tags }) => tags.includes('data-access')).map(({ path }) => path)].sort();
    expect(chain).toEqual(files(repo, 'route-trace'));
  });
});
