import type { StabilityMonitor } from '../context/stability-monitor.js';
import { buildVolatileBlock } from '../context/volatile-block.js';
import type { VolatileOptions, VolatileSection } from '../context/volatile-block.js';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import type { Clock } from './runtime-services.js';

/** One run's volatile block: its options, prefix monitor and extra sections (plan and todo statuses). */
export interface RunVolatile {
  options: VolatileOptions;
  monitor: StabilityMonitor;
  maxTurns: number;
  /** Sections rendered after the progress counters, read for each request. */
  extras(): VolatileSection[];
}

export interface RequestMessagesParams {
  volatile: RunVolatile;
  clock: Clock;
  /** Stored history; never changed here. */
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  /** Turn number of this request and tool calls started so far. */
  progress: { turn: number; toolCalls: number; maxToolCalls: number };
}

/** The request's messages: the stored history (checked for prefix stability) plus the volatile block, last. */
export function requestMessages(params: RequestMessagesParams): ProviderMessage[] {
  const { volatile: { options, monitor, maxTurns, extras }, clock, messages, tools, progress: { turn, toolCalls, maxToolCalls } } = params;
  monitor.observe({ messages, tools });
  const block = buildVolatileBlock({ clock, options, progress: { turn, maxTurns, toolCalls, maxToolCalls }, extras: extras() });
  return block == null ? [...messages] : [...messages, { role: 'user', text: block }];
}
