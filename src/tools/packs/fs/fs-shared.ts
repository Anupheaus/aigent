import { createSystemClock } from '../../../core/runtime-services.js';
import type { Clock } from '../../../core/runtime-services.js';
import { fsErrorCode } from '../../../security/fs-access.js';
import type { FsAccess } from '../../../security/fs-access.js';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsPermission, FsPolicy } from '../../../security/fs-policy-types.js';
import { BATCH_RESULT_HELPERS } from '../../batch-entries.js';
import type { BatchEntry } from '../../batch-entries.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolFailure } from '../../tool-failure.js';
import type { Tool, ToolOutcome } from '../../tool-types.js';

/** Which filesystem operations need a person's approval (on top of `FsPolicyOptions.approval`). */
export type FsApprovals = 'writes' | 'deletes' | 'none';

/** `fsTools(options)`. */
export interface FsToolsOptions {
  /** The path authority every tool goes through (deny by default). */
  policy: FsPolicy;
  /** Default: the real disk (`createNodeFsAccess()`). */
  access?: FsAccess;
  /** Default `deletes`: deletes need approval; `writes` adds writes, edits and moves; `none` asks for nothing. */
  approvals?: FsApprovals;
  /**
   * Where prior contents are backed up (so writes, edits and moves can be undone) and where deletes are moved
   * (a managed trash, so deletes can be undone). Without it, overwrites and deletes cannot be undone. Must be on the
   * same volume as the roots.
   */
  backupDir?: string;
  clock?: Clock;
}

/** What every filesystem tool is built from. */
export interface FsDeps {
  policy: FsPolicy;
  access: FsAccess;
  approvals: FsApprovals;
  backupDir?: string;
  clock: Clock;
}

export function resolveDeps(options: FsToolsOptions): FsDeps {
  const { policy, access = createNodeFsAccess(), approvals = 'deletes', backupDir, clock = createSystemClock() } = options;
  return { policy, access, approvals, clock, ...(backupDir == null ? {} : { backupDir }) };
}

/** Upper bound on items in one filesystem call. */
export const MAX_FS_ITEMS = 50;

/** The canonical path the policy allows (and its root); throws a `denied` failure the model can act on otherwise. */
export async function allowPath(params: { deps: FsDeps; path: string; permission: FsPermission; bytes?: number }): Promise<{ path: string; root: string }> {
  const { deps: { policy, access }, path, permission, bytes } = params;
  const decision = await policy.check({ path, permission, access, ...(bytes == null ? {} : { bytes }) });
  if (decision.allowed) return { path: decision.canonicalPath, root: decision.root };
  throw toolFailure({ category: 'denied', code: decision.code, message: decision.message, retryable: false, ...(decision.suggestion == null ? {} : { suggestion: decision.suggestion }), details: { path, permission } });
}

const FS_CODE_MESSAGES: Record<string, { code: string; message: string; suggestion?: string }> = {
  ENOENT: { code: 'not_found', message: 'does not exist', suggestion: 'Check the path with fs_list or fs_search' },
  EEXIST: { code: 'already_exists', message: 'already exists', suggestion: 'Pass overwrite: true to replace it, or choose another path' },
  ENOTDIR: { code: 'not_a_directory', message: 'has a file where a directory was expected' },
  EISDIR: { code: 'is_a_directory', message: 'is a directory' },
  ENOTEMPTY: { code: 'not_empty', message: 'is a directory that is not empty', suggestion: 'Pass recursive: true to delete it with its contents' },
  ELOOP: { code: 'symlink_loop', message: 'goes through a symlink loop' },
  EACCES: { code: 'access_denied', message: 'cannot be accessed (operating-system permissions)' },
  EPERM: { code: 'access_denied', message: 'cannot be changed (operating-system permissions)' },
};

/** A disk failure as the model should see it: what happened to which path, by its file-system code. */
export function diskFailure(params: { error: unknown; path: string }): ToolFailure {
  const { error, path } = params;
  const fsCode = fsErrorCode(error);
  const known = fsCode == null ? undefined : FS_CODE_MESSAGES[fsCode];
  if (known == null) return toolFailure({ code: 'io_error', message: `'${path}': ${error instanceof Error ? error.message : String(error)}`, retryable: true, details: { path, ...(fsCode == null ? {} : { fsCode }) } });
  return toolFailure({ code: known.code, message: `'${path}' ${known.message}`, retryable: false, details: { path, fsCode }, ...(known.suggestion == null ? {} : { suggestion: known.suggestion }) });
}

/** Runs disk work, turning a file-system error into a structured failure (policy failures pass through). */
export async function onDisk<T>(params: { path: string; work(): Promise<T> }): Promise<T> {
  const { path, work } = params;
  try {
    return await work();
  } catch (error) {
    if (fsErrorCode(error) == null) throw error;
    throw diskFailure({ error, path });
  }
}

function batchEntries(result: unknown): BatchEntry[] {
  return Array.isArray(result) ? result as BatchEntry[] : [];
}

/** The batch outcome, with the first failure's reason so an activity row says why (e.g. "outside every allowed root"). */
function summarise(result: unknown): ToolOutcome {
  const entries = batchEntries(result);
  const failures = entries.flatMap(entry => (entry.ok ? [] : [entry.error]));
  const [first] = failures;
  if (first == null) return { success: true, reason: `${entries.length} of ${entries.length} items succeeded` };
  return { success: false, reason: `${failures.length} of ${entries.length} items failed: ${first.message}` };
}

/** Batch helpers for the filesystem tools: failure reasons come from the structured errors. */
export const FS_RESULT_HELPERS: Required<Pick<Tool, 'summarise' | 'nestedFailures' | 'countItems'>> = { ...BATCH_RESULT_HELPERS, summarise };

/** The last segment of a path, for activity titles. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(segment => segment !== '').at(-1) ?? path;
}

/** "Reading a.ts" for one item, "Reading 3 files" for several. */
export function countTitle(params: { verb: string; noun: string; paths: string[] }): string {
  const { verb, noun, paths } = params;
  const [only] = paths;
  return paths.length === 1 && only != null ? `${verb} ${baseName(only)}` : `${verb} ${paths.length} ${noun}`;
}

/** Whether a mutating operation needs approval under the tools' mode and the policy's own rule. */
export function needsApproval(params: { deps: FsDeps; kind: 'write' | 'delete'; paths: { path: string; permission: FsPermission }[]; tool: string }): boolean {
  const { deps: { approvals, policy }, kind, paths, tool } = params;
  if (approvals === 'writes' || (approvals === 'deletes' && kind === 'delete')) return true;
  return paths.some(({ path, permission }) => policy.needsApproval({ path, permission, tool }));
}
