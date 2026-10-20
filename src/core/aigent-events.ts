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
  | { type: 'error'; message: string }
  | { type: 'done'; status: TaskStatus };
