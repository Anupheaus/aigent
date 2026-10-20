import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsAccessContract } from './fs-access.contract.test-support.js';
import { createMemoryFsAccess } from './fs-access-memory.js';
import { createNodeFsAccess } from './fs-access-node.js';
import { tempRoot } from './temp-dir.test-support.js';

describe('createNodeFsAccess', () => {
  fsAccessContract(async () => {
    const { root, cleanup } = await tempRoot();
    return { access: createNodeFsAccess(), root, join: (...segments) => join(root, ...segments), cleanup };
  });

  it('resolves a symlink to its target (skipped where symlinks cannot be created)', async context => {
    const { root, cleanup } = await tempRoot();
    try {
      await writeFile(join(root, 'target.txt'), 'x');
      try {
        await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
      } catch (error) {
        // Windows without Developer Mode or admin rights refuses to create symlinks.
        context.skip(`symlinks cannot be created here: ${(error as { code?: string }).code ?? String(error)}`);
        return;
      }
      const access = createNodeFsAccess();
      expect(await access.realpath(join(root, 'link.txt'))).toBe(join(root, 'target.txt'));
      expect((await access.lstat(join(root, 'link.txt'))).type).toBe('symlink');
    } finally { await cleanup(); }
  });
});

describe('createMemoryFsAccess', () => {
  for (const platform of ['posix', 'win32'] as const) {
    describe(platform, () => {
      const root = platform === 'win32' ? 'C:\\mem' : '/mem';
      const separator = platform === 'win32' ? '\\' : '/';
      fsAccessContract(async () => ({
        access: createMemoryFsAccess({ platform, files: { [root]: { dir: true } } }), root,
        join: (...segments) => [root, ...segments].join(separator), cleanup: async () => undefined,
      }));
    });
  }

  it('follows symlinks in realpath and reports loops', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { '/r/real/f.txt': 'f', '/r/link': { symlink: '/r/real' }, '/r/loop': { symlink: '/r/loop' } } });
    expect(await access.realpath('/r/link/f.txt')).toBe('/r/real/f.txt');
    await expect(access.realpath('/r/loop')).rejects.toMatchObject({ details: { fsCode: 'ELOOP' } });
  });

  it('is case-insensitive on win32 by default, keeping the stored case', async () => {
    const access = createMemoryFsAccess({ platform: 'win32', files: { 'C:\\Data\\File.txt': 'x' } });
    expect(await access.realpath('c:\\data\\FILE.TXT')).toBe('C:\\Data\\File.txt');
  });
});
