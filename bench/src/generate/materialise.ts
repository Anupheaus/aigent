import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMemoryFsAccess, createNodeFsAccess } from '../../../src/tools/packs/fs/index.js';
import type { FsAccess, MemoryFsEntry } from '../../../src/tools/packs/fs/index.js';
import type { RepoTree } from './repo-types.js';

/** Root of in-memory repositories (posix paths). */
export const MEMORY_ROOT = '/repo';

/** sha256 over every path, its kind and its bytes, in path order: the identity of a generated tree. */
export function hashTree(tree: RepoTree): string {
  const hash = createHash('sha256');
  for (const path of [...tree.keys()].sort()) {
    const entry = tree.get(path);
    hash.update(path).update('\0');
    if (typeof entry === 'string') hash.update('f\0').update(entry);
    else if (entry instanceof Uint8Array) hash.update('b\0').update(entry);
    else if (entry != null) hash.update('l\0').update(entry.symlink);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Regular files in the tree (links are not counted). */
export function countFiles(tree: RepoTree): number {
  return [...tree.values()].filter(entry => typeof entry === 'string' || entry instanceof Uint8Array).length;
}

/** The tree on an in-memory `FsAccess` under `/repo`. */
export function toMemory(tree: RepoTree): { root: string; access: FsAccess } {
  const files: Record<string, MemoryFsEntry> = { [MEMORY_ROOT]: { dir: true } };
  for (const [path, entry] of tree) {
    files[`${MEMORY_ROOT}/${path}`] = typeof entry === 'string' || entry instanceof Uint8Array ? entry : { symlink: `${MEMORY_ROOT}/${entry.symlink}` };
  }
  return { root: MEMORY_ROOT, access: createMemoryFsAccess({ platform: 'posix', files, caseSensitive: true }) };
}

/**
 * The tree in a new temp directory on the real disk. Directory links become junctions on Windows (no privilege
 * needed); any link the platform refuses is left out and reported in `skippedLinks`.
 */
export async function toDisk(tree: RepoTree): Promise<{ root: string; access: FsAccess; skippedLinks: string[]; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'aigent-bench-'));
  const skippedLinks: string[] = [];
  for (const [path, entry] of [...tree.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    if (typeof entry === 'string' || entry instanceof Uint8Array) { await writeFile(target, entry); continue; }
    try {
      // Junctions need no privilege on Windows; elsewhere a directory symlink.
      await symlink(join(root, ...entry.symlink.split('/')), target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // A platform that refuses the link: the trap is then simply absent from this disk copy.
      skippedLinks.push(path);
    }
  }
  return { root, access: createNodeFsAccess(), skippedLinks, cleanup: () => rm(root, { recursive: true, force: true }) };
}
