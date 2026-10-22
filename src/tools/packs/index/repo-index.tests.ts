import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createRepoIndex, REPO_INDEX_COLLECTION } from './repo-index.js';

const FILES = {
  '/ws/src/a.ts': "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n",
  '/ws/src/b.ts': 'export function b(): number {\n  return 1;\n}\nexport function lonely(): number {\n  return 2;\n}\n',
  '/ws/src/a.test.ts': "import { a } from './a';\nit('a', () => a());\n",
  '/ws/dist/a.js': 'export function a() {}\n',
  '/ws/package-lock.json': '{}\n',
  '/ws/secret/key.ts': 'export const key = 1;\n',
  '/ws/img.png': new Uint8Array([137, 80, 0, 0]),
  '/outside/x.ts': 'export const x = 1;\n',
};

const setup = (files: Record<string, string | Uint8Array> = FILES) => {
  const access = createMemoryFsAccess({ platform: 'posix', files });
  const policy = createFsPolicy({ roots: [{ path: '/ws', permissions: ['read'] }], denyGlobs: ['secret/**'] });
  return { access, policy };
};

describe('repo index', () => {
  it('indexes only allowed text files: ignores, deny globs and binaries are skipped and counted', async () => {
    const snapshot = await createRepoIndex(setup()).refresh();
    expect([...snapshot.files.keys()].sort()).toEqual(['src/a.test.ts', 'src/a.ts', 'src/b.ts']);
    expect(snapshot.skipped).toMatchObject({ ignored: 2, denied: 1, binary: 1 });
    expect(snapshot.processed).toEqual(['src/a.test.ts', 'src/a.ts', 'src/b.ts']);
    expect(snapshot.files.get('src/b.ts')).toMatchObject({ importers: ['src/a.ts'], unusedExports: ['lonely'] });
    expect(snapshot.files.get('src/a.ts')).toMatchObject({ importers: ['src/a.test.ts'], unusedExports: [] });
  });

  it('re-processes only changed files, follows renames by content and drops deletions', async () => {
    const { access, policy } = setup();
    const index = createRepoIndex({ policy, access });
    const first = await index.refresh();
    expect((await index.refresh()).processed).toEqual([]);
    await access.writeFile({ path: '/ws/src/b.ts', data: new TextEncoder().encode('export function b(): number {\n  return 3;\n}\n') });
    const edited = await index.refresh();
    expect(edited.processed).toEqual(['src/b.ts']);
    expect(edited.version).not.toBe(first.version);
    expect(edited.files.get('src/b.ts')?.unusedExports).toEqual([]);
    await access.rename('/ws/src/a.ts', '/ws/src/renamed.ts');
    const renamed = await index.refresh();
    expect(renamed.processed).toEqual([]);
    expect(renamed.files.has('src/a.ts')).toBe(false);
    expect(renamed.files.get('src/renamed.ts')?.functions).toEqual(['a']);
    await access.rm('/ws/src/a.test.ts');
    expect([...(await index.refresh()).files.keys()].sort()).toEqual(['src/b.ts', 'src/renamed.ts']);
  });

  it('shares cards through the store: a new index over the same content builds nothing', async () => {
    const store = createInMemoryStore();
    expect((await createRepoIndex({ ...setup(), store }).refresh()).processed).toHaveLength(3);
    const again = await createRepoIndex({ ...setup(), store }).refresh();
    expect(again.processed).toEqual([]);
    expect(again.files.get('src/a.ts')?.functions).toEqual(['a']);
  });

  describe('cards reused by content hash keep path-dependent facts per path', () => {
    const API = "export function fetchUser(req: Request) {\n  return db.query('select 1');\n}\n";
    const policy = createFsPolicy({ roots: [{ path: '/ws', permissions: ['read'] }] });
    const indexOver = (files: Record<string, string>, store?: ReturnType<typeof createInMemoryStore>) => createRepoIndex({ policy, access: createMemoryFsAccess({ platform: 'posix', files }), ...(store == null ? {} : { store }) });

    it('copies with identical bytes get their own tags and language', async () => {
      const snapshot = await indexOver({ '/ws/src/api.ts': API, '/ws/src/__mocks__/api.ts': API, '/ws/src/api.test.ts': API, '/ws/src/api.js': API }).refresh();
      expect(snapshot.files.get('src/api.ts')).toMatchObject({ language: 'ts', tags: ['api-handler', 'data-access'] });
      expect(snapshot.files.get('src/__mocks__/api.ts')).toMatchObject({ language: 'ts', tags: ['mock'] });
      expect(snapshot.files.get('src/api.test.ts')).toMatchObject({ language: 'ts', tags: ['test'] });
      expect(snapshot.files.get('src/api.js')).toMatchObject({ language: 'js', tags: ['api-handler', 'data-access'] });
    });

    it('a rename to a test path takes the test tags, and a copy added later does not inherit the original\'s', async () => {
      const access = createMemoryFsAccess({ platform: 'posix', files: { '/ws/src/api.ts': API, '/ws/src/__mocks__/keep.txt': 'x' } });
      const index = createRepoIndex({ policy, access });
      await index.refresh();
      await access.writeFile({ path: '/ws/src/__mocks__/api.ts', data: new TextEncoder().encode(API) });
      await access.rename('/ws/src/api.ts', '/ws/src/api.test.ts');
      const snapshot = await index.refresh();
      expect(snapshot.files.get('src/api.test.ts')?.tags).toEqual(['test']);
      expect(snapshot.files.get('src/__mocks__/api.ts')?.tags).toEqual(['mock']);
    });

    it('a shared store never gives a code file the card of identical bytes stored for a document', async () => {
      const store = createInMemoryStore();
      await indexOver({ '/ws/notes.md': API }, store).refresh();
      const card = (await indexOver({ '/ws/src/api.ts': API }, store).refresh()).files.get('src/api.ts');
      expect(card).toMatchObject({ language: 'ts', functions: ['fetchUser'], tags: ['api-handler', 'data-access'] });
    });

    it('keys stored cards by the card schema version, so a card stored by an older classifier is not reused', async () => {
      const store = createInMemoryStore();
      const hash = createHash('sha256').update(API).digest('hex');
      await store.compareAndSet({ collection: REPO_INDEX_COLLECTION, key: hash, expectedVersion: undefined, value: { path: 'old.ts', language: 'ts', size: 1, hash, exports: [], functions: ['stale'], symbols: [], imports: [], identifiers: [], routes: [], mounts: [], tags: [] } });
      const snapshot = await indexOver({ '/ws/src/api.ts': API }, store).refresh();
      expect(snapshot.files.get('src/api.ts')?.functions).toEqual(['fetchUser']);
      expect(snapshot.processed).toEqual(['src/api.ts']);
    });
  });

  it('is deterministic and refuses a root the policy does not allow', async () => {
    const [one, two] = [await createRepoIndex(setup()).refresh(), await createRepoIndex(setup()).refresh()];
    expect(JSON.stringify([...one.files.values()])).toBe(JSON.stringify([...two.files.values()]));
    expect(one.version).toBe(two.version);
    await expect(createRepoIndex({ ...setup(), root: '/outside' }).refresh()).rejects.toThrow(/not readable/);
  });
});
