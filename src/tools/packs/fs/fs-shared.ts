import { createSystemClock } from '../../../core/runtime-services.js';
import type { Clock } from '../../../core/runtime-services.js';
import { fsErrorCode } from '../../../security/fs-access.js';
import type { FsAccess } from '../../../security/fs-access.js';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsPermission, FsPolicy } from '../../../security/fs-policy-types.js';
import { BATCH_RESULT_HELPERS_WITH_REASONS } from '../../batch-entries.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolFailure } from '../../tool-failure.js';
import type { Tool } from '../../tool-types.js';

/** Which filesystem operations need a person's approval (on top of `FsPolicyOptions.approval`). */
export type FsApprovals = 'writes' | 'deletes' | 'none';

/** `fsTools(options)`. */
export interface FsToolsOptions {
  /** The path authority every tool goes through (deny by default). */
  policy: FsPolicy;
  /**
   * Default: the real disk (`createNodeFsAccess()`). Each operation re-verifies the checked path right before and
   * after it acts (see `fs-verify.ts`), and the mutating tools of one `fsTools()` run one at a time; a directory swapped
   * for a link in the instant between the last check and the operation can still redirect that operation (it is then
   * reported as `path_changed`), because Node offers no handle-relative or no-follow file operations.
   */
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

/** A mutating tool's approval gate, so the run-time check can tell whether the gate asked about a path. */
export interface ApprovalGate {
  kind: 'write' | 'delete';
  tool: string;
}

/** `allowPath`. */
export interface AllowPathRequest {
  deps: FsDeps;
  path: string;
  permission: FsPermission;
  bytes?: number;
  /** Default true; false checks a final link itself (see `FsCheckRequest.followFinalLink`). */
  followFinalLink?: boolean;
  /** Mutating tools: refuse when the canonical path needs approval the gate did not ask for. */
  gate?: ApprovalGate;
}

/** The canonical path the policy allows (and its root); throws a `denied` failure the model can act on otherwise. */
export async function allowPath(params: AllowPathRequest): Promise<{ path: string; root: string }> {
  const { deps, path, permission, bytes, followFinalLink = true, gate } = params;
  const { policy, access } = deps;
  const decision = await policy.check({ path, permission, access, followFinalLink, ...(bytes == null ? {} : { bytes }) });
  if (!decision.allowed) throw toolFailure({ category: 'denied', code: decision.code, message: decision.message, retryable: false, ...(decision.suggestion == null ? {} : { suggestion: decision.suggestion }), details: { path, permission } });
  if (gate != null) confirmApproved({ deps, gate, requested: path, canonical: decision.canonicalPath, permission });
  return { path: decision.canonicalPath, root: decision.root };
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

/** Batch helpers for the filesystem tools: failure reasons come from the structured errors. */
export const FS_RESULT_HELPERS: Required<Pick<Tool, 'summarise' | 'nestedFailures' | 'countItems'>> = BATCH_RESULT_HELPERS_WITH_REASONS;

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

const isGatedByMode = (params: { approvals: FsApprovals; kind: 'write' | 'delete' }): boolean => params.approvals === 'writes' || (params.approvals === 'deletes' && params.kind === 'delete');

/** Whether the policy's rule wants the operation approved, judged on the path's lexical canonical form. */
function ruleAsks(params: { deps: FsDeps; path: string; permission: FsPermission; tool: string }): boolean {
  const { deps: { policy, access }, path, permission, tool } = params;
  const lexical = policy.lexical({ path, access });
  // An unusable path is refused when the call runs; asking first fails closed.
  return !lexical.ok || policy.needsApproval({ path: lexical.path, permission, tool });
}

/**
 * Whether a mutating operation needs approval under the tools' mode and the policy's own rule. The rule sees the
 * canonical form (absolute, `..` applied, separators normalised), never the model's spelling; a link that hides a
 * protected path from this synchronous check is caught when the call runs (`allowPath` with `gate`).
 */
export function needsApproval(params: { deps: FsDeps; kind: 'write' | 'delete'; paths: { path: string; permission: FsPermission }[]; tool: string }): boolean {
  const { deps, kind, paths, tool } = params;
  if (isGatedByMode({ approvals: deps.approvals, kind })) return true;
  return paths.some(({ path, permission }) => ruleAsks({ deps, path, permission, tool }));
}

/** Refuses an operation whose resolved path needs approval that the gate did not ask for (a link changed the path). */
function confirmApproved(params: { deps: FsDeps; gate: ApprovalGate; requested: string; canonical: string; permission: FsPermission }): void {
  const { deps, gate: { kind, tool }, requested, canonical, permission } = params;
  if (isGatedByMode({ approvals: deps.approvals, kind }) || !deps.policy.needsApproval({ path: canonical, permission, tool })) return;
  if (ruleAsks({ deps, path: requested, permission, tool })) return;
  throw toolFailure({ category: 'denied', code: 'approval_required', retryable: false, message: `'${requested}' resolves to '${canonical}', which needs approval, but the call was not approved for it`, suggestion: `Use the path '${canonical}' itself, so approval is asked for it`, details: { path: requested, canonicalPath: canonical, permission } });
}
