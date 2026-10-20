import { describe, expect, it } from 'vitest';
import type { FsAccess } from '../../../security/fs-access.js';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import type { MemoryFsEntry } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { createFsDelete } from './fs-delete.js';
import { createFsEdit } from './fs-edit.js';
import { createFsMove } from './fs-move.js';
import { createFsRead } from './fs-read.js';
import type { FsDeps } from './fs-shared.js';
import { call, entriesOf, textAt } from './fs-tools.test-support.js';
import { createFsWrite } from './fs-write.js';

type Operation = Exclude<keyof FsAccess, 'platform'>;

/**
 * A disk where `/ws/sub` is a real directory until the first `trigger` call, and from then on (that call included) a
 * link to `/outside`: what another process swapping the directory for a junction between check and use looks like.
 */
function swappingDisk(params: { trigger: Operation; files: Record<string, MemoryFsEntry> }) {
  const { trigger, files } = params;
  const before = createMemoryFsAccess({ platform: 'posix', files: { '/ws/sub': { dir: true }, '/outside': { dir: true }, ...files } });
  const outsideFiles = Object.fromEntries(Object.entries(files).map(([path, entry]) => [path.replace('/ws/sub/', '/outside/'), entry]));
  const after = createMemoryFsAccess({ platform: 'posix', files: { '/ws/other.txt': 'o', '/outside': { dir: true }, ...outsideFiles, '/ws/sub': { symlink: '/outside' } } });
  let isSwapped = false;
  const current = (operation: Operation): FsAccess => {
    if (operation === trigger) isSwapped = true;
    return isSwapped ? after : before;
  };
  const access: FsAccess = {
    platform: 'posix',
    stat: path => current('stat').stat(path),
    lstat: path => current('lstat').lstat(path),
    realpath: path => current('realpath').realpath(path),
    readFile: path => current('readFile').readFile(path),
    open: path => current('open').open(path),
    writeFile: request => current('writeFile').writeFile(request),
    mkdir: (path, options) => current('mkdir').mkdir(path, options),
    readdir: path => current('readdir').readdir(path),
    rename: (from, to) => current('rename').rename(from, to),
    rm: (path, options) => current('rm').rm(path, options),
    copyFile: (from, to) => current('copyFile').copyFile(from, to),
  };
  const deps: FsDeps = { access, approvals: 'none', clock: { now: () => 1 }, policy: createFsPolicy({ roots: [{ path: '/ws', permissions: ['read', 'write', 'delete'] }] }) };
  return { deps, outside: after };
}

const changed = expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'path_changed', category: 'denied' }) });

describe('a directory swapped for a link after the check (I4)', () => {
  it('fs_write refuses, and nothing is left outside the root', async () => {
    for (const item of [{ path: '/ws/sub/new.txt', content: 'x' }, { path: '/ws/sub/over.txt', content: 'x', overwrite: true }]) {
      const { deps, outside } = swappingDisk({ trigger: 'writeFile', files: {} });
      expect(entriesOf(await call({ tool: createFsWrite(deps), items: [item] }))).toEqual([changed]);
      expect(await outside.readdir('/outside')).toEqual([]);
    }
  });

  it('fs_read refuses to return the content of the file outside', async () => {
    const { deps } = swappingDisk({ trigger: 'open', files: { '/ws/sub/a.txt': 'SECRET' } });
    const [entry] = entriesOf(await call({ tool: createFsRead(deps), items: [{ path: '/ws/sub/a.txt' }] }));
    expect(entry).toEqual(changed);
    expect(JSON.stringify(entry)).not.toContain('SECRET');
  });

  it('fs_edit refuses before writing, leaving the outside file unchanged', async () => {
    const { deps, outside } = swappingDisk({ trigger: 'open', files: { '/ws/sub/a.txt': 'hello' } });
    expect(entriesOf(await call({ tool: createFsEdit(deps), items: [{ path: '/ws/sub/a.txt', edits: [{ oldText: 'hello', newText: 'bye' }] }] }))).toEqual([changed]);
    expect(await textAt(outside, '/outside/a.txt')).toBe('hello');
  });

  it('fs_delete and fs_move refuse when the parent no longer resolves to itself', async () => {
    const forDelete = swappingDisk({ trigger: 'lstat', files: { '/ws/sub/x.txt': 'x' } });
    expect(entriesOf(await call({ tool: createFsDelete(forDelete.deps), items: [{ path: '/ws/sub/x.txt' }] }))).toEqual([changed]);
    expect(await textAt(forDelete.outside, '/outside/x.txt')).toBe('x');
    const forMove = swappingDisk({ trigger: 'lstat', files: { '/ws/sub/x.txt': 'x' } });
    expect(entriesOf(await call({ tool: createFsMove(forMove.deps), items: [{ from: '/ws/sub/x.txt', to: '/ws/moved.txt' }] }))).toEqual([changed]);
    expect(await textAt(forMove.outside, '/outside/x.txt')).toBe('x');
  });
});
