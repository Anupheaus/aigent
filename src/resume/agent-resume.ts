import type { z } from 'zod';
import type { TaskRun } from '../core/agent-types.js';
import { createAigentError } from '../core/aigent-error.js';
import { startTaskRun } from '../core/start-task-run.js';
import type { ResolvedAgent, RuntimeServices } from '../core/start-task-run.js';
import { parseTaskInput } from '../core/task-input.js';
import type { OnQuestion } from '../chat/task-questions.js';
import type { InstanceHandle } from './instance-runtime.js';

/** `agent.resume(options)`. */
export interface ResumeRunOptions {
  /** The run to continue (default: the latest interrupted one). */
  runId?: string;
  /** A user for `ask_user` again; without it the resumed run's `ask_user` calls are refused. */
  onQuestion?: OnQuestion;
  signal?: AbortSignal;
  /**
   * The structured `output` schema of a run started with one: a schema is not stored (it does not survive a JSON
   * store), so it is required again when the interrupted run had one.
   */
  output?: z.ZodType;
}

export interface AgentResume {
  /** Resolves once the instance is opened (lease taken, interrupted runs loaded); rejects `instance_locked`. */
  ready: Promise<void>;
  resume(options?: ResumeRunOptions): TaskRun | undefined;
}

/**
 * An agent's restore side. With `resume` on the runtime and an explicit `instanceId` it opens the instance at once
 * (so `ready` settles and pending approvals can be decided), and `resume()` continues a run that had not ended (or was
 * stopped gracefully) from its latest checkpoint. A generated instance id has nothing stored, so nothing is opened
 * until its first run: creating agents never takes leases by itself.
 */
export function createAgentResume(params: { agent: ResolvedAgent; services: RuntimeServices; isExplicitInstance: boolean }): AgentResume {
  const { agent, services, isExplicitInstance } = params;
  const runtime = isExplicitInstance ? services.resume : undefined;
  let handle: InstanceHandle | undefined;
  const ready = runtime == null ? Promise.resolve() : runtime.open({ instanceId: agent.instanceId, agentName: agent.name, agentVersion: agent.agentVersion }).then(opened => {
    handle = opened;
    // Requests the interrupted runs were waiting on can be decided before they are resumed.
    for (const [runId, { state }] of opened.interrupted) agent.approvals?.restorePending({ runId, states: state.approvals });
  });
  // Callers that never await `ready` hear about a failed open from their first run instead.
  ready.catch(() => undefined);

  function resume(options: ResumeRunOptions = {}): TaskRun | undefined {
    const { runId, onQuestion, signal, output } = options;
    // Without resume, or for a generated instance id, there is nothing interrupted to continue.
    if (runtime == null) return undefined;
    if (handle == null) throw createAigentError({ code: 'invalid_input', message: `Agent instance '${agent.instanceId}' is not open yet; await agent.ready before agent.resume()`, details: { instanceId: agent.instanceId } });
    const id = runId ?? [...handle.interrupted.keys()].at(-1);
    const interrupted = id == null ? undefined : handle.interrupted.get(id);
    if (id == null || interrupted == null) return undefined;
    const { hasUser = false, hasOutput = false, ...stored } = interrupted.state.input;
    if (hasOutput && output == null) {
      throw createAigentError({ code: 'invalid_input', message: `Run '${id}' of instance '${agent.instanceId}' was started with a structured output schema, which is not stored; pass it again: agent.resume({ output })`, details: { instanceId: agent.instanceId, runId: id } });
    }
    // Taken: a second resume() must not continue the same run twice.
    handle.interrupted.delete(id);
    const input = parseTaskInput({ ...stored, ...(onQuestion == null ? {} : { onQuestion }), ...(signal == null ? {} : { signal }), ...(output == null ? {} : { output }) });
    return startTaskRun({ agent, services, input, restore: { runId: id, streamId: id, hadUser: hasUser, load: async () => interrupted } });
  }

  return { ready, resume };
}
