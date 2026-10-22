import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createInMemoryStore } from '../../../store/in-memory-store.js';
import { createRepoIndex } from './repo-index.js';

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

  it('is deterministic and refuses a root the policy does not allow', async () => {
    const [one, two] = [await createRepoIndex(setup()).refresh(), await createRepoIndex(setup()).refresh()];
    expect(JSON.stringify([...one.files.values()])).toBe(JSON.stringify([...two.files.values()]));
    expect(one.version).toBe(two.version);
    await expect(createRepoIndex({ ...setup(), root: '/outside' }).refresh()).rejects.toThrow(/not readable/);
  });
});
