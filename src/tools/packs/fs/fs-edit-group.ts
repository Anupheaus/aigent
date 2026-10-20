import type { DryRunOutput, PlannedEffectInput } from '../../../effects/planned-effects.js';
import type { BatchEntry } from '../../batch-entries.js';
import { describeThrown } from '../../tool-error-detail.js';
import { toolFailure } from '../../tool-failure.js';
import type { ToolContext } from '../../tool-types.js';
import { writeAtomically } from './fs-atomic.js';
import { applyEdits } from './fs-edit-apply.js';
import type { TextEdit } from './fs-edit-apply.js';
import { allowPath, onDisk } from './fs-shared.js';
import type { FsDeps } from './fs-shared.js';
import { sha256 } from './fs-text.js';
import { decodeExactly, encodeEdited } from './fs-text-codec.js';
import type { DecodedText, EditableText } from './fs-text-codec.js';
import { backUp, backupPathFor, withUndo } from './fs-undo.js';
import { readVerified, serialised } from './fs-verify.js';
import { changeSummary } from './fs-write.js';

export const FS_EDIT_TOOL_NAME = 'fs_edit';

/** One `fs_edit` item. */
export interface EditItem {
  path: string;
  edits: TextEdit[];
}

/** The items that edit one file (by canonical path), in call order. */
interface EditGroup {
  path: string;
  members: { index: number; item: EditItem }[];
}

/** Every member's edits applied in order to one document, or the first member that failed (then none apply). */
type GroupOutcome = { ok: true; doc: EditableText; replacements: number[] } | { ok: false; failedIndex: number; error: unknown };

/** Groups items by the canonical path they edit (first-seen order); an item the policy refuses fails on its own. */
async function groupItems(params: { deps: FsDeps; items: EditItem[]; isGated: boolean }): Promise<{ groups: EditGroup[]; refused: BatchEntry[] }> {
  const { deps, items, isGated } = params;
  const groups = new Map<string, EditGroup>();
  const refused: BatchEntry[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const { path } = await allowPath({ deps, path: item.path, permission: 'write', ...(isGated ? { gate: { kind: 'write', tool: FS_EDIT_TOOL_NAME } } : {}) });
      const group = groups.get(path) ?? { path, members: [] };
      group.members.push({ index, item });
      groups.set(path, group);
    } catch (error) {
      refused.push({ index, ok: false, error: describeThrown(error) });
    }
  }
  return { groups: [...groups.values()], refused };
}

function applyGroup(params: { group: EditGroup; decoded: DecodedText }): GroupOutcome {
  const { group: { path, members }, decoded } = params;
  let { doc } = decoded;
  const replacements: number[] = [];
  for (const { index, item } of members) {
    try {
      const applied = applyEdits({ doc, edits: item.edits, path, asCrlf: decoded.usesCrlf });
      doc = applied.doc;
      replacements.push(applied.replacements);
    } catch (error) {
      return { ok: false, failedIndex: index, error };
    }
  }
  return { ok: true, doc, replacements };
}

/** Entries for a group that failed: the failing item's own error, and `not_applied` for the others. */
function failedEntries(params: { group: EditGroup; failedIndex: number; error: unknown }): BatchEntry[] {
  const { group: { path, members }, failedIndex, error } = params;
  const detail = describeThrown(error);
  return members.map(({ index }): BatchEntry => (index === failedIndex ? { index, ok: false, error: detail } : {
    index, ok: false,
    error: describeThrown(toolFailure({ code: 'not_applied', message: `Not applied: item ${failedIndex + 1} edits the same file '${path}' and failed (${detail.code}); edits to one file apply together or not at all`, suggestion: 'Fix the failing item and send the edits for this file again', retryable: false })),
  }));
}

/** A file decoded for editing; a backup (outside the roots, never checked by the policy) is read plainly. */
async function readDecoded(params: { deps: FsDeps; path: string; isBackup?: boolean }): Promise<DecodedText & { bytes: Uint8Array }> {
  const { deps, path, isBackup = false } = params;
  const bytes = isBackup ? await deps.access.readFile(path) : await readVerified({ deps, path });
  return { ...decodeExactly({ bytes, path }), bytes };
}

