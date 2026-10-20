import { describe, expect, it } from 'vitest';
import type { FsAccess } from '../../../security/fs-access.js';
import { fsError } from '../../../security/fs-access.js';
import { createMemoryFsAccess } from '../../../security/fs-access-memory.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import { fsTools } from './fs-tools.js';
import { call, CONTEXT, entriesOf, memoryDeps } from './fs-tools.test-support.js';
import { backUp } from './fs-undo.js';
import { createFsWrite } from './fs-write.js';

describe('filesystem pack minor fixes', () => {
  it('backUp fails on a persistent disk error instead of looping forever', async () => {
    const deps = memoryDeps({ files: { '/ws/a.txt': 'a' } });
    const failing: FsAccess = { ...deps.access, lstat: async path => (path.startsWith('/backups') ? Promise.reject(fsError({ code: 'EACCES', path, message: 'denied' })) : deps.access.lstat(path)) };
    await expect(backUp({ deps: { ...deps, access: failing }, context: CONTEXT, path: '/ws/a.txt' })).rejects.toMatchObject({ details: { fsCode: 'EACCES' } });
  });

  it('refuses names with invisible or bidirectional formatting characters, which can spoof what an approval shows', async () => {
    const deps = memoryDeps();
    for (const name of ['x‮txt.exe', 'a​b.txt', 'c⁦d.txt']) {
      expect(await deps.policy.check({ path: `/ws/${name}`, permission: 'write', access: deps.access })).toMatchObject({ allowed: false, code: 'invalid_path' });
    }
  });

  it('refuses a backupDir inside an allowed root, where the agent could read or tamper with backups', () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { '/ws': { dir: true } } });
    const policy = createFsPolicy({ roots: [{ path: '/ws', permissions: ['read', 'write'] }] });
    expect(() => fsTools({ policy, access, backupDir: '/ws/.backups' })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(fsTools({ policy, access, backupDir: '/elsewhere/backups' })).toHaveLength(8);
  });

  it('fs_write verify returns batch entries, the shape a normal result has', async () => {
    const deps = memoryDeps({ files: { '/ws/v.txt': 'final' } });
    const tool = createFsWrite(deps);
    expect(await tool.verify?.({ items: [{ path: '/ws/v.txt', content: 'final' }] }, CONTEXT)).toEqual({ done: true, result: [{ index: 0, ok: true, result: { path: '/ws/v.txt', verified: true } }] });
    expect(entriesOf(await call({ tool, items: [{ path: '/ws/w.txt', content: 'x' }] }))).toHaveLength(1);
  });
});
