import { createDirectiveParser } from '../streaming/directive-parser.js';
import type { ParseOutput } from '../streaming/directive-parser.js';
import type { FinishReason, ProviderMessage, ThinkingBlock, ToolCall, Usage } from '../providers/provider-types.js';
import { executeToolCall, rejectToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { parseToolArgs } from '../tools/parse-tool-args.js';
import { startToolActivity } from '../tools/run-tool-activity.js';
import { describeThrown } from '../tools/tool-error-detail.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MultiToolContext, ToolContext } from '../tools/tool-types.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { openTurnStream } from './open-turn-stream.js';
import type { ResilienceCounters, TurnRouting } from './open-turn-stream.js';
import { raceSignal } from './race-signal.js';
import type { Clock } from './runtime-services.js';
import { stopStream } from './stop-stream.js';

/** Running totals for a whole run; a turn updates them as provider events and tool calls arrive, so partial turns still count. */
export interface RunTotals extends ResilienceCounters {
  usage: Usage;
  turns: number;
  /** Tool calls actually started. */
  toolCalls: number;
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

interface ReserveToolCallParams {
  totals: RunTotals;
  maxToolCalls: number;
}

interface DispatchParams {
  call: ToolCall;
  turn: RunTurnParams;
}

/** Emits parsed text, directives and warnings; returns the visible text. */
function emitParsed(output: ParseOutput, emit: RunTurnParams['emit']): string {
  const { text, directives, warnings } = output;
  if (text !== '') emit({ type: 'text-delta', text });
  for (const directive of directives) emit({ type: 'directive', directive });
  for (const message of warnings) emit({ type: 'warning', message });
  return text;
}

function addUsage(totals: RunTotals, usage: Usage): void {
  totals.usage.inputTokens += usage.inputTokens;
  totals.usage.outputTokens += usage.outputTokens;
  totals.usage.cachedTokens += usage.cachedTokens;
}

/** Takes one call from the run's `maxToolCalls` budget; false once it is spent. */
function reserveToolCall(params: ReserveToolCallParams): boolean {
  const { totals, maxToolCalls } = params;
  if (totals.toolCalls >= maxToolCalls) return false;
  totals.toolCalls += 1;
  return true;
}

/** Starts (or refuses, past the limit) one tool call without waiting for it, so tools overlap with generation. */
function dispatchToolCall(params: DispatchParams): void {
  const { call, turn } = params;
  const { runId, agentName, instanceId, registry, maxToolCalls, clock, signal, totals, work, emit } = turn;
  const { id: callId, name, args } = call;
  emit({ type: 'tool-call', callId, name, args });
  const reportResult = (executed: ExecutedToolCall): ExecutedToolCall => {
    emit({ type: 'tool-result', callId, envelope: executed.envelope });
    return executed;
  };
  // Calls that never run have no renderer, but a UI still needs a row for them saying why.
  const reportNotRun = (executed: ExecutedToolCall): ExecutedToolCall => {
    const { envelope } = executed;
    const detail = envelope.ok ? undefined : envelope.error.message;
    emit({ type: 'tool-activity', callId, view: { title: `Call to '${name}' was not run`, ...(detail != null ? { detail } : {}) } });
    return reportResult(executed);
  };

  if (totals.toolCalls >= maxToolCalls) {
    const error = { category: 'denied', code: 'tool_call_limit', retryable: false, message: `Tool call limit of ${maxToolCalls} reached` } as const;
    work.executions.push(Promise.resolve(rejectToolCall({ call, error })).then(reportNotRun));
    return;
  }

  const baseContext: ToolContext = { agentName, instanceId, runId, signal };
  let context: ToolContext = baseContext;
  if (name === MULTI_TOOL_NAME) {
    // The aigent_multi wrapper is not counted itself: each inner call takes from the shared budget instead.
    const multiContext: MultiToolContext = { ...baseContext, reserveToolCall: () => reserveToolCall({ totals, maxToolCalls }) };
    context = multiContext;
  } else {
    totals.toolCalls += 1;
  }
  // executeToolCall promises never to reject; this last-resort guard keeps a broken promise from failing the run or going unhandled.
  const execution = executeToolCall({ registry, call, context, now: () => clock.now() })
    .catch((error: unknown) => rejectToolCall({ call, error: describeThrown(error) }));

  const tool = registry.get(name);
  const parsed = tool == null ? undefined : parseToolArgs(tool.argsSchema, args);
  if (tool == null || parsed == null || !parsed.ok) {
    // Unknown tool or invalid arguments: executeToolCall refuses it without running anything.
    work.executions.push(execution.then(reportNotRun));
    return;
  }
  work.executions.push(execution.then(reportResult));
  const outcome = execution.then(executed => executed.outcome);
  work.activities.push(startToolActivity({ tool, args: parsed.value, callId, outcome, signal: work.activityController.signal, emit }));
}

/** Streams one model response, emitting events and dispatching tool calls as they arrive. Throws if the stream fails or aborts. */
export async function runTurn(params: RunTurnParams): Promise<TurnStreamResult> {
  const { runId, routing, showThinking, registry, signal, messages, totals, emit } = params;
  const parser = createDirectiveParser();
  const calls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  let visible = '';
  let finishReason: FinishReason | undefined;

  const request = { messages: [...messages], tools: registry.specs() };
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
      switch (event.type) {
        case 'text-delta': visible += emitParsed(parser.push(event.text), emit); break;
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
  visible += emitParsed(parser.end(), emit);
  return { visible, calls, thinkingBlocks, finishReason };
}
