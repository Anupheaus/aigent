import { ASK_USER_TOOL_NAME } from '../core/ask-user-name.js';
import type { TaskInput } from '../core/task-input.js';
import type { RunPlanning } from '../planning/run-planning.js';
import { aliasTableFromJSON } from '../shapers/alias-table.js';
import type { RunShaping } from '../core/run-shaping.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { createRunCheckpoints } from './checkpoint-hooks.js';
import type { RunCheckpoints } from './checkpoint-hooks.js';
import { readCheckpointHead } from './checkpoint-reader.js';
import type { StoredTaskInput } from './checkpoint-types.js';
import type { InstanceRuntime } from './instance-runtime.js';
import type { RestoredRun } from './reconcile-calls.js';
import type { Clock } from '../core/runtime-services.js';

/** How a run continues an earlier one: the checkpoint stream it continues and how to load it. */
export interface RunRestore {
  /** The checkpoint stream and ledger id (the interrupted run's id). */
  streamId: string;
  /** The checkpoint and ledger: preloaded for a task resume, read on demand for a chat turn. */
  load(): Promise<RestoredRun>;
}

export interface PrepareRunResumeParams {
  runtime?: InstanceRuntime;
  agent: { name: string; instanceId: string; agentVersion: string };
  runId: string;
  input: TaskInput;
  registry: ToolRegistry;
  mode: 'task' | 'chat';
  clock: Clock;
  planning: RunPlanning;
  shaping?: RunShaping;
  restore?: RunRestore;
  sessionId?: string;
  messageId?: string;
  emit(event: { type: 'warning'; message: string }): void;
}

export interface PreparedRunResume {
  checkpoints?: RunCheckpoints;
  restored?: RestoredRun;
}

/** The input as a checkpoint keeps it: live values left out, and whether the run had a user to ask. */
export function storedInputOf(params: { input: TaskInput; registry: ToolRegistry }): StoredTaskInput {
  const { input: { signal: _signal, onQuestion: _onQuestion, ...rest }, registry } = params;
  return { ...rest, ...(registry.get(ASK_USER_TOOL_NAME) == null ? {} : { hasUser: true }) };
}

/**
 * Opens the run's instance (taking its lease; rejects `instance_locked`), loads what a resumed run continues from and
 * puts its plan, todo and alias table back. Without `resume` on the runtime, there is nothing to prepare.
 */
export async function prepareRunResume(params: PrepareRunResumeParams): Promise<PreparedRunResume> {
  const { runtime, agent, runId, input, registry, mode, clock, planning, shaping, restore, sessionId, messageId, emit } = params;
  if (runtime == null) return {};
  const instance = await runtime.open({ instanceId: agent.instanceId, agentName: agent.name, agentVersion: agent.agentVersion });
  for (const message of instance.takeWarnings()) emit({ type: 'warning', message });
  const restored = await restore?.load();
  if (restored?.stale != null) {
    const { missingSeq, latestSeq } = restored.stale;
    emit({ type: 'warning', message: `Resuming run '${restore?.streamId}' from an older checkpoint: records ${missingSeq} to ${latestSeq} are missing, so work done after it (including tool effects) is not in the resumed context; check for repeated effects` });
  }
  const streamId = restore?.streamId ?? runId;
  const head = restore == null ? undefined : await readCheckpointHead({ store: instance.store, instanceId: agent.instanceId, streamId });
  if (restored != null) {
    Object.assign(planning.state, structuredClone(restored.state.planning));
    if (shaping != null && restored.state.aliasTable != null) shaping.state.aliases = aliasTableFromJSON(restored.state.aliasTable);
  }
  const checkpoints = createRunCheckpoints({
    instance, streamId, agent: { name: agent.name, agentVersion: agent.agentVersion }, mode, input: restored?.state.input ?? storedInputOf({ input, registry }), clock, options: runtime.options,
    ...(head == null ? {} : { head }), ...(restored == null ? {} : { ledger: restored.ledger }),
    ...(sessionId == null ? {} : { sessionId }), ...(messageId == null ? {} : { messageId }),
  });
  return { checkpoints, ...(restored == null ? {} : { restored }) };
}
