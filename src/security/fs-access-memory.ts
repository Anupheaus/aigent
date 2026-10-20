import { fsError } from './fs-access.js';
import type { FsAccess, FsDirEntry, FsEntryType, FsStat, PathPlatform } from './fs-access.js';
import { comparable, isCaseSensitiveByDefault, joinParts, splitAbsolute } from './path-flavour.js';
import type { PathParts } from './path-flavour.js';

/** A seeded entry: file text or bytes, a directory, or a symlink to an absolute path. */
export type MemoryFsEntry = string | Uint8Array | { dir: true } | { symlink: string };

export interface MemoryFsOptions {
  platform: PathPlatform;
  /** Absolute paths; parent directories are created. */
  files?: Record<string, MemoryFsEntry>;
  /** Default: the platform's (case-insensitive on win32). */
  caseSensitive?: boolean;
}

type MemoryNode = { kind: 'file'; data: Uint8Array; mtimeMs: number } | { kind: 'dir'; mtimeMs: number } | { kind: 'symlink'; target: string; mtimeMs: number };

/** Symlink hops before `ELOOP`, as on Linux. */
const MAX_SYMLINK_HOPS = 40;

/** An in-memory `FsAccess` with the same behaviour as the real disk (see the shared contract tests), for fast tests. */
export function createMemoryFsAccess(options: MemoryFsOptions): FsAccess {
  const { platform, files = {} } = options;
  const caseSensitive = options.caseSensitive ?? isCaseSensitiveByDefault(platform);
  /** Keyed by the comparable path; each node keeps the path as first written (its case). */
  const nodes = new Map<string, { path: string; node: MemoryNode }>();
  let clock = 1;
  const tick = (): number => (clock += 1);

  const partsOf = (path: string): PathParts => {
    const parts = splitAbsolute({ path, platform });
    if (parts == null) throw fsError({ code: 'ENOENT', path, message: 'not an absolute path' });
    return parts;
  };
  const keyOf = (parts: PathParts): string => comparable({ path: joinParts({ parts, platform }), caseSensitive });
  const parentOf = (parts: PathParts): PathParts => ({ root: parts.root, segments: parts.segments.slice(0, -1) });
  const get = (parts: PathParts): { path: string; node: MemoryNode } | undefined => (parts.segments.length === 0 ? { path: parts.root, node: { kind: 'dir', mtimeMs: 0 } } : nodes.get(keyOf(parts)));
  const set = (parts: PathParts, node: MemoryNode): void => {
    const existing = nodes.get(keyOf(parts));
    nodes.set(keyOf(parts), { path: existing?.path ?? joinParts({ parts, platform }), node });
  };

  /** Resolves every symlink on the way, keeping each stored segment's own case. */
  function resolve(params: { path: string; followLast: boolean }): PathParts {
    const { path, followLast } = params;
    let pending = partsOf(path).segments;
    let resolved: PathParts = { root: partsOf(path).root, segments: [] };
    for (let hops = 0; pending.length > 0;) {
      const [segment = '', ...rest] = pending;
      const next: PathParts = { root: resolved.root, segments: [...resolved.segments, segment] };
      const entry = get(next);
      if (entry == null) { resolved = { root: next.root, segments: [...resolved.segments, segment] }; pending = rest; continue; }
      if (entry.node.kind === 'symlink' && (rest.length > 0 || followLast)) {
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) throw fsError({ code: 'ELOOP', path, message: 'too many symlinks' });
        const target = partsOf(entry.node.target);
        resolved = { root: target.root, segments: [] };
        pending = [...target.segments, ...rest];
        continue;
      }
      resolved = partsOf(entry.path);
      pending = rest;
    }
    return resolved;
  }

  function existing(params: { path: string; followLast?: boolean }): { parts: PathParts; node: MemoryNode } {
    const { path, followLast = true } = params;
    const parts = resolve({ path, followLast });
    const entry = get(parts);
    if (entry == null) throw fsError({ code: 'ENOENT', path, message: 'no such file or directory' });
    return { parts: partsOf(entry.path), node: entry.node };
  }

  function requireParentDir(params: { path: string; parts: PathParts }): void {
    const { path, parts } = params;
    const parent = get(parentOf(parts));
    if (parent == null) throw fsError({ code: 'ENOENT', path, message: 'no such directory' });
    if (parent.node.kind !== 'dir') throw fsError({ code: 'ENOTDIR', path, message: 'not a directory' });
  }

  const children = (parts: PathParts): { name: string; parts: PathParts; node: MemoryNode }[] => {
    const prefix = keyOf(parts) + (parts.segments.length === 0 ? '' : platform === 'win32' ? '\\' : '/');
    return [...nodes.entries()].flatMap(([key, { path, node }]) => {
      if (!key.startsWith(prefix) || key === prefix) return [];
      const own = partsOf(path);
      return own.segments.length === parts.segments.length + 1 ? [{ name: own.segments.at(-1) ?? '', parts: own, node }] : [];
    });
  };
  const typeOf = (node: MemoryNode): FsEntryType => (node.kind === 'dir' ? 'directory' : node.kind);
  const statOf = (node: MemoryNode): FsStat => ({ type: typeOf(node), size: node.kind === 'file' ? node.data.length : 0, mtimeMs: node.mtimeMs });
  const mkdirs = (parts: PathParts): void => {
    for (let depth = 1; depth <= parts.segments.length; depth += 1) {
      const ancestor = { root: parts.root, segments: parts.segments.slice(0, depth) };
      if (get(ancestor) == null) set(ancestor, { kind: 'dir', mtimeMs: tick() });
    }
  };

  for (const [path, entry] of Object.entries(files)) {
    const parts = partsOf(path);
    mkdirs(parentOf(parts));
    if (typeof entry === 'string') set(parts, { kind: 'file', data: new TextEncoder().encode(entry), mtimeMs: tick() });
    else if (entry instanceof Uint8Array) set(parts, { kind: 'file', data: entry, mtimeMs: tick() });
    else if ('dir' in entry) mkdirs(parts);
    else set(parts, { kind: 'symlink', target: entry.symlink, mtimeMs: tick() });
  }

  const readFile = async (path: string): Promise<Uint8Array> => {
    const { node } = existing({ path });
    if (node.kind !== 'file') throw fsError({ code: 'EISDIR', path, message: 'is a directory' });
    return node.data.slice();
  };

  return {
    platform,
    stat: async path => statOf(existing({ path }).node),
    lstat: async path => statOf(existing({ path, followLast: false }).node),
    realpath: async path => joinParts({ parts: existing({ path }).parts, platform }),
    readFile,
    open: async path => {
      const data = await readFile(path);
      return { read: async ({ offset, length }) => data.slice(offset, offset + length), close: async () => undefined };
    },
    writeFile: async ({ path, data, exclusive = false }) => {
      const parts = resolve({ path, followLast: true });
      requireParentDir({ path, parts });
      const current = get(parts);
      if (current != null && exclusive) throw fsError({ code: 'EEXIST', path, message: 'file already exists' });
      if (current?.node.kind === 'dir') throw fsError({ code: 'EISDIR', path, message: 'is a directory' });
      set(parts, { kind: 'file', data: data.slice(), mtimeMs: tick() });
    },
    mkdir: async (path, mkdirOptions = {}) => {
      const parts = resolve({ path, followLast: true });
      if (mkdirOptions.recursive === true) { mkdirs(parts); return; }
      if (get(parts) != null) throw fsError({ code: 'EEXIST', path, message: 'already exists' });
      requireParentDir({ path, parts });
      set(parts, { kind: 'dir', mtimeMs: tick() });
    },
    readdir: async path => {
      const { parts, node } = existing({ path });
      if (node.kind !== 'dir') throw fsError({ code: 'ENOTDIR', path, message: 'not a directory' });
      return children(parts).map(({ name, node: child }): FsDirEntry => ({ name, type: typeOf(child) })).sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
    },
    rename: async (from, to) => {
      const source = existing({ path: from, followLast: false });
      const target = resolve({ path: to, followLast: false });
      requireParentDir({ path: to, parts: target });
      const moved = [{ parts: source.parts, node: source.node }, ...children(source.parts).flatMap(function walk(child): { parts: PathParts; node: MemoryNode }[] { return [child, ...children(child.parts).flatMap(walk)]; })];
      for (const { parts } of moved) nodes.delete(keyOf(parts));
      for (const { parts, node } of moved) set({ root: target.root, segments: [...target.segments, ...parts.segments.slice(source.parts.segments.length)] }, node);
    },
    rm: async (path, rmOptions = {}) => {
      const { parts, node } = existing({ path, followLast: false });
      const below = children(parts);
      if (node.kind === 'dir' && rmOptions.recursive !== true) throw fsError({ code: below.length > 0 ? 'ENOTEMPTY' : 'EISDIR', path, message: 'is a directory' });
      const prefix = keyOf(parts);
      for (const key of [...nodes.keys()]) if (key === prefix || key.startsWith(prefix + (platform === 'win32' ? '\\' : '/'))) nodes.delete(key);
    },
    copyFile: async (from, to) => {
      const data = await readFile(from);
      const parts = resolve({ path: to, followLast: true });
      requireParentDir({ path: to, parts });
      set(parts, { kind: 'file', data, mtimeMs: tick() });
    },
  };
}
