import type { ToolCache } from '../cache/cache-types.js';
import { createDirectiveParser } from '../streaming/directive-parser.js';
import type { ParseOutput } from '../streaming/directive-parser.js';
import type { FinishReason, ThinkingBlock, ToolCall, Usage } from '../providers/provider-types.js';
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
import type { CallLedger } from '../resume/call-ledger.js';
import type { GateOutcome } from '../approvals/approval-gate.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { RunShaping } from './run-shaping.js';
import type { RunContext } from './run-context.js';
import { buildTurnRequest, recordPromptSize } from './run-request.js';
import { applyPlanningDirective } from '../planning/apply-directives.js';
import type { RunPlanning } from '../planning/run-planning.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';
import { stopStream } from './stop-stream.js';
import type { RunGuardrails } from './run-guardrails.js';
import type { RunEffects } from './run-effects.js';
import type { StreamHoldback } from '../guardrails/stream-holdback.js';
import type { DelegatedUsage, RunDelegation } from './delegation-types.js';

/** Running totals for a whole run; a turn updates them as provider events and tool calls arrive, so partial turns still count. */
export interface RunTotals extends ResilienceCounters {
  usage: Usage;
  /** What delegated sub-runs used; absent until a sub-run finishes. */
  delegated?: DelegatedUsage;
  turns: number;
  /** Tool calls actually started. */
  toolCalls: number;
  /** Input plus output tokens of compaction summaries (also included in `usage`). */
  compactionTokens: number;
}

/** The run's telemetry collectors, shared by its turns. */
export interface RunTelemetry {
  recorder: TraceRecorder;
  timer: RunTimer;
  feedback: RunFeedback;
}

/** What a turn has streamed so far; kept by the caller so a cut-short turn can still be recorded. */
export interface PartialTurn {
  visible: string;
  calls: ToolCall[];
  thinkingBlocks: ThinkingBlock[];
}

/** Work a turn starts in the background; owned by the caller so it can be drained even when the stream throws. */
export interface TurnWork {
  /** Filled as the stream arrives. */
  partial: PartialTurn;
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
  registry: ToolRegistry;
  maxToolCalls: number;
  /** The run's usable prompt budget; the built request is checked against it before it is sent. */
  usableBudget: number;
  /** With `resume`: every work call is recorded before it runs. */
  ledger?: CallLedger;
  /** The run id the ledger and idempotency keys use (the original run's when resumed); default `runId`. */
  ledgerRunId?: string;
  /** The approval gate: whether a call may run (asking a person when its tool requires approval). */
  approve?(params: { call: ToolCall; tool: Tool; context: ToolContext }): Promise<GateOutcome>;
  clock: Clock;
  signal: AbortSignal;
  /** Tools with side effects get this instead of `signal` (see `RunControl.sideEffectSignal`). */
  sideEffectSignal: AbortSignal;
  /** The run's stored messages; read into the request, never changed here (only its size figures are updated). */
  context: RunContext;
  totals: RunTotals;
  work: TurnWork;
  telemetry: RunTelemetry;
  /** The runtime's tool-result cache; absent when caching is off. */
  cache?: ToolCache;
  /** The run's shaping; absent when nothing can be shaped. */
  shaping?: RunShaping;
  /** The run's trailing volatile block. */
  volatile: RunVolatile;
  /** The run's plan and todo list; plan and todo directives update it. */
  planning: RunPlanning;
  /** The run's guardrails (tool calls, results and the visible stream). */
  guardrails?: RunGuardrails;
  /** The run's side effects (dry-run plans). */
  effects?: RunEffects;
  /** How tools that start sub-runs (`delegate`) reach the runtime's agents. */
  delegation?: RunDelegation;
  /** Aborts on any stop of the run, graceful included. */
  stopSignal?: AbortSignal;
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


/** Emits parsed text (through the stream guardrails), directives and warnings, recording outcome directives on the trace; returns the visible text. */
function emitParsed(output: ParseOutput, turn: RunTurnParams & { stream?: StreamHoldback }): string {
  const { text, directives, warnings } = output;
  const { emit, totals: { turns }, telemetry: { recorder }, planning, stream } = turn;
  const shown = stream == null || text === '' ? text : stream.push(text);
  if (shown !== '') emit({ type: 'text-delta', text: shown });
  for (const directive of directives) {
    // A directive reports on results the model has seen: the last step of an earlier turn, even when it arrives after
    // this turn's own tool calls.
    if (directive.type === 'outcome') recorder.attachOutcome({ outcome: directive.data, source: 'directive', turn: turns });
    emit({ type: 'directive', directive });
    // Applied as it arrives, so a directive and a tool call of the same turn take effect in stream order.
    applyPlanningDirective({ planning, directive, emit });
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
  const { runId, routing, registry, signal, context, totals, telemetry: { timer }, volatile, clock, maxToolCalls, usableBudget, emit, work: { partial } } = params;
  const parser = createDirectiveParser();
  const { calls, thinkingBlocks } = partial;
  // Held-back text a guardrail may still change before it is shown; what the model said is kept as said in `visible`.
  const stream = params.guardrails?.stream();
  const parse = { ...params, ...(stream == null ? {} : { stream }) };
  let finishReason: FinishReason | undefined;

  const { request, estimatedTokens } = buildTurnRequest({
    context, tools: registry.specs(), volatile, clock, target: routing.targets[0], usableBudget, progress: { turn: totals.turns, toolCalls: totals.toolCalls, maxToolCalls },
  });
  let reportedTokens: number | undefined;
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
        case 'text-delta': partial.visible += emitParsed(parser.push(event.text), parse); break;
        // Always emitted: the run's emitter decides whether the user's stream shows it (`onThinking` always gets it).
        case 'thinking-delta': emit(event); break;
        // Opaque replay data (signatures, encrypted reasoning), not output: kept for the next request, never emitted.
        case 'thinking-block': thinkingBlocks.push(event.block); break;
        case 'tool-call': calls.push(event.call); dispatchToolCall({ call: event.call, turn: params }); break;
        case 'usage': addUsage(totals, event.usage); reportedTokens = event.usage.inputTokens; emit(event); break;
        case 'done': finishReason = event.finishReason; break;
      }
    }
  } finally {
    // A stream that ended or threw is already finished; only one we walked away from needs to be told to stop.
    if (isAbandoned) stopStream(iterator);
  }
  recordPromptSize({ context, estimatedTokens, ...(reportedTokens == null ? {} : { reportedTokens }) });
  partial.visible += emitParsed(parser.end(), parse);
  const held = stream?.end() ?? '';
  if (held !== '') params.emit({ type: 'text-delta', text: held });
  return { visible: partial.visible, calls, thinkingBlocks, finishReason };
}