/** Edits one file with every item for it, in memory, then writes it once (temp file and rename): all items or none. */
async function editGroup(params: { deps: FsDeps; group: EditGroup; context: ToolContext }): Promise<BatchEntry[]> {
  const { deps, group, context } = params;
  const { path, members } = group;
  try {
    return await onDisk({
      path,
      work: async () => {
        const decoded = await readDecoded({ deps, path });
        const applied = applyGroup({ group, decoded });
        if (!applied.ok) return failedEntries({ group, failedIndex: applied.failedIndex, error: applied.error });
        const data = encodeEdited({ decoded, doc: applied.doc });
        await allowPath({ deps, path, permission: 'write', bytes: data.length });
        const backup = await backUp({ deps, context, path });
        await writeAtomically({ deps, path, data });
        // One backup covers the whole group, so its undo step rides on the first item.
        const steps = [backup == null ? { kind: 'not-undoable' as const, path, reason: 'no backupDir was configured, so no backup of its prior content was kept' } : { kind: 'restore-backup' as const, path, backup, hash: sha256(data) }];
        return members.map(({ index }, position): BatchEntry => {
          const result = { path, replacements: applied.replacements[position] ?? 0, bytes: data.length };
          return { index, ok: true, result: position === 0 ? withUndo({ result, steps }) : result };
        });
      },
    });
  } catch (error) {
    return members.map(({ index }): BatchEntry => ({ index, ok: false, error: describeThrown(error) }));
  }
}

const byIndex = (first: BatchEntry, second: BatchEntry): number => first.index - second.index;

/** `fs_edit`'s run: items grouped by file, each file edited once, one file at a time. */
export async function runEdits(params: { deps: FsDeps; items: EditItem[]; context: ToolContext }): Promise<BatchEntry[]> {
  const { deps, items, context } = params;
  const { groups, refused } = await groupItems({ deps, items, isGated: true });
  const entries = [...refused];
  for (const group of groups) entries.push(...await serialised({ deps, work: () => editGroup({ deps, group, context }) }));
  return entries.sort(byIndex);
}

/** `fs_edit`'s dry run: one planned edit per file, later items applied on top of earlier ones. */
export async function planEdits(params: { deps: FsDeps; items: EditItem[] }): Promise<DryRunOutput> {
  const { deps, items } = params;
  const { groups, refused } = await groupItems({ deps, items, isGated: false });
  const entries = [...refused];
  const effects: PlannedEffectInput[] = [];
  for (const group of groups) {
    try {
      const decoded = await onDisk({ path: group.path, work: () => readDecoded({ deps, path: group.path }) });
      const applied = applyGroup({ group, decoded });
      if (!applied.ok) { entries.push(...failedEntries({ group, failedIndex: applied.failedIndex, error: applied.error })); continue; }
      entries.push(...group.members.map(({ index }): BatchEntry => ({ index, ok: true, result: { path: group.path } })));
      effects.push({ kind: 'file.edit', target: group.path, summary: `edit ${group.path} (${changeSummary({ before: decoded.doc.text, after: applied.doc.text })})`, before: decoded.doc.text, after: applied.doc.text, reversible: deps.backupDir != null });
    } catch (error) {
      entries.push(...group.members.map(({ index }): BatchEntry => ({ index, ok: false, error: describeThrown(error) })));
    }
  }
  return { result: entries.sort(byIndex), effects };
}

/** Done when each file equals its backup (its content before this call) with all of its items' edits applied. */
export async function verifyEdits(params: { deps: FsDeps; items: EditItem[]; context: ToolContext }): Promise<{ done: boolean }> {
  const { deps, items, context } = params;
  const { groups, refused } = await groupItems({ deps, items, isGated: false });
  if (refused.length > 0) return { done: false };
  for (const group of groups) {
    const backup = backupPathFor({ deps, context, path: group.path, purpose: 'backup' });
    if (backup == null) return { done: false };
    const [before, now] = await Promise.all([readDecoded({ deps, path: backup, isBackup: true }), readDecoded({ deps, path: group.path })].map(read => read.catch(() => undefined)));
    if (before == null || now == null) return { done: false };
    const applied = applyGroup({ group, decoded: before });
    // The edits no longer apply to the backup, or give other bytes: not this call's result.
    if (!applied.ok || Buffer.compare(Buffer.from(encodeEdited({ decoded: before, doc: applied.doc })), Buffer.from(now.bytes)) !== 0) return { done: false };
  }
  return { done: true };
}
