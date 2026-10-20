import type { Directive } from '../streaming/directive-parser.js';
import type { ToolActivityView } from '../tools/tool-types.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { Usage } from '../providers/provider-types.js';

export type TaskStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'stopped' | 'limit_reached';

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
  | { type: 'error'; message: string }
  | { type: 'done'; status: TaskStatus };
