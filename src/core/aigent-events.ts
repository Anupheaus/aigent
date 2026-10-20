import type { Directive } from '../streaming/directive-parser.js';
import type { ToolActivityView } from '../tools/tool-types.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { Usage } from '../providers/provider-types.js';
import type { QueueReason } from '../scheduler/scheduler-types.js';

/** Every way a run can end. */
export const TASK_STATUSES = ['completed', 'incomplete', 'failed', 'cancelled', 'stopped', 'limit_reached'] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export type AigentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: unknown }
  | { type: 'tool-activity'; callId: string; view: ToolActivityView }
  | { type: 'tool-result'; callId: string; envelope: ToolEnvelope }
  | { type: 'directive'; directive: Directive }
  | { type: 'usage'; usage: Usage }
  | { type: 'warning'; message: string }
  /** A provider call failed before any event and will be retried after `delayMs`; `attempt` is 1 for the first retry. */
  | { type: 'retry'; attempt: number; delayMs: number; model: string; reason: string }
  /** `from` (a `provider:model`) is exhausted; the turn continues on fallback model `to`. */
  | { type: 'fallback'; from: string; to: string; reason: string }
  /** The provider call is waiting for the scheduler; emitted only when it could not start at once. */
  | { type: 'queued'; position: number; reason: QueueReason; waitMs?: number }
  | { type: 'error'; message: string }
  /** Always last, emitted after the run's records are written; `responseId` is the id to rate the answer with. */
  | { type: 'done'; status: TaskStatus; responseId: string };
