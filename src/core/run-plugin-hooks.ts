import { createRunHooks } from '../plugins/run-hooks.js';
import type { RegisteredHooks } from '../plugins/run-hooks.js';
import type { RunStartInfo } from '../plugins/plugin-types.js';
import type { AigentEvent } from './aigent-events.js';
import type { TaskResult } from './agent-types.js';

export interface RunPluginHooks {
  /** Queues the hooks an event triggers (`tool-call`, `tool-result`, `error`); never blocks. */
  observe(event: AigentEvent): void;
  /** Queues `onRunStart`. */
  start(): void;
  /** Queues `onRunEnd`, then waits (bounded by the hook timeouts) for every queued hook, so warnings precede `done`. */
  end(result: TaskResult): Promise<void>;
}

export interface CreateRunPluginHooksParams {
  /** `RuntimeServices.pluginHooks`; absent: nothing is observed. */
  plugins?: () => RegisteredHooks[];
  run: RunStartInfo;
  /** Emits a hook failure as a run `warning`. */
  warn(message: string): void;
}

const NO_HOOKS: RunPluginHooks = { observe: () => undefined, start: () => undefined, end: async () => undefined };

/** The run's side of plugin hooks: which events call which hooks, with the run's identity. */
export function createRunPluginHooks(params: CreateRunPluginHooksParams): RunPluginHooks {
  const { plugins, run, warn } = params;
  if (plugins == null) return NO_HOOKS;
  const hooks = createRunHooks({ plugins, warn });
  const { runId, agentName, instanceId } = run;

  function observe(event: AigentEvent): void {
    if (event.type === 'tool-call') hooks.call({ hook: 'onToolCall', info: { runId, agentName, callId: event.callId, tool: event.name, args: event.args } });
    if (event.type === 'tool-result') hooks.call({ hook: 'onToolResult', info: { runId, agentName, callId: event.callId, envelope: event.envelope } });
    if (event.type === 'error') hooks.call({ hook: 'onError', info: { runId, agentName, message: event.message } });
  }

  async function end(result: TaskResult): Promise<void> {
    const { status, usage } = result;
    hooks.call({ hook: 'onRunEnd', info: { runId, agentName, instanceId, status, usage } });
    await hooks.settled();
  }

  return { observe, start: () => hooks.call({ hook: 'onRunStart', info: run }), end };
}
