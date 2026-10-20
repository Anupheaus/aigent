import { z } from 'zod';
import { fsError } from '../../../security/fs-access.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { parentOf, pathExists } from './fs-atomic.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, needsApproval, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { assertSubtreeUnprotected } from './fs-subtree.js';
import { assertResolvesTo, serialised } from './fs-verify.js';
import { applyUndoSteps, moveToTrash, undoDescriptor, withUndo } from './fs-undo.js';
import type { UndoStep } from './fs-undo.js';

export const FS_MOVE_TOOL_NAME = 'fs_move';

const moveItem = z.object({
  from: z.string().min(1).describe('File or directory to move: absolute, or relative to the workspace root'),
  to: z.string().min(1).describe('New path (its parent directory must exist)'),
  overwrite: z.boolean().optional().describe('Replace an existing file at `to` (default false: refuse)'),
}).strict();

type MoveItem = z.infer<typeof moveItem>;

async function moveOne(params: { deps: FsDeps; item: MoveItem; context: ToolContext }): Promise<unknown> {
  const { deps, item: { from, to, overwrite = false }, context } = params;
  const { access } = deps;
  // Moving takes the source away (delete) and creates the target (write).
  // A link is moved itself (rename never follows it), so both ends are checked without following a final link.
  const gate = { kind: 'write', tool: FS_MOVE_TOOL_NAME } as const;
  const source = await allowPath({ deps, path: from, permission: 'delete', followFinalLink: false, gate });
  const target = await allowPath({ deps, path: to, permission: 'write', followFinalLink: false, gate });
  return onDisk({
    path: from,
    work: async () => {
      if (source.path === source.root) throw fsError({ code: 'EPERM', path: source.path, message: 'is a root and cannot be moved' });
      const { type } = await access.lstat(source.path);
      if (type !== 'symlink') await assertSubtreeUnprotected({ deps, path: source.path, root: source.root, destination: { path: target.path, root: target.root } });
      await access.stat(parentOf({ path: target.path, platform: access.platform }));
      const steps: UndoStep[] = [];
      if (await pathExists({ deps, path: target.path })) {
        if (!overwrite) throw fsError({ code: 'EEXIST', path: target.path, message: 'already exists' });
        if ((await access.stat(target.path)).type === 'directory') throw fsError({ code: 'EISDIR', path: target.path, message: 'is a directory and cannot be replaced' });
        // The replaced file goes to the trash (when there is one), so undo can bring it back.
        const trashed = await moveToTrash({ deps, context, path: target.path });
        steps.push(trashed == null ? { kind: 'not-undoable', path: target.path, reason: 'it was replaced and no backupDir was configured' } : { kind: 'move-back', from: trashed, to: target.path });
      }
      // Right before acting: both parents must still be the checked ones (not swapped for links since the check).
      await assertResolvesTo({ deps, path: parentOf({ path: source.path, platform: access.platform }) });
      await assertResolvesTo({ deps, path: parentOf({ path: target.path, platform: access.platform }) });
      await access.rename(source.path, target.path);
      steps.push({ kind: 'move-back', from: target.path, to: source.path });
      return withUndo({ result: { from: source.path, to: target.path, replaced: steps.length > 1 }, steps });
    },
  });
}

/** `fs_move`: moves (or renames) files and directories inside the roots; dry run, undo and verify. */
export function createFsMove(deps: FsDeps): Tool {
  const { access, policy } = deps;
  return {
    ...defineBatchTool({
      name: FS_MOVE_TOOL_NAME,
      description: 'Move or rename files and directories. Refuses to replace an existing file unless overwrite: true.',
      item: moveItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, hasSideEffects: true, sequential: true,
      contentKind: 'structured-data', risk: 'medium', resume: 'verify',
      requiresApproval: (args: unknown) => needsApproval({ deps, kind: 'write', paths: (args as { items: MoveItem[] }).items.flatMap(({ from, to }) => [{ path: from, permission: 'delete' as const }, { path: to, permission: 'write' as const }]), tool: FS_MOVE_TOOL_NAME }),
      describeActivity: ({ items }, outcome) => {
        const title = countTitle({ verb: 'Moving', noun: 'paths', paths: items.map(({ from }) => from) });
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: (item, context) => serialised({ deps, work: () => moveOne({ deps, item, context }) }),
      dryRunItem: async ({ from, to, overwrite = false }) => {
        const source = await allowPath({ deps, path: from, permission: 'delete', followFinalLink: false });
        const target = await allowPath({ deps, path: to, permission: 'write', followFinalLink: false });
        // In a dry run the source may come from an earlier simulated call, so a missing one is not checked.
        const type = (await access.lstat(source.path).catch(() => undefined))?.type;
        if (type != null && type !== 'symlink') await assertSubtreeUnprotected({ deps, path: source.path, root: source.root, destination: { path: target.path, root: target.root } });
        const isReplacing = await pathExists({ deps, path: target.path });
        if (isReplacing && !overwrite) return { result: { from: source.path, to: target.path, wouldFail: 'already_exists' }, effects: [] };
        return [{ kind: 'file.move', target: source.path, summary: `move ${source.path} to ${target.path}${isReplacing ? ' (replacing it)' : ''}`, reversible: !isReplacing || deps.backupDir != null }];
      },
      // Done when the source is gone and the target is there.
      verify: async ({ items }) => {
        const states = await Promise.all(items.map(async ({ from, to }) => {
          const [source, target] = await Promise.all([policy.canonicalise({ path: from, access, followFinalLink: false }), policy.canonicalise({ path: to, access, followFinalLink: false })]);
          if (!source.ok || !target.ok) return false;
          return !await pathExists({ deps, path: source.path }) && await pathExists({ deps, path: target.path });
        }));
        return { done: states.every(Boolean) };
      },
      undo: async (_args, result) => undoDescriptor(result),
      applyUndo: async descriptor => applyUndoSteps({ deps, descriptor }),
    }),
    ...FS_RESULT_HELPERS,
  };
}
