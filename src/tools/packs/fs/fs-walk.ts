import type { FsEntryType } from '../../../security/fs-access.js';
import type { IgnoreMatcher } from '../../../security/ignore-rules.js';
import { separatorOf } from '../../../security/path-flavour.js';
import type { FsDeps } from './fs-shared.js';

/** Why an entry was left out of a listing or search; every skip is counted, never silent. */
export type SkipReason = 'denied' | 'hidden' | 'ignored' | 'binary' | 'tooLarge' | 'unreadable';

export interface WalkEntry {
  /** Canonical path. */
  path: string;
  /** From the walked directory, `/` separated. */
  relative: string;
  type: FsEntryType;
  size: number;
  mtimeMs: number;
}

/** Counts per reason, with a few sample paths for each. */
export interface SkipReport {
  counts: Record<SkipReason, number>;
  samples: Partial<Record<SkipReason, string[]>>;
}

/** Sample paths kept per skip reason. */
const SKIP_SAMPLES = 10;

export function createSkipReport(): SkipReport & { add(reason: SkipReason, path: string): void } {
  const counts: Record<SkipReason, number> = { denied: 0, hidden: 0, ignored: 0, binary: 0, tooLarge: 0, unreadable: 0 };
  const samples: Partial<Record<SkipReason, string[]>> = {};
  return {
    counts, samples,
    add: (reason, path) => {
      counts[reason] += 1;
      const list = samples[reason] ?? [];
      if (list.length < SKIP_SAMPLES) samples[reason] = [...list, path];
    },
  };
}

export interface WalkParams {
  deps: FsDeps;
  /** Canonical directory to walk (already allowed by the policy). */
  start: string;
  /** The policy root it is under, for deny globs. */
  root: string;
  /** Levels below `start` to descend (0: its own entries only). */
  maxDepth: number;
  includeHidden: boolean;
  ignore?: IgnoreMatcher;
  /** Stop after this many entries (the walk is then truncated). */
  maxEntries: number;
  skipped: ReturnType<typeof createSkipReport>;
}

/**
 * Every entry under `start` in a stable order (names sorted, depth first), without following symlinks (a link is an
 * entry of type `symlink`, never a way out of the root). Denied, hidden and ignored entries are skipped (and counted);
 * a skipped directory is not entered.
 */
export async function walk(params: WalkParams): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const { deps: { access, policy }, start, root, maxDepth, includeHidden, ignore, maxEntries, skipped } = params;
  const separator = separatorOf(access.platform);
  const entries: WalkEntry[] = [];
  let truncated = false;
  async function visit(directory: { path: string; relative: string; depth: number }): Promise<void> {
    let listing;
    try {
      listing = await access.readdir(directory.path);
    } catch {
      // A directory that cannot be listed is reported, not silently treated as empty.
      skipped.add('unreadable', directory.relative === '' ? '.' : directory.relative);
      return;
    }
    for (const { name, type } of listing) {
      if (entries.length >= maxEntries) { truncated = true; return; }
      const path = directory.path + (directory.path.endsWith(separator) ? '' : separator) + name;
      const relative = directory.relative === '' ? name : `${directory.relative}/${name}`;
      if (policy.isDenied({ path, root, permission: 'read', access })) { skipped.add('denied', relative); continue; }
      if (!includeHidden && name.startsWith('.')) { skipped.add('hidden', relative); continue; }
      if (ignore?.({ path: relative, isDirectory: type === 'directory' }) === true) { skipped.add('ignored', relative); continue; }
      const stat = await access.lstat(path).catch(() => undefined);
      if (stat == null) { skipped.add('unreadable', relative); continue; }
      entries.push({ path, relative, type, size: stat.size, mtimeMs: stat.mtimeMs });
      if (type === 'directory' && directory.depth < maxDepth) await visit({ path, relative, depth: directory.depth + 1 });
    }
  }
  await visit({ path: start, relative: '', depth: 0 });
  return { entries, truncated };
}
