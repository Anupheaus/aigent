import type { StabilityMonitor } from '../context/stability-monitor.js';
import { buildVolatileBlock } from '../context/volatile-block.js';
import type { VolatileOptions, VolatileSection } from '../context/volatile-block.js';
import type { ProviderMessage, ProviderToolSpec } from '../providers/provider-types.js';
import type { RunMessage } from './run-planning-setup.js';
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
  messages: RunMessage[];
  tools: ProviderToolSpec[];
  /** Turn number of this request and tool calls started so far. */
  progress: { turn: number; toolCalls: number; maxToolCalls: number };
}

/** The request's messages: the stored history (checked for prefix stability) plus the volatile block, last. */
export function requestMessages(params: RequestMessagesParams): ProviderMessage[] {
  const { volatile: { options, monitor, maxTurns, extras }, clock, messages, tools, progress: { turn, toolCalls, maxToolCalls } } = params;
  // `pinned` is run bookkeeping, not something a provider is sent.
  const sent = messages.map(({ pinned: _pinned, ...message }) => message);
  monitor.observe({ messages: sent, tools });
  const block = buildVolatileBlock({ clock, options, progress: { turn, maxTurns, toolCalls, maxToolCalls }, extras: extras() });
  return block == null ? sent : [...sent, { role: 'user', text: block }];
}
