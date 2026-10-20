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
}

export interface AgentResume {
  /** Resolves once the instance is opened (lease taken, interrupted runs loaded); rejects `instance_locked`. */
  ready: Promise<void>;
  resume(options?: ResumeRunOptions): TaskRun | undefined;
}

/**
 * An agent's restore side: with `resume` on the runtime it opens the instance at once (so `ready` settles), and
 * `resume()` continues a run that had not ended (or was stopped gracefully) from its latest checkpoint.
 */
export function createAgentResume(params: { agent: ResolvedAgent; services: RuntimeServices }): AgentResume {
  const { agent, services } = params;
  const runtime = services.resume;
  let handle: InstanceHandle | undefined;
  const ready = runtime == null ? Promise.resolve() : runtime.open({ instanceId: agent.instanceId, agentName: agent.name, agentVersion: agent.agentVersion }).then(opened => { handle = opened; });
  // Callers that never await `ready` hear about a failed open from their first run instead.
  ready.catch(() => undefined);

  function resume(options: ResumeRunOptions = {}): TaskRun | undefined {
    const { runId, onQuestion, signal } = options;
    if (runtime == null) return undefined;
    if (handle == null) throw createAigentError({ code: 'invalid_input', message: `Agent instance '${agent.instanceId}' is not open yet; await agent.ready before agent.resume()`, details: { instanceId: agent.instanceId } });
    const id = runId ?? [...handle.interrupted.keys()].at(-1);
    const interrupted = id == null ? undefined : handle.interrupted.get(id);
    if (id == null || interrupted == null) return undefined;
    // Taken: a second resume() must not continue the same run twice.
    handle.interrupted.delete(id);
    const { hasUser = false, ...stored } = interrupted.state.input;
    const input = parseTaskInput({ ...stored, ...(onQuestion == null ? {} : { onQuestion }), ...(signal == null ? {} : { signal }) });
    return startTaskRun({ agent, services, input, restore: { runId: id, streamId: id, hadUser: hasUser, load: async () => interrupted } });
  }

  return { ready, resume };
}
