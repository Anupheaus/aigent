import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryFsAccess } from './fs-access-memory.js';
import type { FsAccess, PathPlatform } from './fs-access.js';
import { createFsPolicy } from './fs-policy.js';
import type { FsPermission } from './fs-policy-types.js';
import { comparable, separatorOf } from './path-flavour.js';

const RUNS = 400;
const PERMISSIONS: FsPermission[] = ['read', 'write', 'delete'];

interface World {
  platform: PathPlatform;
  access: FsAccess;
  root: string;
  /** Segments that make paths, tricky ones included. */
  tokens: string[];
  /** Absolute starts a generated path may take. */
  starts: string[];
}

const POSIX: World = {
  platform: 'posix',
  root: '/root',
  access: createMemoryFsAccess({
    platform: 'posix',
    files: {
      '/root/src/a.ts': 'a', '/root/docs/b.md': 'b', '/root/escape': { symlink: '/outside' }, '/root/inner': { symlink: '/root/src' },
      '/root/loop': { symlink: '/root/loop' }, '/root-other/x.txt': 'x', '/outside/secret.txt': 's', '/outside/back': { symlink: '/root/src' },
    },
  }),
  tokens: ['src', 'docs', 'a.ts', 'b.md', '..', '.', '', 'escape', 'inner', 'loop', 'outside', 'root', 'root-other', '%2e%2e', '...', '..\\..', 'a\\b', 'x y', 'new.txt', '\u0000', 'C:', 'secret.txt', 'back'],
  starts: ['', '/', '/root/', '/root/src/', '/outside/', '/root-other/', '//', './'],
};

const WIN32: World = {
  platform: 'win32',
  root: 'C:\\Root',
  access: createMemoryFsAccess({
    platform: 'win32',
    files: { 'C:\\Root\\Src\\a.ts': 'a', 'C:\\Root\\escape': { symlink: 'C:\\Outside' }, 'C:\\Outside\\secret.txt': 's', 'C:\\RootOther\\x.txt': 'x', 'D:\\Root\\y.txt': 'y' },
  }),
  tokens: ['Src', 'src', 'SRC', 'a.ts', 'A.TS', '..', '.', '', 'escape', 'Outside', 'Root', 'ROOT', 'RootOther', 'CON', 'nul.txt', 'com1', 'a.', 'a ', 'PROGRA~1', 'a.ts:zone', '%2e%2e', '...', 'new.txt', '\u0000', 'C:', 'D:', 'secret.txt'],
  starts: ['', 'C:\\', 'c:/', 'C:\\Root\\', 'c:\\root\\', 'C:/Root/', 'C:', 'D:\\Root\\', '\\', '\\\\server\\share\\', '\\\\?\\C:\\Root\\', '\\\\.\\C:\\', 'C:\\Outside\\'],
};

function pathArbitrary(world: World): fc.Arbitrary<string> {
  const separator = fc.constantFrom(...(world.platform === 'win32' ? ['\\', '/'] : ['/', '//']));
  const segment = fc.tuple(fc.constantFrom(...world.tokens), separator).map(([token, sep]) => token + sep);
  return fc.tuple(fc.constantFrom(...world.starts), fc.array(segment, { maxLength: 8 }), fc.constantFrom(...world.tokens))
    .map(([start, middle, last]) => start + middle.join('') + last);
}

/** Inside the root, compared the way the file system compares names. */
function isInsideRoot(params: { world: World; path: string }): boolean {
  const { world: { platform, root }, path } = params;
  const caseSensitive = platform === 'posix';
  const candidate = comparable({ path, caseSensitive });
  const base = comparable({ path: root, caseSensitive });
  return candidate === base || candidate.startsWith(base + separatorOf(platform));
}

/** Where the OS would really land: the canonical path's existing prefix resolved again, independently. */
async function landsAt(params: { world: World; path: string }): Promise<string> {
  const { world: { access, platform }, path } = params;
  const separator = separatorOf(platform);
  const segments = path.split(separator);
  for (let length = segments.length; length > 0; length -= 1) {
    const prefix = segments.slice(0, length).join(separator) || separator;
    const real = await access.realpath(prefix.endsWith(':') ? prefix + separator : prefix).catch(() => undefined);
    if (real != null) return [real, ...segments.slice(length)].join(separator).replace(/\\\\(?!$)/g, '\\');
  }
  return path;
}

for (const world of [POSIX, WIN32]) {
  describe(`FsPolicy path escapes (${world.platform} rules)`, () => {
    const policy = createFsPolicy({ roots: [{ path: world.root, permissions: PERMISSIONS }], platform: world.platform, denyGlobs: [] });

    it('never allows a path that resolves outside the root, whatever its spelling', async () => {
      await fc.assert(fc.asyncProperty(pathArbitrary(world), fc.constantFrom(...PERMISSIONS), async (path, permission) => {
        const decision = await policy.check({ path, permission, access: world.access });
        if (!decision.allowed) return;
        expect(isInsideRoot({ world, path: decision.canonicalPath })).toBe(true);
        // The checked path is final: resolving it again lands at the same place, still inside the root.
        const landed = await landsAt({ world, path: decision.canonicalPath });
        expect(comparable({ path: landed, caseSensitive: world.platform === 'posix' })).toBe(comparable({ path: decision.canonicalPath, caseSensitive: world.platform === 'posix' }));
        expect(isInsideRoot({ world, path: landed })).toBe(true);
        expect(decision.canonicalPath).not.toMatch(/\u0000/);
      }), { numRuns: RUNS });
    });

    it('allows every plain path built from real segments under the root', async () => {
      const separator = separatorOf(world.platform);
      const safe = fc.array(fc.constantFrom('a', 'b', 'notes', 'data_1'), { minLength: 1, maxLength: 5 }).map(segments => world.root + separator + segments.join(separator));
      await fc.assert(fc.asyncProperty(safe, async path => {
        expect(await policy.check({ path, permission: 'write', access: world.access })).toEqual({ allowed: true, canonicalPath: path, root: world.root });
      }), { numRuns: RUNS / 4 });
    });

    it('refuses very long paths and segments', async () => {
      const separator = separatorOf(world.platform);
      const longSegment = world.root + separator + 'x'.repeat(300);
      const longPath = world.root + (separator + 'a'.repeat(200)).repeat(200);
      for (const path of [longSegment, longPath]) expect(await policy.check({ path, permission: 'read', access: world.access })).toMatchObject({ allowed: false, code: 'invalid_path' });
    });
  });
}
