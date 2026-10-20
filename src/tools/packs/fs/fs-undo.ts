import { fsErrorCode } from '../../../security/fs-access.js';
import type { UndoDescriptor, UndoOutcome } from '../../../effects/undo-types.js';
import type { BatchEntry } from '../../batch-entries.js';
import type { ToolContext } from '../../tool-types.js';
import { baseName } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { sha256 } from './fs-text.js';

/** One reversible step of a filesystem call, recorded with its item's result. */
export type UndoStep =
  /** A file this call created: removed if it still holds what was written. */
  | { kind: 'remove-created'; path: string; hash: string }
  /** A file this call replaced: its backup is put back if it still holds what was written. */
  | { kind: 'restore-backup'; path: string; backup: string; hash: string }
  /** A path this call moved (or deleted into the trash): moved back if its old place is free. */
  | { kind: 'move-back'; from: string; to: string }
  /** A change this call cannot reverse, and why. */
  | { kind: 'not-undoable'; path: string; reason: string };

/** Where an item's undo steps are kept on its result, out of what the model sees (JSON skips symbol keys). */
const UNDO_STEPS = Symbol('fs-undo-steps');

/** Marks an item result with the steps that reverse it. */
export function withUndo<T extends object>(params: { result: T; steps: UndoStep[] }): T {
  const { result, steps } = params;
  Object.defineProperty(result, UNDO_STEPS, { value: steps, enumerable: false });
  return result;
}

/** The undo descriptor of a batch call: every successful item's steps, in item order (reversed when applied). */
export async function undoDescriptor(result: unknown): Promise<UndoDescriptor | undefined> {
  const entries = Array.isArray(result) ? result as BatchEntry[] : [];
  const steps = entries.flatMap(entry => (entry.ok && typeof entry.result === 'object' && entry.result !== null ? (entry.result as Record<symbol, UndoStep[] | undefined>)[UNDO_STEPS] ?? [] : []));
  return steps.length === 0 ? undefined : { steps };
}

/** A safe directory name for one call's backups, stable across a resume (from the idempotency key). */
function callFolder(context: ToolContext): string {
  return (context.idempotencyKey ?? `${context.runId}:${context.callId}`).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Where a call keeps the prior content of `path` (or its deleted copy), under `backupDir`. */
export function backupPathFor(params: { deps: FsDeps; context: ToolContext; path: string; purpose: 'backup' | 'trash' }): string | undefined {
  const { deps: { backupDir, access }, context, path, purpose } = params;
  if (backupDir == null) return undefined;
  const separator = access.platform === 'win32' ? '\\' : '/';
  return [backupDir, purpose, callFolder(context), `${sha256(path).slice(0, 16)}-${baseName(path)}`].join(separator);
}

async function makeParent(params: { deps: FsDeps; path: string }): Promise<void> {
  const { deps: { access }, path } = params;
  const separator = access.platform === 'win32' ? '\\' : '/';
  await access.mkdir(path.slice(0, path.lastIndexOf(separator)), { recursive: true });
}

/**
 * Copies the current content of `path` to a backup; undefined without `backupDir`. The first backup of a path in a
 * call keeps the content from before the call (what `verify` compares against); a later item on the same path gets
 * its own numbered backup, so undoing in reverse order restores each step.
 */
export async function backUp(params: { deps: FsDeps; context: ToolContext; path: string }): Promise<string | undefined> {
  const { deps, context, path } = params;
  const first = backupPathFor({ deps, context, path, purpose: 'backup' });
  if (first == null) return undefined;
  await makeParent({ deps, path: first });
  let backup = first;
  for (let copy = 2; await exists({ deps, path: backup }); copy += 1) backup = `${first}.${copy}`;
  await deps.access.copyFile(path, backup);
  return backup;
}

/** Moves `path` into the managed trash; undefined without `backupDir`. */
export async function moveToTrash(params: { deps: FsDeps; context: ToolContext; path: string }): Promise<string | undefined> {
  const { deps, context, path } = params;
  const trash = backupPathFor({ deps, context, path, purpose: 'trash' });
  if (trash == null) return undefined;
  await makeParent({ deps, path: trash });
  await deps.access.rename(path, trash);
  return trash;
}

async function hashAt(params: { deps: FsDeps; path: string }): Promise<string | undefined> {
  const { deps: { access }, path } = params;
  return access.readFile(path).then(sha256, () => undefined);
}

/** Whether something is at `path`; any error but "not there" is thrown (never taken as "exists", which could loop). */
async function exists(params: { deps: FsDeps; path: string }): Promise<boolean> {
  try {
    await params.deps.access.lstat(params.path);
    return true;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Reverses one step; a failure says why (changed since, path taken, no backup). */
async function applyStep(params: { deps: FsDeps; step: UndoStep }): Promise<string | undefined> {
  const { deps, step } = params;
  const { access } = deps;
  switch (step.kind) {
    case 'not-undoable': return `'${step.path}' cannot be restored: ${step.reason}`;
    case 'remove-created':
      if (await hashAt({ deps, path: step.path }) !== step.hash) return `'${step.path}' changed after it was written, so it was left alone`;
      await access.rm(step.path);
      return undefined;
    case 'restore-backup':
      if (await hashAt({ deps, path: step.path }) !== step.hash) return `'${step.path}' changed after it was written, so it was left alone`;
      await access.copyFile(step.backup, step.path);
      return undefined;
    case 'move-back':
      if (await exists({ deps, path: step.to })) return `'${step.to}' exists again, so '${step.from}' was not moved back`;
      await access.rename(step.from, step.to);
      return undefined;
  }
}

/** Applies a call's steps newest first; every step is tried, and the outcome lists the ones that could not be undone. */
export async function applyUndoSteps(params: { deps: FsDeps; descriptor: UndoDescriptor }): Promise<UndoOutcome> {
  const { deps, descriptor } = params;
  const steps = Array.isArray(descriptor.steps) ? descriptor.steps as UndoStep[] : [];
  const problems: string[] = [];
  for (const step of [...steps].reverse()) {
    const problem = await applyStep({ deps, step }).catch((error: unknown) => `undoing a step on '${'path' in step ? step.path : step.from}' failed: ${error instanceof Error ? error.message : String(error)}`);
    if (problem != null) problems.push(problem);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, message: `${steps.length - problems.length} of ${steps.length} changes undone; ${problems.join('; ')}` };
}
