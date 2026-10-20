import type { StabilityMonitor } from '../context/stability-monitor.js';
import { buildVolatileBlock } from '../context/volatile-block.js';
import type { VolatileOptions, VolatileSection } from '../context/volatile-block.js';
import type { Clock } from './runtime-services.js';

/** One run's volatile block: its options, prefix monitor and extra sections (plan and todo statuses). */
export interface RunVolatile {
  options: VolatileOptions;
  monitor: StabilityMonitor;
  maxTurns: number;
  /** Sections rendered after the progress counters, read for each request. */
  extras(): VolatileSection[];
}

export interface VolatileTextParams {
  volatile: RunVolatile;
  clock: Clock;
  /** Turn number of this request and tool calls started so far. */
  progress: { turn: number; toolCalls: number; maxToolCalls: number };
}

/** This request's volatile block text, or undefined when it has nothing to say. */
export function volatileText(params: VolatileTextParams): string | undefined {
  const { volatile: { options, maxTurns, extras }, clock, progress: { turn, toolCalls, maxToolCalls } } = params;
  return buildVolatileBlock({ clock, options, progress: { turn, maxTurns, toolCalls, maxToolCalls }, extras: extras() });
}
