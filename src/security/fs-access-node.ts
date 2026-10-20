import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import type { FsAccess, FsEntryType, FsStat } from './fs-access.js';

function typeOf(entry: Pick<Stats | Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>): FsEntryType {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  return entry.isDirectory() ? 'directory' : 'other';
}

function toStat(stats: Stats): FsStat {
  return { type: typeOf(stats), size: stats.isDirectory() ? 0 : stats.size, mtimeMs: stats.mtimeMs };
}

/** The real disk through `node:fs/promises`. Paths must already be canonical (see `FsPolicy`). */
export function createNodeFsAccess(): FsAccess {
  return {
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    stat: async path => toStat(await stat(path)),
    lstat: async path => toStat(await lstat(path)),
    // fs.promises.realpath has native semantics: it also expands Windows short (8.3) names and resolves junctions.
    realpath: path => realpath(path),
    readFile: async path => new Uint8Array(await readFile(path)),
    open: async path => {
      const handle = await open(path, 'r');
      return {
        read: async ({ offset, length }) => {
          const buffer = new Uint8Array(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return buffer.subarray(0, bytesRead);
        },
        close: () => handle.close(),
      };
    },
    writeFile: ({ path, data, exclusive = false }) => writeFile(path, data, { flag: exclusive ? 'wx' : 'w' }),
    mkdir: async (path, options = {}) => { await mkdir(path, { recursive: options.recursive ?? false }); },
    readdir: async path => (await readdir(path, { withFileTypes: true }))
      .map(entry => ({ name: entry.name, type: typeOf(entry) }))
      .sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0)),
    rename: (from, to) => rename(from, to),
    rm: (path, options = {}) => rm(path, { recursive: options.recursive ?? false }),
    copyFile: (from, to) => copyFile(from, to),
  };
}
