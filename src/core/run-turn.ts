import type { ToolCache } from '../cache/cache-types.js';
import { createDirectiveParser } from '../streaming/directive-parser.js';
import type { ParseOutput } from '../streaming/directive-parser.js';
import type { FinishReason, ProviderEvent, ThinkingBlock, ToolCall, Usage } from '../providers/provider-types.js';
import type { RunTimer } from '../telemetry/run-timer.js';
import type { TraceRecorder } from '../telemetry/trace-recorder.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { createAigentError } from './aigent-error.js';
import type { AigentEvent } from './aigent-events.js';
import { dispatchToolCall } from './dispatch-tool-call.js';
import { runDelegatedCall } from './delegated-call.js';
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
import { createTurnStreamGuard, flushThinking } from './turn-stream-guard.js';
import type { TurnStreamGuard } from './turn-stream-guard.js';
import type { DelegatedUsage, RunDelegation } from './delegation-types.js';
import type { RunCallIds } from './run-call-ids.js';
import type { RunMemory } from './run-memory.js';
import { openCachedTurn } from './run-response-cache.js';
import type { RunResponseCache } from './run-response-cache.js';

/** Running totals for a whole run; a turn updates them as provider events and tool calls arrive, so partial turns still count. */
export interface RunTotals extends ResilienceCounters {
  usage: Usage;
  /** What delegated sub-runs used; absent until a sub-run finishes. Their tool calls count against `maxToolCalls`. */
  delegated?: DelegatedUsage;
  /** Tool calls reserved for sub-runs still in flight (they count against `maxToolCalls` until released). */
  delegationReserved?: number;
  turns: number;
  /** Tool calls actually started. */
  toolCalls: number;
  /** Input plus output tokens of compaction summaries (also included in `usage`). */
  compactionTokens: number;
  /** Turns replayed from the response cache; absent until one is. */
  cachedResponses?: number;
}

/** The run's telemetry collectors, shared by its turns. */
export interface RunTelemetry {
  recorder: TraceRecorder;
  timer: RunTimer;
  feedback: RunFeedback;
  /** With memory on: takes the `memory` field out of each call and saves it (traced on the call's step). */
  memory?: RunMemory;
}

/** What a turn has streamed so far; kept by the caller so a cut-short turn can still be recorded. */
export interface PartialTurn {
  /** The text as shown, after the stream guardrails: what history, checkpoints and transcripts keep. */
  visible: string;
  /** The text as the model wrote it (directive lines removed); kept in memory only, to settle the final answer. */
  raw: string;
  calls: ToolCall[];
  /** Delegated mode: ids of the calls the provider's own loop ran through `toolExecutor` (already answered in the stream). */
  delegatedCallIds: string[];
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
  approve?(params: { call: ToolCall; tool: Tool; context: ToolContext; force?: { reason: string } }): Promise<GateOutcome>;
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
  /** Makes the turn's call ids unique within the run. */
  callIds?: RunCallIds;
  /** Aborts on any stop of the run, graceful included. */
  stopSignal?: AbortSignal;
  /** `learning.responseCache`: identical reproducible requests are replayed instead of sent. */
  responseCache?: RunResponseCache;
  /** The previous round ran a tool with side effects (its response is then neither replayed nor stored). */
  previousRoundHadSideEffects?: boolean;
  emit(event: AigentEvent): void;
}

export interface TurnStreamResult {
  /** Assistant text with directive lines removed, as shown (after the stream guardrails); what is stored. */
  visible: string;
  /** The same text as the model wrote it, before the stream guardrails; never stored. */
  raw: string;
  /** Tool calls in the order the model made them. */
  calls: ToolCall[];
  /** Completed thinking blocks in order; replayed verbatim on the turn's assistant message. */
  thinkingBlocks: ThinkingBlock[];
  /** Delegated mode: the calls (of `calls`) the provider ran itself and answered within this turn. */
  delegatedCallIds: string[];
  finishReason?: FinishReason;
}

