import type { Usage } from '../providers/provider-types.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { Tool } from '../tools/tool-types.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { StreamRun } from './event-stream.js';
import type { TaskInput, TaskLimits } from './task-input.js';

export interface AgentDefinition {
  /** Unique, required; keys all stored data for this agent. */
  name: string;
  /** `provider:model`, e.g. `anthropic:claude-sonnet-5-5`. */
  model: string;
  persona?: string;
  skillset?: string;
  /** The environment the consumer places the agent in. */
  context?: string;
  tools?: Tool[];
  /** Defaults for every task; a task's own limits win field by field. */
  limits?: TaskLimits;
  /** Supply to restore a known instance; generated otherwise. */
  instanceId?: string;
}

export interface TaskUsage extends Usage {
  /** Model requests made. */
  turns: number;
  /**
   * Tool calls actually executed, counting each call inside `aigent_multi` (the wrapper itself is not counted).
   * Calls refused by `maxToolCalls` are not counted. A batch tool call counts once, whatever its item count.
   */
  toolCalls: number;
  durationMs: number;
}

export interface TaskResult {
  status: TaskStatus;
  answer: string;
  runId: string;
  agentName: string;
  instanceId: string;
  usage: TaskUsage;
  /**
   * Every tool failure with full detail, including failures inside successful aggregate results: failed batch items
   * (`details.itemIndex`) and failed `aigent_multi` inner calls (`details.callId`, `details.tool`), each with the
   * enclosing call's id in `details.parentCallId`.
   */
  errors: ToolErrorDetail[];
  /** Set when status is 'failed'. */
  failure?: string;
  /** Set when the run was stopped ('stopped' → graceful, 'cancelled' → immediate). */
  stopMode?: 'graceful' | 'immediate';
}

export interface StopOptions {
  /** 'graceful' finishes the current turn; 'immediate' aborts now. Default 'immediate'. */
  mode?: 'graceful' | 'immediate';
}

export type TaskRun = StreamRun<AigentEvent, TaskResult> & {
  runId: string;
  /** Repeated calls, and calls after the run settled, are no-ops. */
  stop(options?: StopOptions): void;
  /** Alias for `stop({ mode: 'immediate' })`. */
  cancel(): void;
};

export interface Agent {
  name: string;
  instanceId: string;
  /** Validates `input` synchronously (throws `invalid_input`), then runs the task in the background. */
  task(input: TaskInput): TaskRun;
}

export const DEFAULT_LIMITS = { maxTurns: 25, maxToolCalls: 100 } as const;
