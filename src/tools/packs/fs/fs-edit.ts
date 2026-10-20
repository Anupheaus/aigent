import { z } from 'zod';
import { defineTool } from '../../define-tool.js';
import type { Tool } from '../../tool-types.js';
import { FS_EDIT_TOOL_NAME, planEdits, runEdits, verifyEdits } from './fs-edit-group.js';
import type { EditItem } from './fs-edit-group.js';
import { countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, needsApproval } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { applyUndoSteps, undoDescriptor } from './fs-undo.js';

export { FS_EDIT_TOOL_NAME } from './fs-edit-group.js';
const MAX_EDITS = 50;

const editItem = z.object({
  path: z.string().min(1).describe('File path: absolute, or relative to the workspace root'),
  edits: z.array(z.object({
    oldText: z.string().describe('Exact text to replace, as fs_read showed it (LF line endings); must occur once unless replaceAll'),
    newText: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence (default false)'),
  }).strict()).min(1).max(MAX_EDITS).describe('Applied in order, all or none'),
}).strict();

/** The whole call is one unit (not item by item through `defineBatchTool`), so items for one file can be grouped. */
const editArgs = z.object({ items: z.array(editItem).min(1).max(MAX_FS_ITEMS) }).strict();

const itemsOf = (args: unknown): EditItem[] => (args as { items: EditItem[] }).items;

/**
 * `fs_edit`: exact-text edits, fail-closed on absent or ambiguous text. Items are grouped by the file they edit: all
 * items for one file apply together or not at all, and the file is written once. Bytes outside the edits are kept
 * exactly (encoding, BOM, CRLF, lone CRs); files that would not round-trip are refused.
 */
export function createFsEdit(deps: FsDeps): Tool {
  const tool = defineTool({
    name: FS_EDIT_TOOL_NAME,
    description: 'Edit text files by exact replacement. Each oldText must appear exactly once (or use replaceAll); if any edit for a file cannot apply, that file is left unchanged (items for the same file apply together). Encoding, BOM and line endings are kept.',
    args: editArgs, deterministic: false, cache: false, hasSideEffects: true,
    contentKind: 'structured-data', risk: 'medium', resume: 'verify',
    requiresApproval: (args: unknown) => needsApproval({ deps, kind: 'write', paths: itemsOf(args).map(({ path }) => ({ path, permission: 'write' })), tool: FS_EDIT_TOOL_NAME }),
    describeActivity: ({ items }, outcome) => {
      const title = countTitle({ verb: 'Editing', noun: 'files', paths: items.map(({ path }) => path) });
      return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
    },
    run: ({ items }, context) => runEdits({ deps, items, context }),
    dryRun: ({ items }) => planEdits({ deps, items }),
    verify: ({ items }, context) => verifyEdits({ deps, items, context }),
    undo: async (_args, result) => undoDescriptor(result),
    applyUndo: async descriptor => applyUndoSteps({ deps, descriptor }),
  });
  return { ...tool, ...FS_RESULT_HELPERS };
}