/** Emits parsed text (through the stream guardrails), directives and warnings, recording outcome directives on the trace and the text on the partial turn. */
function emitParsed(output: ParseOutput, turn: RunTurnParams & { guard: TurnStreamGuard }): void {
  const { text, directives, warnings } = output;
  const { emit, totals: { turns }, telemetry: { recorder }, planning, guard, work: { partial } } = turn;
  const shown = guard.text(text);
  partial.raw += text;
  partial.visible += shown;
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
  // Held-back text (answer and reasoning) a guardrail may still change before it is shown; the raw answer stays in memory.
  const guard = createTurnStreamGuard(params.guardrails);
  const parse = { ...params, guard };
  let finishReason: FinishReason | undefined;

  const { request, estimatedTokens } = buildTurnRequest({
    context, tools: registry.specs(), volatile, clock, target: routing.targets[0], usableBudget, progress: { turn: totals.turns, toolCalls: totals.toolCalls, maxToolCalls },
  });
  let reportedTokens: number | undefined;
  // Delegated mode: a provider that owns the loop calls back into the core for each tool call.
  const isDelegating = routing.targets.some(({ provider }) => provider.capabilities.ownsLoop === true);
  // Set by the first delegated call: from then on a failed stream is never replayed (the call would run again).
  let hasDelegatedCall = false;
  const toolExecutor = isDelegating ? (call: ToolCall) => { hasDelegatedCall = true; return runDelegatedCall({ call, turn: params }); } : undefined;
  const open = (): AsyncIterable<ProviderEvent> => openTurnStream({
    routing, request: { ...request, ...(toolExecutor == null ? {} : { toolExecutor }) }, signal, counters: totals, emit,
    ...(isDelegating ? { isCommitted: () => hasDelegatedCall } : {}),
  });
  // A provider that runs tools inside its own stream cannot be replayed: its calls would not run again.
  const fallbacksBefore = totals.fallbacks;
  const turnStream = params.responseCache == null || isDelegating ? { stream: open(), isHit: false } : openCachedTurn({
    responseCache: params.responseCache, target: routing.targets[0], request, registry, previousRoundHadSideEffects: params.previousRoundHadSideEffects ?? false, open,
    didFallback: () => totals.fallbacks > fallbacksBefore,
  });
  if (turnStream.isHit) totals.cachedResponses = (totals.cachedResponses ?? 0) + 1;
  const iterator = turnStream.stream[Symbol.asyncIterator]();
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
      if (event.type !== 'thinking-delta') flushThinking({ guard, emit });
      switch (event.type) {
        case 'text-delta': emitParsed(parser.push(event.text), parse); break;
        // Always emitted (guarded like the answer): the run's emitter decides whether the user's stream shows it (`onThinking` always gets it).
        case 'thinking-delta': { const shown = guard.thinking(event.text); if (shown !== '') emit({ type: 'thinking-delta', text: shown }); break; }
        // Opaque replay data (signatures, encrypted reasoning), not output: kept for the next request, never emitted.
        case 'thinking-block': thinkingBlocks.push(event.block); break;
        case 'tool-call': { const call = params.callIds?.unique({ call: event.call, turn: totals.turns }) ?? event.call; calls.push(call); dispatchToolCall({ call, turn: params }); break; }
        case 'usage': addUsage(totals, event.usage); if (!turnStream.isHit) reportedTokens = event.usage.inputTokens; emit(turnStream.isHit ? { ...event, cachedResponse: true } : event); break;
        case 'done': finishReason = event.finishReason; break;
      }
    }
  } finally {
    // A stream that ended or threw is already finished; only one we walked away from needs to be told to stop.
    if (isAbandoned) stopStream(iterator);
  }
  recordPromptSize({ context, estimatedTokens, ...(reportedTokens == null ? {} : { reportedTokens }) });
  flushThinking({ guard, emit });
  emitParsed(parser.end(), parse);
  const held = guard.endText();
  partial.visible += held;
  if (held !== '') emit({ type: 'text-delta', text: held });
  return { visible: partial.visible, raw: partial.raw, calls, thinkingBlocks, delegatedCallIds: partial.delegatedCallIds, finishReason };
}
