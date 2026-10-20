import { z } from 'zod';
import { defineBatchTool } from '../../define-batch-tool.js';
import type { Tool, ToolContext } from '../../tool-types.js';
import { diffLines, diffStats, splitLines } from '../diff.js';
import { createExclusively, parentOf, pathExists, writeAtomically } from './fs-atomic.js';
import { allowPath, countTitle, FS_RESULT_HELPERS, MAX_FS_ITEMS, needsApproval, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { encodeUtf8, sha256 } from './fs-text.js';
import { applyUndoSteps, backUp, undoDescriptor, withUndo } from './fs-undo.js';
import { serialised } from './fs-verify.js';
import type { UndoStep } from './fs-undo.js';

export const FS_WRITE_TOOL_NAME = 'fs_write';

const writeItem = z.object({
  path: z.string().min(1).describe('File path: absolute, or relative to the workspace root'),
  content: z.string().describe('The whole new content (UTF-8)'),
  overwrite: z.boolean().optional().describe('Replace an existing file (default false: refuse)'),
  createDirs: z.boolean().optional().describe('Create missing parent directories (default false)'),
}).strict();

type WriteItem = z.infer<typeof writeItem>;

/** `+a -r lines` between two texts, for summaries. */
export function changeSummary(params: { before: string; after: string }): string {
  const { added, removed } = diffStats(diffLines({ a: splitLines(params.before), b: splitLines(params.after) }));
  return `+${added} -${removed} lines`;
}

async function writeOne(params: { deps: FsDeps; item: WriteItem; context: ToolContext }): Promise<unknown> {
  const { deps, item: { path, content, overwrite = false, createDirs = false }, context } = params;
  const { access } = deps;
  const data = encodeUtf8(content);
  const allowed = await allowPath({ deps, path, permission: 'write', bytes: data.length, gate: { kind: 'write', tool: FS_WRITE_TOOL_NAME } });
  return onDisk({
    path,
    work: async () => {
      if (createDirs) await access.mkdir(parentOf({ path: allowed.path, platform: access.platform }), { recursive: true });
      const hash = sha256(data);
      if (!overwrite) {
        // An exclusive create: refused atomically when the file exists, never a check-then-write race.
        await createExclusively({ deps, path: allowed.path, data });
        return withUndo({ result: { path: allowed.path, bytes: data.length, created: true }, steps: [{ kind: 'remove-created', path: allowed.path, hash }] });
      }
      const existed = await pathExists({ deps, path: allowed.path });
      const backup = existed ? await backUp({ deps, context, path: allowed.path }) : undefined;
      await writeAtomically({ deps, path: allowed.path, data });
      const step: UndoStep = !existed ? { kind: 'remove-created', path: allowed.path, hash }
        : backup == null ? { kind: 'not-undoable', path: allowed.path, reason: 'no backupDir was configured, so no backup of its prior content was kept' }
          : { kind: 'restore-backup', path: allowed.path, backup, hash };
      return withUndo({ result: { path: allowed.path, bytes: data.length, created: !existed }, steps: [step] });
    },
  });
}

/** `fs_write`: whole-file writes, atomic, refusing to overwrite unless asked; dry run, undo (with backups) and verify. */
export function createFsWrite(deps: FsDeps): Tool {
  const { access } = deps;
  return {
    ...defineBatchTool({
      name: FS_WRITE_TOOL_NAME,
      description: 'Write whole files (UTF-8). Refuses to replace an existing file unless overwrite: true; use fs_edit to change part of a file.',
      item: writeItem, maxItems: MAX_FS_ITEMS, deterministic: false, cache: false, hasSideEffects: true, sequential: true,
      contentKind: 'structured-data', risk: 'medium', resume: 'verify',
      requiresApproval: (args: unknown) => needsApproval({ deps, kind: 'write', paths: (args as { items: WriteItem[] }).items.map(({ path }) => ({ path, permission: 'write' })), tool: FS_WRITE_TOOL_NAME }),
      describeActivity: ({ items }, outcome) => {
        const title = countTitle({ verb: 'Writing', noun: 'files', paths: items.map(({ path }) => path) });
        return outcome.then(({ success, reason }) => ({ title, ...(success ? {} : { detail: reason }) }), () => ({ title }));
      },
      runItem: (item, context) => serialised({ deps, work: () => writeOne({ deps, item, context }) }),
      dryRunItem: async ({ path, content, overwrite = false }) => {
        const allowed = await allowPath({ deps, path, permission: 'write', bytes: encodeUtf8(content).length });
        const before = await access.readFile(allowed.path).then(bytes => new TextDecoder().decode(bytes), () => undefined);
        if (before != null && !overwrite) return { result: { path: allowed.path, wouldFail: 'already_exists' }, effects: [] };
        return [{
          kind: before == null ? 'file.create' : 'file.write', target: allowed.path,
          summary: `${before == null ? 'create' : 'replace'} ${allowed.path} (${changeSummary({ before: before ?? '', after: content })})`,
          ...(before == null ? {} : { before }), after: content, reversible: before == null || deps.backupDir != null,
        }];
      },
      verify: async ({ items }) => {
        const hashes = await Promise.all(items.map(async ({ path, content }) => {
          const decision = await deps.policy.check({ path, permission: 'read', access });
          return decision.allowed && await access.readFile(decision.canonicalPath).then(sha256, () => undefined) === sha256(encodeUtf8(content));
        }));
        // The same shape as a run's result: one batch entry per item.
        return { done: hashes.every(Boolean), result: items.map(({ path }, index) => ({ index, ok: true, result: { path, verified: true } })) };
      },
      undo: async (_args, result) => undoDescriptor(result),
      applyUndo: async descriptor => applyUndoSteps({ deps, descriptor }),
    }),
    ...FS_RESULT_HELPERS,
  };
}
