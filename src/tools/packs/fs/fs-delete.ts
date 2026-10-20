import { z } from 'zod';
import { fsError } from '../../../security/fs-access.js';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { pathExists } from './fs-atomic.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, needsApproval, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { assertSubtreeUnprotected } from './fs-subtree.js';
import { applyUndoSteps, moveToTrash, undoDescriptor, withUndo } from './fs-undo.js';

export const FS_DELETE_TOOL_NAME = 'fs_delete';

const deleteItem = z.object({
  path: z.string().min(1).describe('File or directory to delete: absolute, or relative to the workspace root'),
  recursive: z.boolean().optional().describe('Required to delete a directory with everything in it (default false)'),
}).strict();

type DeleteItem = z.infer<typeof deleteItem>;

async function deleteOne(params: { deps: FsDeps; item: DeleteItem; context: ToolContext }): Promise<unknown> {
  const { deps, item: { path, recursive = false }, context } = params;
  const { access } = deps;
  // A link is deleted itself, never its target: the final segment is not followed.
  const allowed = await allowPath({ deps, path, permission: 'delete', followFinalLink: false, gate: { kind: 'delete', tool: FS_DELETE_TOOL_NAME } });
  if (allowed.path === allowed.root) throw toolFailure({ category: 'denied', code: 'root_protected', message: `'${path}' is an allowed root and cannot be deleted`, suggestion: 'Delete the entries inside it instead' });
  return onDisk({
    path,
    work: async () => {
      const { type } = await access.lstat(allowed.path);
      if (type === 'directory' && !recursive) throw fsError({ code: 'EISDIR', path: allowed.path, message: 'is a directory (pass recursive: true)' });
      if (type !== 'symlink') await assertSubtreeUnprotected({ deps, path: allowed.path, root: allowed.root });
      // With a backupDir the delete is a move into the managed trash, so it can be undone.
      const trashed = await moveToTrash({ deps, context, path: allowed.path });
      if (trashed == null) await access.rm(allowed.path, { recursive: type === 'directory' });
      return withUndo({
        result: { path: allowed.path, type, recoverable: trashed != null },
        steps: [trashed == null ? { kind: 'not-undoable', path: allowed.path, reason: 'it was deleted for good: no backupDir (trash) was configured' } : { kind: 'move-back', from: trashed, to: allowed.path }],
      });
    },
  });
}

/** `fs_delete`: deletes files and directories (into the managed trash when there is one); needs approval by default. */
export function createFsDelete(deps: FsDeps): Tool {
  const { access, policy } = deps;
  return {
    ...defineBatchTool({
      name: FS_DELETE_TOOL_NAME,
      description: 'Delete files, or directories with recursive: true. Allowed roots themselves cannot be deleted.',
      item: deleteItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, hasSideEffects: true, sequential: true,
      contentKind: 'structured-data', risk: 'high', resume: 'verify',
      requiresApproval: (args: unknown) => needsApproval({ deps, kind: 'delete', paths: (args as { items: DeleteItem[] }).items.map(({ path }) => ({ path, permission: 'delete' })), tool: FS_DELETE_TOOL_NAME }),
      describeActivity: ({ items }, outcome) => {
        const title = countTitle({ verb: 'Deleting', noun: 'paths', paths: items.map(({ path }) => path) });
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: (item, context) => deleteOne({ deps, item, context }),
      dryRunItem: async ({ path, recursive = false }) => {
        const allowed = await allowPath({ deps, path, permission: 'delete', followFinalLink: false });
        const stat = await access.lstat(allowed.path).catch(() => undefined);
        if (stat == null) return { result: { path: allowed.path, wouldFail: 'not_found' }, effects: [] };
        if (stat.type === 'directory' && !recursive) return { result: { path: allowed.path, wouldFail: 'is_a_directory' }, effects: [] };
        if (stat.type !== 'symlink') await assertSubtreeUnprotected({ deps, path: allowed.path, root: allowed.root });
        return [{ kind: 'file.delete', target: allowed.path, summary: `delete ${stat.type} ${allowed.path}${deps.backupDir == null ? ' for good' : ' (into the trash)'}`, reversible: deps.backupDir != null }];
      },
      // Done when every path is gone.
      verify: async ({ items }) => {
        const gone = await Promise.all(items.map(async ({ path }) => {
          const canonical = await policy.canonicalise({ path, access, followFinalLink: false });
          return canonical.ok && !await pathExists({ deps, path: canonical.path });
        }));
        return { done: gone.every(Boolean) };
      },
      undo: async (_args, result) => undoDescriptor(result),
      applyUndo: async descriptor => applyUndoSteps({ deps, descriptor }),
    }),
    ...FS_RESULT_HELPERS,
  };
}
