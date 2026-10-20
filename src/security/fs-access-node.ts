import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { BigIntStats, Dirent } from 'node:fs';
import type { FsAccess, FsEntryType, FsStat } from './fs-access.js';

function typeOf(entry: Pick<BigIntStats | Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>): FsEntryType {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  return entry.isDirectory() ? 'directory' : 'other';
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Big-integer stats, so the inode (a 64-bit file index on Windows) is exact in `fileId`. On Windows `fstat` reports
 * device 0 while `stat` reports the volume serial, so there the id is the file index alone (unique per volume).
 */
function toStat(stats: BigIntStats): FsStat {
  return { type: typeOf(stats), size: stats.isDirectory() ? 0 : Number(stats.size), mtimeMs: Number(stats.mtimeMs), fileId: IS_WINDOWS ? `${stats.ino}` : `${stats.dev}:${stats.ino}` };
}

/** The real disk through `node:fs/promises`. Paths must already be canonical (see `FsPolicy`). */
export function createNodeFsAccess(): FsAccess {
  return {
    platform: IS_WINDOWS ? 'win32' : 'posix',
    stat: async path => toStat(await stat(path, { bigint: true })),
    lstat: async path => toStat(await lstat(path, { bigint: true })),
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
        stat: async () => toStat(await handle.stat({ bigint: true })),
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
