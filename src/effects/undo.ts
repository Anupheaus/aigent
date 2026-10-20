import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { Clock } from '../core/runtime-services.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { EffectLog } from './effect-log.js';
import { hashDescriptor } from './descriptor-hash.js';
import type { EffectLogEntry, UndoOutcome, UndoReport, UndoResult, UndoTarget } from './undo-types.js';

export interface UndoEffectsParams {
  log: EffectLog;
  /** The agent's tools, whose `applyUndo` reverses their effects. */
  registry: ToolRegistry;
  agent: { name: string; instanceId: string };
  target: UndoTarget;
  clock: Clock;
  /** Serialises undos of one agent, so two concurrent undos never apply one effect twice. */
  writeQueue: WriteQueue;
}

/** Whether the entry is one the target names: a run (and call) exactly, else a call or time within the scope. */
function matches(params: { entry: EffectLogEntry; target: UndoTarget; instanceId: string }): boolean {
  const { entry, target, instanceId } = params;
  if ('runId' in target) return entry.runId === target.runId && (target.callId == null || entry.callId === target.callId);
  if (target.scope !== 'agent' && entry.instanceId !== instanceId) return false;
  return 'callId' in target ? entry.callId === target.callId : entry.at >= target.since;
}

/** A bare call id that names calls of several runs is refused: undoing all of them would reverse unrelated work. */
function assertOneRun(params: { entries: EffectLogEntry[]; target: UndoTarget }): void {
  const { entries, target } = params;
  if (!('callId' in target) || 'runId' in target) return;
  const runIds = [...new Set(entries.map(({ runId }) => runId))];
  if (runIds.length <= 1) return;
  throw createAigentError({ code: 'invalid_input', message: `Call id '${target.callId}' names calls of more than one run (${runIds.join(', ')}); pass { runId, callId } to say which`, details: { callId: target.callId, runs: runIds.length } });
}

/** Newest first: later time, then later append. */
function newestFirst(left: EffectLogEntry, right: EffectLogEntry): number {
  return right.at - left.at || right.sequence - left.sequence;
}

/** Runs `applyUndo` within the tool's timeout; a throw, a timeout or a malformed outcome is a failure. */
async function applyWithin(params: { apply(signal: AbortSignal): Promise<UndoOutcome>; timeoutMs: number }): Promise<UndoOutcome> {
  const { apply, timeoutMs } = params;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UndoOutcome>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ ok: false, message: `applyUndo took longer than ${timeoutMs} ms` }); }, timeoutMs);
  });
  const applied = apply(controller.signal).then(
    outcome => (typeof outcome?.ok === 'boolean' ? outcome : { ok: false, message: 'applyUndo returned no { ok } outcome' }),
    (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  return Promise.race([applied, timeout]).finally(() => clearTimeout(timer));
}

async function undoOne(params: UndoEffectsParams & { entry: EffectLogEntry }): Promise<UndoResult> {
  const { entry, registry, agent, clock, log } = params;
  const { effectId, callId, tool: toolName, status, descriptor, expiresAt, runId } = entry;
  const base = { effectId, callId, tool: toolName };
  if (status === 'undone') return { ...base, status: 'already_undone' };
  if (descriptor == null) return { ...base, status: 'unavailable', message: entry.message ?? `Tool '${toolName}' recorded no undo data, so this effect cannot be undone` };
  if (expiresAt != null && clock.now() > expiresAt) return { ...base, status: 'expired' };
  if (entry.descriptorHash != null && hashDescriptor(descriptor) !== entry.descriptorHash) {
    return { ...base, status: 'unavailable', message: `The undo data of call '${callId}' (${toolName}) was changed before it was stored (by redact), so applying it could write the changed content back; it was not applied` };
  }
  const tool = registry.get(toolName);
  const { applyUndo } = tool ?? {};
  if (tool == null || applyUndo == null) return { ...base, status: 'unavailable', message: `Tool '${toolName}' is not available to agent '${agent.name}' with applyUndo, so this effect cannot be undone` };
  const outcome = await applyWithin({ apply: signal => applyUndo(descriptor, { agentName: agent.name, instanceId: agent.instanceId, runId, callId, effectId, signal }), timeoutMs: tool.timeoutMs });
  let unrecorded: string | undefined;
  try {
    await log.recordUndo({ effect: entry, ok: outcome.ok, ...(outcome.message == null ? {} : { message: outcome.message }) });
  } catch (error) {
    // The undo happened (or failed) either way: the result says so, and the rest still run.
    unrecorded = `the undo was not recorded in the effect log: ${error instanceof Error ? error.message : String(error)}`;
  }
  const messages = [outcome.message ?? (outcome.ok ? undefined : 'applyUndo reported a failure'), unrecorded].filter((text): text is string => text != null);
  return { ...base, status: outcome.ok ? 'undone' : 'failed', ...(messages.length === 0 ? {} : { message: messages.join('; ') }) };
}

/**
 * Reverses the matching recorded effects newest first through their tools' `applyUndo`, one result per effect. A
 * failure never stops the rest; an effect undone before is `already_undone`; one past its retention is `expired`.
 */
export async function undoEffects(params: UndoEffectsParams): Promise<UndoReport> {
  const { log, agent, target, writeQueue } = params;
  return writeQueue.enqueue(`undo:${agent.name}`, async () => {
    const entries = (await log.effects(agent.name)).filter(entry => matches({ entry, target, instanceId: agent.instanceId })).sort(newestFirst);
    assertOneRun({ entries, target });
    const results: UndoResult[] = [];
    // One at a time, newest first: a later effect may depend on an earlier one still being in place.
    for (const entry of entries) results.push(await undoOne({ ...params, entry }));
    return { results };
  });
}

const scopeSchema = z.enum(['instance', 'agent']).optional();
const undoTargetSchema = z.union([
  z.object({ runId: z.string().min(1), callId: z.string().min(1).optional() }).strict(),
  z.object({ callId: z.string().min(1), scope: scopeSchema }).strict(),
  z.object({ since: z.number().finite(), scope: scopeSchema }).strict(),
]);

/** Validates `agent.undo(target)`; throws `invalid_input`. */
export function parseUndoTarget(target: unknown): UndoTarget {
  const parsed = undoTargetSchema.safeParse(target);
  if (parsed.success) return parsed.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid undo target (expected { runId, callId? }, { callId, scope? } or { since: epochMs, scope? }): ${describeIssues(parsed.error)}`, details: { issues: parsed.error.issues.length } });
}
