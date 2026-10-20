import { relativeTo } from '../../../security/canonical-path.js';
import type { FsPermission } from '../../../security/fs-policy-types.js';
import { comparable, separatorOf } from '../../../security/path-flavour.js';
import { toolFailure } from '../../tool-failure.js';
import type { FsDeps } from './fs-shared.js';

/** Deepest directory nesting checked; anything deeper is refused rather than left unchecked. */
const MAX_CHECK_DEPTH = 64;

/** `assertSubtreeUnprotected`. */
export interface SubtreeCheck {
  deps: FsDeps;
  /** Canonical path about to be moved or deleted (a link is not entered). */
  path: string;
  /** The policy root it is under. */
  root: string;
  /** For a move: where the entries will land (canonical) and the root there, so deny globs are checked at both ends. */
  destination?: { path: string; root: string };
}

function refused(params: { code: string; message: string; suggestion: string }): never {
  throw toolFailure({ category: 'denied', retryable: false, ...params });
}

/** Refuses when a configured root lies strictly below `path`: moving or deleting it would take the root's rules with it. */
async function assertNoRootBelow(params: { deps: FsDeps; path: string }): Promise<void> {
  const { deps: { policy, access }, path } = params;
  const caseSensitive = policy.caseSensitive(access);
  const separator = separatorOf(access.platform);
  const prefix = comparable({ path: path.endsWith(separator) ? path : path + separator, caseSensitive });
  for (const { path: rootPath, label } of policy.roots) {
    const canonical = await policy.canonicalise({ path: rootPath, access });
    if (canonical.ok && comparable({ path: canonical.path, caseSensitive }).startsWith(prefix)) {
      refused({ code: 'contains_root', message: `'${path}' contains the allowed root '${label ?? rootPath}', whose rules would not survive moving or deleting it`, suggestion: 'Move or delete the entries beside that root instead' });
    }
  }
}

/**
 * Refuses moving or deleting `path` when anything under it is protected: a configured root strictly below it, or an
 * entry (at its place now, or for a move where it would land) that a deny glob refuses. The walk never follows links,
 * is bounded by the policy's `maxFiles` and depth, and fails closed (`too_many_entries`) past them. Entries created
 * between this check and the operation are not seen (a documented race).
 */
export async function assertSubtreeUnprotected(check: SubtreeCheck): Promise<void> {
  const { deps, path, root, destination } = check;
  const { policy, access } = deps;
  await assertNoRootBelow({ deps, path });
  if ((await access.lstat(path)).type !== 'directory') return;
  const separator = separatorOf(access.platform);
  let visited = 0;
  async function visit(params: { directory: string; depth: number }): Promise<void> {
    const { directory, depth } = params;
    if (depth > MAX_CHECK_DEPTH) refused({ code: 'too_many_entries', message: `'${path}' is nested deeper than ${MAX_CHECK_DEPTH} levels, so it cannot be checked`, suggestion: 'Move or delete its contents in parts' });
    for (const { name, type } of await access.readdir(directory)) {
      visited += 1;
      if (visited > policy.limits.maxFiles) refused({ code: 'too_many_entries', message: `'${path}' holds more than ${policy.limits.maxFiles} entries, so it cannot be checked for protected files`, suggestion: 'Move or delete its contents in smaller parts' });
      const entry = directory + separator + name;
      const landing = destination == null ? undefined : destination.path + entry.slice(path.length);
      const isProtectedHere = policy.isDenied({ path: entry, root, permission: 'delete', access });
      const isProtectedThere = destination != null && landing != null && policy.isDenied({ path: landing, root: destination.root, permission: 'write' satisfies FsPermission, access });
      if (isProtectedHere || isProtectedThere) {
        const shown = isProtectedHere ? relativeTo({ path: entry, root, platform: access.platform }) : relativeTo({ path: landing ?? entry, root: destination?.root ?? root, platform: access.platform });
        refused({ code: 'contains_protected', message: `'${path}' cannot be ${destination == null ? 'deleted' : 'moved'}: '${shown}' ${isProtectedHere ? 'inside it is protected' : 'would land on a protected path'}`, suggestion: 'Leave protected files (VCS data, secrets, installed packages) alone; move or delete the other entries one by one' });
      }
      if (type === 'directory') await visit({ directory: entry, depth: depth + 1 });
    }
  }
  await visit({ directory: path, depth: 1 });
}
