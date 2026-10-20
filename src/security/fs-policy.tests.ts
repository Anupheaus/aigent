import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from './fs-access-memory.js';
import { createFsPolicy } from './fs-policy.js';
import type { FsPermission, FsPolicyOptions } from './fs-policy-types.js';

const posix = createMemoryFsAccess({
  platform: 'posix',
  files: { '/work/src/a.ts': 'a', '/work/.git/config': 'c', '/work/.env': 'k', '/work/node_modules/x/i.js': 'x', '/work/keys/id.pem': 'p', '/docs/readme.md': 'r', '/secret/s.txt': 's' },
});
const roots: FsPolicyOptions['roots'] = [{ path: '/work', permissions: ['read', 'write', 'delete'], label: 'workspace' }, { path: '/docs', permissions: ['read'] }];

async function decide(params: { path: string; permission?: FsPermission; options?: Partial<FsPolicyOptions>; bytes?: number }) {
  const { path, permission = 'read', options = {}, bytes } = params;
  return createFsPolicy({ roots, ...options }).check({ path, permission, access: posix, ...(bytes == null ? {} : { bytes }) });
}

describe('createFsPolicy decisions', () => {
  it('refuses everything without roots', async () => {
    expect(await decide({ path: '/work/src/a.ts', options: { roots: [] } })).toMatchObject({ allowed: false, code: 'no_roots', suggestion: expect.any(String) });
  });

  it.each<[string, string, FsPermission, object]>([
    ['inside a root', '/work/src/a.ts', 'read', { allowed: true, canonicalPath: '/work/src/a.ts', root: '/work' }],
    ['relative to the first root', 'src/a.ts', 'read', { allowed: true, canonicalPath: '/work/src/a.ts' }],
    ['a new file inside a root', '/work/src/new.ts', 'write', { allowed: true, canonicalPath: '/work/src/new.ts' }],
    ['dot-dot that stays inside', '/work/src/../src/a.ts', 'read', { allowed: true, canonicalPath: '/work/src/a.ts' }],
    ['outside every root', '/secret/s.txt', 'read', { allowed: false, code: 'outside_roots' }],
    ['dot-dot out of a root', '/work/../secret/s.txt', 'read', { allowed: false, code: 'outside_roots' }],
    ['a prefix sibling of a root', '/workshop/x', 'read', { allowed: false, code: 'outside_roots' }],
    ['writing to a read-only root', '/docs/readme.md', 'write', { allowed: false, code: 'permission_denied' }],
    ['reading .git contents', '/work/.git/config', 'read', { allowed: false, code: 'denied_glob' }],
    ['deleting the .git directory itself', '/work/.git', 'delete', { allowed: false, code: 'denied_glob' }],
    ['reading .env', '/work/.env', 'read', { allowed: false, code: 'denied_glob' }],
    ['reading a key', '/work/keys/id.pem', 'read', { allowed: false, code: 'denied_glob' }],
    ['reading node_modules', '/work/node_modules/x/i.js', 'read', { allowed: true }],
    ['writing node_modules', '/work/node_modules/x/i.js', 'write', { allowed: false, code: 'denied_glob' }],
    ['a NUL byte', '/work/a\u0000.ts', 'read', { allowed: false, code: 'invalid_path' }],
    ['a control character', '/work/a\u0007.ts', 'read', { allowed: false, code: 'invalid_path' }],
  ])('%s', async (_name, path, permission, expected) => {
    expect(await decide({ path, permission })).toMatchObject(expected);
  });

  it('refuses writes over maxWriteBytes', async () => {
    expect(await decide({ path: '/work/big.bin', permission: 'write', bytes: 2_000_000 })).toMatchObject({ allowed: false, code: 'too_large' });
    expect(await decide({ path: '/work/big.bin', permission: 'write', bytes: 10, options: { maxWriteBytes: 5 } })).toMatchObject({ allowed: false, code: 'too_large' });
  });

  it('uses given deny globs instead of the defaults, for every permission', async () => {
    expect(await decide({ path: '/work/.env', options: { denyGlobs: ['**/*.ts'] } })).toMatchObject({ allowed: true });
    expect(await decide({ path: '/work/src/a.ts', options: { denyGlobs: ['**/*.ts'] } })).toMatchObject({ allowed: false, code: 'denied_glob' });
  });

  it('follows a symlink to its target before checking, so a link out of a root is outside', async () => {
    const access = createMemoryFsAccess({ platform: 'posix', files: { '/work/out': { symlink: '/secret' }, '/work/in': { symlink: '/work/src' }, '/work/src/a.ts': 'a', '/secret/s.txt': 's' } });
    const policy = createFsPolicy({ roots: [{ path: '/work', permissions: ['read', 'write'] }] });
    expect(await policy.check({ path: '/work/out/s.txt', permission: 'read', access })).toMatchObject({ allowed: false, code: 'outside_roots' });
    expect(await policy.check({ path: '/work/out/new.txt', permission: 'write', access })).toMatchObject({ allowed: false, code: 'outside_roots' });
    expect(await policy.check({ path: '/work/in/a.ts', permission: 'read', access })).toMatchObject({ allowed: true, canonicalPath: '/work/src/a.ts' });
  });

  it('rejects an invalid root definition', () => {
    expect(() => createFsPolicy({ roots: [{ path: 'relative', permissions: ['read'] }] })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
    expect(() => createFsPolicy({ roots: [{ path: '/x', permissions: ['admin' as FsPermission] }] })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });
});

describe('createFsPolicy on Windows rules', () => {
  const windows = createMemoryFsAccess({ platform: 'win32', files: { 'C:\\Work\\Src\\a.ts': 'a', 'D:\\other\\b.txt': 'b' } });
  const policy = createFsPolicy({ roots: [{ path: 'C:\\Work', permissions: ['read', 'write'] }], platform: 'win32' });
  const check = (path: string) => policy.check({ path, permission: 'read', access: windows });

  it.each<[string, string, object]>([
    ['a case variant of a root path', 'c:\\work\\src\\A.TS', { allowed: true, canonicalPath: 'C:\\Work\\Src\\a.ts' }],
    ['forward slashes', 'C:/Work/Src/a.ts', { allowed: true, canonicalPath: 'C:\\Work\\Src\\a.ts' }],
    ['another drive', 'D:\\other\\b.txt', { allowed: false, code: 'outside_roots' }],
    ['a drive-relative path', 'C:Work\\Src\\a.ts', { allowed: false, code: 'invalid_path' }],
    ['a UNC path without a UNC root', '\\\\server\\share\\a.ts', { allowed: false, code: 'invalid_path' }],
    ['a device path', '\\\\?\\C:\\Work\\Src\\a.ts', { allowed: false, code: 'invalid_path' }],
    ['an alternate data stream', 'C:\\Work\\Src\\a.ts:hidden', { allowed: false, code: 'invalid_path' }],
    ['a trailing dot', 'C:\\Work\\Src\\a.ts.', { allowed: false, code: 'invalid_path' }],
    ['a trailing space', 'C:\\Work\\Src \\a.ts', { allowed: false, code: 'invalid_path' }],
    ['a reserved device name', 'C:\\Work\\NUL.txt', { allowed: false, code: 'invalid_path' }],
    ['a short name', 'C:\\WORK~1\\Src\\a.ts', { allowed: false, code: 'invalid_path' }],
    ['dot-dot to another drive root', 'C:\\Work\\..\\..\\Windows\\win.ini', { allowed: false, code: 'outside_roots' }],
  ])('%s', async (_name, path, expected) => {
    expect(await check(path)).toMatchObject(expected);
  });
});
