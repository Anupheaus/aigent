import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import { createFsDelete } from './fs-delete.js';
import { createFsMove } from './fs-move.js';
import { createFsStat } from './fs-stat.js';
import type { FsDeps } from './fs-shared.js';
import { call, entriesOf } from './fs-tools.test-support.js';

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

async function setup() {
  const { root, cleanup } = await tempRoot();
  const workspace = join(root, 'ws');
  await mkdir(join(workspace, 'target'), { recursive: true });
  await writeFile(join(workspace, 'target', 'keep.txt'), 'keep');
  const failure = await linkDirectory({ target: join(workspace, 'target'), path: join(workspace, 'link') });
  const deps: FsDeps = {
    access: createNodeFsAccess(), approvals: 'none', clock: { now: () => Date.now() },
    policy: createFsPolicy({ roots: [{ path: workspace, permissions: ['read', 'write', 'delete'] }] }),
  };
  return { workspace, cleanup, failure, deps };
}

describe('links on a real disk (junctions on Windows)', () => {
  it('fs_stat describes the junction itself, with its target', async context => {
    const { workspace, cleanup, failure, deps } = await setup();
    try {
      if (failure != null) { context.skip(`directory links cannot be created here: ${failure}`); return; }
      const [entry] = entriesOf(await call({ tool: createFsStat(deps), items: [{ path: join(workspace, 'link') }] }));
      expect(entry?.result).toMatchObject({ path: join(workspace, 'link'), type: 'symlink', linkTarget: join(workspace, 'target') });
    } finally { await cleanup(); }
  });

  it('fs_delete recursive removes only the junction, never what it points at', async context => {
    const { workspace, cleanup, failure, deps } = await setup();
    try {
      if (failure != null) { context.skip(`directory links cannot be created here: ${failure}`); return; }
      const [entry] = entriesOf(await call({ tool: createFsDelete(deps), items: [{ path: join(workspace, 'link'), recursive: true }] }));
      expect(entry?.result).toMatchObject({ type: 'symlink', recoverable: false });
      await expect(lstat(join(workspace, 'link'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(workspace, 'target', 'keep.txt'), 'utf8')).toBe('keep');
    } finally { await cleanup(); }
  });

  it('fs_move renames the junction and leaves the target directory where it was', async context => {
    const { workspace, cleanup, failure, deps } = await setup();
    try {
      if (failure != null) { context.skip(`directory links cannot be created here: ${failure}`); return; }
      const [entry] = entriesOf(await call({ tool: createFsMove(deps), items: [{ from: join(workspace, 'link'), to: join(workspace, 'renamed') }] }));
      expect(entry?.ok).toBe(true);
      expect((await lstat(join(workspace, 'renamed'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(workspace, 'target', 'keep.txt'), 'utf8')).toBe('keep');
    } finally { await cleanup(); }
  });
});
