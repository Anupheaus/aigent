import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import { toolFailure } from '../../tool-failure.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { writeAtomically } from './fs-atomic.js';
import { applyEdits } from './fs-edit-apply.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, needsApproval, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { BINARY_SAMPLE_BYTES, decoderFor, denormaliseText, encodeUtf8, encodingOf, isBinary, normaliseText, sha256 } from './fs-text.js';
import { applyUndoSteps, backUp, backupPathFor, undoDescriptor, withUndo } from './fs-undo.js';
import { changeSummary } from './fs-write.js';

export const FS_EDIT_TOOL_NAME = 'fs_edit';
const MAX_EDITS = 50;

const editItem = z.object({
  path: z.string().min(1).describe('File path: absolute, or relative to the workspace root'),
  edits: z.array(z.object({
    oldText: z.string().describe('Exact text to replace, as fs_read showed it (LF line endings); must occur once unless replaceAll'),
    newText: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence (default false)'),
  }).strict()).min(1).max(MAX_EDITS).describe('Applied in order, all or none'),
}).strict();

type EditItem = z.infer<typeof editItem>;

/** The file as fs_read shows it (BOM dropped, LF), and how to write it back the same way. */
async function readEditable(params: { deps: FsDeps; path: string }) {
  const { deps: { access }, path } = params;
  const bytes = await access.readFile(path);
  if (isBinary(bytes.subarray(0, BINARY_SAMPLE_BYTES))) throw toolFailure({ code: 'binary_file', message: `'${path}' is a binary file; fs_edit only edits text`, suggestion: 'Use fs_write to replace it whole, if that is really intended' });
  const { encoding } = encodingOf(bytes);
  return { ...normaliseText(decoderFor(encoding).decode(bytes)), bytes };
}

/** Applies one item's edits in memory, then writes the file at once (temp file and rename): all edits or none. */
async function editOne(params: { deps: FsDeps; item: EditItem; context: ToolContext }): Promise<unknown> {
  const { deps, item: { path, edits }, context } = params;
  const allowed = await allowPath({ deps, path, permission: 'write' });
  return onDisk({
    path,
    work: async () => {
      const current = await readEditable({ deps, path: allowed.path });
      const { text, replacements } = applyEdits({ text: current.text, edits, path: allowed.path });
      const data = encodeUtf8(denormaliseText({ text, hasBom: current.hasBom, eol: current.eol }));
      await allowPath({ deps, path: allowed.path, permission: 'write', bytes: data.length });
      const backup = await backUp({ deps, context, path: allowed.path });
      await writeAtomically({ deps, path: allowed.path, data });
      const hash = sha256(data);
      return withUndo({
        result: { path: allowed.path, replacements, bytes: data.length },
        steps: [backup == null ? { kind: 'not-undoable', path: allowed.path, reason: 'no backupDir was configured, so no backup of its prior content was kept' } : { kind: 'restore-backup', path: allowed.path, backup, hash }],
      });
    },
  });
}

/** `fs_edit`: exact-text edits, all-or-nothing per file and fail-closed on absent or ambiguous text. */
export function createFsEdit(deps: FsDeps): Tool {
  const { access, policy } = deps;
  return {
    ...defineBatchTool({
      name: FS_EDIT_TOOL_NAME,
      description: 'Edit text files by exact replacement. Each oldText must appear exactly once (or use replaceAll); if any edit for a file cannot apply, that file is left unchanged. Line endings and BOM are kept.',
      item: editItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, hasSideEffects: true, sequential: true,
      contentKind: 'structured-data', risk: 'medium', resume: 'verify',
      requiresApproval: (args: unknown) => needsApproval({ deps, kind: 'write', paths: (args as { items: EditItem[] }).items.map(({ path }) => ({ path, permission: 'write' })), tool: FS_EDIT_TOOL_NAME }),
      describeActivity: ({ items }, outcome) => {
        const title = countTitle({ verb: 'Editing', noun: 'files', paths: items.map(({ path }) => path) });
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: (item, context) => editOne({ deps, item, context }),
      dryRunItem: async ({ path, edits }) => {
        const allowed = await allowPath({ deps, path, permission: 'write' });
        const current = await onDisk({ path, work: () => readEditable({ deps, path: allowed.path }) });
        const { text } = applyEdits({ text: current.text, edits, path: allowed.path });
        return [{ kind: 'file.edit', target: allowed.path, summary: `edit ${allowed.path} (${changeSummary({ before: current.text, after: text })})`, before: current.text, after: text, reversible: deps.backupDir != null }];
      },
      // Done when the file equals its backup (its content before this call) with the edits applied.
      verify: async ({ items }, context) => {
        const states = await Promise.all(items.map(async ({ path, edits }) => {
          const decision = await policy.check({ path, permission: 'read', access });
          const backup = decision.allowed ? backupPathFor({ deps, context, path: decision.canonicalPath, purpose: 'backup' }) : undefined;
          if (!decision.allowed || backup == null) return false;
          const [before, now] = await Promise.all([readEditable({ deps, path: backup }), readEditable({ deps, path: decision.canonicalPath })].map(read => read.catch(() => undefined)));
          if (before == null || now == null) return false;
          try {
            return applyEdits({ text: before.text, edits, path }).text === now.text;
          } catch {
            // The edits no longer apply to the backup: not this call's result.
            return false;
          }
        }));
        return { done: states.every(Boolean) };
      },
      undo: async (_args, result) => undoDescriptor(result),
      applyUndo: async descriptor => applyUndoSteps({ deps, descriptor }),
    }),
    ...FS_RESULT_HELPERS,
  };
}
