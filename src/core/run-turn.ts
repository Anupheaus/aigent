import type { ToolCache } from '../cache/cache-types.js';
import { createDirectiveParser } from '../streaming/directive-parser.js';
import type { ParseOutput } from '../streaming/directive-parser.js';
import type { FinishReason, ProviderMessage, ThinkingBlock, ToolCall, Usage } from '../providers/provider-types.js';
import type { RunTimer } from '../telemetry/run-timer.js';
import type { TraceRecorder } from '../telemetry/trace-recorder.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { dispatchToolCall } from './dispatch-tool-call.js';
import type { RunFeedback } from './link-previous.js';
import { openTurnStream } from './open-turn-stream.js';
import type { ResilienceCounters, TurnRouting } from './open-turn-stream.js';
import { raceSignal } from './race-signal.js';
import type { RunShaping } from './run-shaping.js';
import { requestMessages } from './run-volatile.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

/** Running totals for a whole run; a turn updates them as provider events and tool calls arrive, so partial turns still count. */
export interface RunTotals extends ResilienceCounters {
  usage: Usage;
  turns: number;
  /** Tool calls actually started. */
  toolCalls: number;
}

/** The run's telemetry collectors, shared by its turns. */
export interface RunTelemetry {
  recorder: TraceRecorder;
  timer: RunTimer;
  feedback: RunFeedback;
}

/** Work a turn starts in the background; owned by the caller so it can be drained even when the stream throws. */
export interface TurnWork {
  executions: Promise<ExecutedToolCall>[];
  activities: Promise<void>[];
  /** Aborted when the turn stops waiting for its activity renderers, so abandoned renderers emit nothing more. */
  activityController: AbortController;
}

export interface RunTurnParams {
  runId: string;
  agentName: string;
  instanceId: string;
  routing: TurnRouting;
  /** Whether `thinking-delta` events are emitted. */
  showThinking: boolean;
  registry: ToolRegistry;
  maxToolCalls: number;
  clock: Clock;
  signal: AbortSignal;
  /** Conversation so far; copied into the request, never mutated. */
  messages: ProviderMessage[];
  totals: RunTotals;
  work: TurnWork;
  telemetry: RunTelemetry;
  /** The runtime's tool-result cache; absent when caching is off. */
  cache?: ToolCache;
  /** The run's shaping; absent when nothing can be shaped. */
  shaping?: RunShaping;
  /** The run's trailing volatile block. */
  volatile: RunVolatile;
  emit(event: AigentEvent): void;
}

export interface TurnStreamResult {
  /** Assistant text with directive lines removed. */
  visible: string;
  /** Tool calls in the order the model made them. */
  calls: ToolCall[];
  /** Completed thinking blocks in order; replayed verbatim on the turn's assistant message. */
  thinkingBlocks: ThinkingBlock[];
  finishReason?: FinishReason;
}


/** Emits parsed text, directives and warnings, recording outcome directives on the trace; returns the visible text. */
function emitParsed(output: ParseOutput, turn: RunTurnParams): string {
  const { text, directives, warnings } = output;
  const { emit, totals: { turns }, telemetry: { recorder } } = turn;
  if (text !== '') emit({ type: 'text-delta', text });
  for (const directive of directives) {
    // A directive reports on results the model has seen: the last step of an earlier turn, even when it arrives after
    // this turn's own tool calls.
    if (directive.type === 'outcome') recorder.attachOutcome({ outcome: directive.data, source: 'directive', turn: turns });
    emit({ type: 'directive', directive });
  }
  for (const message of warnings) emit({ type: 'warning', message });
  return text;
}

function addUsage(totals: RunTotals, usage: Usage): void {
  totals.usage.inputTokens += usage.inputTokens;
  totals.usage.outputTokens += usage.outputTokens;
  totals.usage.cachedTokens += usage.cachedTokens;
}

/** Streams one model response, emitting events and dispatching tool calls as they arrive. Throws if the stream fails or aborts. */
export async function runTurn(params: RunTurnParams): Promise<TurnStreamResult> {
  const { runId, routing, showThinking, registry, signal, messages, totals, telemetry: { timer }, volatile, clock, maxToolCalls, emit } = params;
  const parser = createDirectiveParser();
  const calls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  let visible = '';
  let finishReason: FinishReason | undefined;

  const tools = registry.specs();
  const request = { messages: requestMessages({ volatile, clock, messages, tools, progress: { turn: totals.turns, toolCalls: totals.toolCalls, maxToolCalls } }), tools };
  const iterator = openTurnStream({ routing, request, signal, counters: totals, emit })[Symbol.asyncIterator]();
  let isAbandoned = false;
  try {
    for (;;) {
      // Raced so stop() and timeoutMs work even against a provider that ignores the signal (a Provider contract breach).
      const raced = await raceSignal({ work: iterator.next(), signal });
      if (raced.isAborted) {
        isAbandoned = true;
        throw createAigentError({ code: 'aborted', message: `Run '${runId}' was aborted while streaming from '${routing.targets[0].label}'` });
      }
      if (raced.value.done === true) break;
      const event = raced.value.value;
      if (event.type === 'text-delta' || event.type === 'thinking-delta' || event.type === 'tool-call') timer.markFirstToken();
      switch (event.type) {
        case 'text-delta': visible += emitParsed(parser.push(event.text), params); break;
        case 'thinking-delta': if (showThinking) emit(event); break;
        // Opaque replay data (signatures, encrypted reasoning), not output: kept for the next request, never emitted.
        case 'thinking-block': thinkingBlocks.push(event.block); break;
        case 'tool-call': calls.push(event.call); dispatchToolCall({ call: event.call, turn: params }); break;
        case 'usage': addUsage(totals, event.usage); emit(event); break;
        case 'done': finishReason = event.finishReason; break;
      }
    }
  } finally {
    // A stream that ended or threw is already finished; only one we walked away from needs to be told to stop.
    if (isAbandoned) stopStream(iterator);
  }
  visible += emitParsed(parser.end(), params);
  return { visible, calls, thinkingBlocks, finishReason };
}
