import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFsAccess } from './fs-access-node.js';
import { createFsPolicy } from './fs-policy.js';
import { tempRoot } from './temp-dir.test-support.js';

/** A directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
async function linkDirectory(params: { target: string; path: string }): Promise<string | undefined> {
  const { target, path } = params;
  try {
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('FsPolicy on a real disk', () => {
  it('resolves directory links before checking: a link out of the root is outside, a link inside resolves to its target', async context => {
    const { root, cleanup } = await tempRoot();
    try {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      await mkdir(join(workspace, 'src'), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 's');
      await writeFile(join(workspace, 'src', 'a.ts'), 'a');
      const failure = await linkDirectory({ target: outside, path: join(workspace, 'escape') }) ?? await linkDirectory({ target: join(workspace, 'src'), path: join(workspace, 'inner') });
      if (failure != null) { context.skip(`directory links cannot be created here: ${failure}`); return; }
      const access = createNodeFsAccess();
      const policy = createFsPolicy({ roots: [{ path: workspace, permissions: ['read', 'write'] }] });
      expect(await policy.check({ path: join(workspace, 'escape', 'secret.txt'), permission: 'read', access })).toMatchObject({ allowed: false, code: 'outside_roots' });
      expect(await policy.check({ path: join(workspace, 'escape', 'new.txt'), permission: 'write', access })).toMatchObject({ allowed: false, code: 'outside_roots' });
      expect(await policy.check({ path: join(workspace, 'inner', 'a.ts'), permission: 'read', access })).toMatchObject({ allowed: true, canonicalPath: join(workspace, 'src', 'a.ts') });
    } finally { await cleanup(); }
  });

  it('gives the canonical path to use, whatever case and separators the request used', async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await mkdir(join(root, 'Data'));
      await writeFile(join(root, 'Data', 'File.txt'), 'x');
      const access = createNodeFsAccess();
      const policy = createFsPolicy({ roots: [{ path: root, permissions: ['read'] }] });
      const asked = process.platform === 'win32' ? join(root, 'data', 'FILE.TXT').replace(/\\/g, '/') : join(root, 'Data', '.', 'File.txt');
      const decision = await policy.check({ path: asked, permission: 'read', access });
      expect(decision).toMatchObject({ allowed: true, canonicalPath: join(root, 'Data', 'File.txt') });
      if (decision.allowed) expect(new TextDecoder().decode(await access.readFile(decision.canonicalPath))).toBe('x');
    } finally { await cleanup(); }
  });
});
