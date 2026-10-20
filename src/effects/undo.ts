import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { Clock } from '../core/runtime-services.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { EffectLog } from './effect-log.js';
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

function matches(entry: EffectLogEntry, target: UndoTarget): boolean {
  if ('callId' in target) return entry.callId === target.callId;
  if ('runId' in target) return entry.runId === target.runId;
  return entry.at >= target.since;
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
  const tool = registry.get(toolName);
  const { applyUndo } = tool ?? {};
  if (tool == null || applyUndo == null) return { ...base, status: 'unavailable', message: `Tool '${toolName}' is not available to agent '${agent.name}' with applyUndo, so this effect cannot be undone` };
  const outcome = await applyWithin({ apply: signal => applyUndo(descriptor, { agentName: agent.name, instanceId: agent.instanceId, runId, callId, effectId, signal }), timeoutMs: tool.timeoutMs });
  await log.recordUndo({ effect: entry, ok: outcome.ok, ...(outcome.message == null ? {} : { message: outcome.message }) });
  return outcome.ok ? { ...base, status: 'undone' } : { ...base, status: 'failed', message: outcome.message ?? 'applyUndo reported a failure' };
}

/**
 * Reverses the matching recorded effects newest first through their tools' `applyUndo`, one result per effect. A
 * failure never stops the rest; an effect undone before is `already_undone`; one past its retention is `expired`.
 */
export async function undoEffects(params: UndoEffectsParams): Promise<UndoReport> {
  const { log, agent, target, writeQueue } = params;
  return writeQueue.enqueue(`undo:${agent.name}`, async () => {
    const entries = (await log.effects(agent.name)).filter(entry => matches(entry, target)).sort(newestFirst);
    const results: UndoResult[] = [];
    // One at a time, newest first: a later effect may depend on an earlier one still being in place.
    for (const entry of entries) results.push(await undoOne({ ...params, entry }));
    return { results };
  });
}

const undoTargetSchema = z.union([
  z.object({ callId: z.string().min(1) }).strict(),
  z.object({ runId: z.string().min(1) }).strict(),
  z.object({ since: z.number().finite() }).strict(),
]);

/** Validates `agent.undo(target)`; throws `invalid_input`. */
export function parseUndoTarget(target: unknown): UndoTarget {
  const parsed = undoTargetSchema.safeParse(target);
  if (parsed.success) return parsed.data;
  throw createAigentError({ code: 'invalid_input', message: `Invalid undo target (expected { callId }, { runId } or { since: epochMs }): ${describeIssues(parsed.error)}`, details: { issues: parsed.error.issues.length } });
}
