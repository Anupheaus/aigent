import type { ToolCache } from '../cache/cache-types.js';
import type { RunPlanning } from '../planning/run-planning.js';
import type { ProviderMessage, ToolCall } from '../providers/provider-types.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { AigentEvent, TaskStatus } from './aigent-events.js';
import type { TaskResultData } from './agent-types.js';
import { describeError } from './describe-value.js';
import { PREVIOUS_FIELD } from '../feedback/previous-outcome.js';
import { COMMENTARY_TOOLS } from './dispatch-tool-call.js';
import { nothingHeld } from './run-memory.js';
import { createTurnWork, drainWork, failedDetails } from './drain-work.js';
import type { TurnRouting } from './open-turn-stream.js';
import { syncPinned } from './run-planning-setup.js';
import { createRunCompaction } from './run-compaction.js';
import type { RunCompactionSettings } from './run-compaction.js';
import { compressCommitted } from './run-compression.js';
import type { RunCompression } from './run-compression.js';
import { reconcileInterruptedRound } from '../resume/reconcile-calls.js';
import type { RestoredRun } from '../resume/reconcile-calls.js';
import type { ApprovalCenter } from '../approvals/approval-gate.js';
import type { InFlightRound } from '../resume/checkpoint-types.js';
import type { RunCheckpoints } from '../resume/checkpoint-hooks.js';
import { createRunCheckpointer } from './run-checkpointer.js';
import { createRunCallIds } from './run-call-ids.js';
import { watchRunLease } from './run-lease-watch.js';
import { appendContextMessages, createRunContext, restoreRunContext } from './run-context.js';
import type { NewContextMessage } from './run-context.js';
import type { RunControl } from './run-control.js';
import { createRunOriginals } from './run-originals.js';
import type { RunShaping } from './run-shaping.js';
import { runTurn } from './run-turn.js';
import type { RunTelemetry, RunTotals, TurnStreamResult } from './run-turn.js';
import type { RunVolatile } from './run-volatile.js';
import type { Clock } from './runtime-services.js';
import { delegatedTurnMessages, turnMessages } from './turn-messages.js';
import { abortedStatus, buildTurnsResult } from './turns-result.js';
import { collectCitations, resolveCitations } from './citations.js';
import type { Citation } from './citations.js';
import type { GuardrailRunContext } from '../guardrails/guardrail-types.js';
import type { RunGuardrails } from './run-guardrails.js';
import { settleAnswer } from './settle-answer.js';
import { guardSettledCall } from './guard-settled-call.js';
import type { RunEffects } from './run-effects.js';
import type { RunDelegation } from './delegation-types.js';
import { roundHasSideEffects } from './run-response-cache.js';
import type { RunResponseCache } from './run-response-cache.js';

/** Supplies messages that arrived while the run was busy; read at each safe boundary (before a model request). */
export interface SteerSource {
  take(): ProviderMessage[];
}

/** Everything one agent loop needs, whatever started it (a task or a chat turn). */
export interface RunAgentTurnsParams {
  runId: string;
  /** Stable id of this run's answer, for user feedback. */
  responseId: string;
  agentName: string;
  instanceId: string;
  routing: TurnRouting;
  /** The messages the run starts from: the system prompt, then a task brief or a conversation's history. */
  initial: NewContextMessage[];
  /** Present when the agent compresses; tool results are compressed as they are committed. */
  compression?: RunCompression;
  registry: ToolRegistry;
  limits: { maxTurns: number; maxToolCalls: number };
  clock: Clock;
  control: RunControl;
  telemetry: RunTelemetry;
  /** The runtime's tool-result cache; absent when caching is off. */
  cache?: ToolCache;
  /** The run's shaping; absent when nothing can be shaped. */
  shaping?: RunShaping;
  /** The run's volatile block, minus the limits this function adds. */
  volatile: Omit<RunVolatile, 'maxTurns'>;
  planning: RunPlanning;
  compaction: RunCompactionSettings;
  /** Chat: record the round a stop or failure cut short (partial text, every dispatched call with its result). */
  keepPartialRound?: boolean;
  /** Called with each round's messages as they join the history, before compaction can change them. */
  onCommit?(messages: ProviderMessage[]): void;
  /** Steering messages, delivered at the next safe boundary as user messages. */
  steer?: SteerSource;
  /** With `resume`: the run's checkpoints and call ledger. */
  checkpoints?: RunCheckpoints;
  /** A resumed run's checkpoint and ledger; `initial` is then ignored. */
  restore?: RestoredRun;
  /** No user: interrupted calls that need approval are refused. */
  isUnattended?: boolean;
  /** The agent instance's approvals: calls whose tool requires approval wait here for `agent.approve`. */
  approvals?: ApprovalCenter;
  /** The run's guardrails; with `answer`, how the final answer is checked (the task's structured output, retries). */
  guardrails?: { checks: RunGuardrails; answer: GuardrailRunContext; outputRetries: number };
  /** An input guardrail blocked the run: it fails with this, before any request. */
  inputBlocked?: string;
  /** The run's side effects (dry-run plans). */
  effects?: RunEffects;
  /** How tools that start sub-runs (`delegate`) reach the runtime's agents. */
  delegation?: RunDelegation;
  /** `learning.responseCache`: identical reproducible requests are replayed. */
  responseCache?: RunResponseCache;
  emit(event: AigentEvent): void;
}

/** Said once per run whose provider runs its own tool loop. */
function delegatedModeWarning(providerId: string): string {
  return `Provider '${providerId}' runs its own tool loop (ownsLoop): each turn is one provider call whose tool calls run through this runtime, so steering, compaction, plan and todo directives and checkpoints apply only between turns, and maxTurns counts provider calls rather than tool rounds`;
}

/** `signal.reason` when the run aborts its own tools because the provider failed. */
const PROVIDER_FAILED_ABORT_REASON = 'the run failed because the provider failed';

/**
 * Runs the agent loop over `initial` until the model answers, a limit is hit, the run is stopped or the provider fails.
 * Never rejects for those cases.
 */
export async function runAgentTurns(params: RunAgentTurnsParams): Promise<TaskResultData> {
  const { runId, responseId, agentName, instanceId, routing, initial, limits, clock, control, telemetry, cache, shaping, planning, emit, keepPartialRound = false, onCommit, steer, restore } = params;
  const volatile: RunVolatile = { ...params.volatile, maxTurns: limits.maxTurns };
  const { abortController, sideEffectSignal } = control;
  const { signal } = abortController;
  const startedAt = clock.now();
  const context = restore == null ? createRunContext({ runId, createdAt: startedAt, initial }) : restoreRunContext({ runId, stored: restore.state.context });
  const totals: RunTotals = restore == null ? { usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, turns: 0, toolCalls: 0, retries: 0, fallbacks: 0, compactionTokens: 0 } : structuredClone(restore.state.totals);
  const originals = createRunOriginals({
    registry: params.registry, isFeedbackEnabled: telemetry.feedback.isEnabled, ...(shaping == null ? {} : { shaping }), ...(params.compression == null ? {} : { compression: params.compression.settings }),
    ...(restore == null ? {} : { restored: { originals: restore.state.originals, hasResultOriginal: restore.state.hasResultOriginal } }),
  });
  const approvalRunId = params.checkpoints?.streamId ?? runId;
  const checkpointer = createRunCheckpointer({
    ...(params.checkpoints == null ? {} : { hooks: params.checkpoints }), context, totals, planning, originals, ...(shaping == null ? {} : { shaping }),
    approvals: () => params.approvals?.pending(approvalRunId) ?? [],
  });
  const { ledger, ledgerRunId } = checkpointer;
  /** The response whose calls are running, once it is in; an approval checkpoint keeps it. */
  let inFlightRound: InFlightRound | undefined;
  const isUnattended = params.isUnattended ?? false;
  const approvals = params.approvals;
  const gate = approvals == null ? undefined : (call: { call: ToolCall; tool: Tool; context: ToolContext; force?: { reason: string } }) => approvals.gate({
    // Any stop ends the wait, a graceful one too: nobody may be there to decide.
    runId: approvalRunId, ...call, isUnattended, signal: control.stopSignal, emit,
    // The pending request is checkpointed; the turn's request was sent, but only a recorded response counts it.
    onPending: async () => { await checkpointer.at({ boundary: 'approval', ...(inFlightRound == null ? { turnsDone: totals.turns - 1 } : { inFlight: inFlightRound }) }); },
  });
  const callIds = createRunCallIds({ context, ...(restore == null ? {} : { reserved: restore.ledger.map(({ callId }) => callId) }) });
  const compactor = createRunCompaction({ settings: params.compaction, context, originals, volatile, clock, totals, signal, emit });
  const errors: ToolErrorDetail[] = [];
  /** What the run's tools offered for citing, by chunk id (the answer's markers resolve against it). */
  const citable = new Map<string, Citation>();
  let citations: Citation[] = [];
  let answer = '';
  let output: unknown;
  let status: TaskStatus = 'completed';
  let failure: string | undefined;
  let outputRetries = params.guardrails?.outputRetries ?? 0;
  /** A resumed run may have changed things before it was interrupted, so its first response is never replayed. */
  let previousRoundHadSideEffects = restore != null;

  const commit = (messages: NewContextMessage[]): void => {
    appendContextMessages({ context, messages, createdAt: clock.now() });
    onCommit?.(messages.map(({ message }) => message));
  };
  const fail = (error: unknown): void => { status = 'failed'; failure = describeError(error); emit({ type: 'error', message: failure }); };
  const lease = watchRunLease({ ...(params.checkpoints == null ? {} : { checkpoints: params.checkpoints }), control, emit });
  /** Writes a checkpoint; a failed write fails the run, except a fenced one (the lease is lost: the run stops instead). */
  const checkpoint = async (at: Parameters<typeof checkpointer.at>[0]): Promise<boolean> => {
    if (lease.isLost()) return true;
    try {
      await checkpointer.at(at);
      return true;
    } catch (error) {
      if (lease.absorbFenced(error)) return true;
      fail(error);
      abortController.abort(PROVIDER_FAILED_ABORT_REASON);
      return false;
    }
  };

  let isReady = true;
  const { effects, guardrails } = params;
  if (restore != null) {
    const { memory } = telemetry;
    const round = await reconcileInterruptedRound({
      // Bookkeeping tools carry no memory field, as in a live dispatch.
      ...(memory == null ? {} : { takeMemory: (call: ToolCall) => (COMMENTARY_TOOLS.has(call.name) ? nothingHeld(call) : memory.take(call)) }),
      // Feedback's previous is stripped as a live dispatch strips it; the interrupted process already linked it.
      ...(telemetry.feedback.isEnabled ? { injectedFields: (call: ToolCall) => (COMMENTARY_TOOLS.has(call.name) ? [] : [PREVIOUS_FIELD]) } : {}),
      restored: restore, registry: originals.registry(), ids: { runId: ledgerRunId ?? runId, agentName, instanceId }, signal, sideEffectSignal, isUnattended, now: () => clock.now(), emit,
      ...(ledger == null ? {} : { ledger }), ...(effects == null ? {} : { dryRun: effects.dryRun, record: effects.record }), ...(guardrails == null ? {} : { guard: guardSettledCall(guardrails.checks) }),
      ...(gate == null ? {} : { gate: ({ call, tool, force }: { call: ToolCall; tool: Tool; force?: { reason: string } }) => gate({ call, tool, context: { runId, agentName, instanceId, callId: call.id, signal }, ...(force == null ? {} : { force }) }) }),
    });
    // Not reported through onCommit: a chat already holds this round (the cut-short reply), so its history is not repeated.
    if (round.messages.length > 0) appendContextMessages({ context, messages: round.messages, createdAt: clock.now() });
    totals.turns = round.turn;
  }
  isReady = await checkpoint({ boundary: restore == null ? 'start' : 'turn-complete' });
  const delegating = routing.targets.find(({ provider }) => provider.capabilities.ownsLoop === true);
  if (delegating != null) emit({ type: 'warning', message: delegatedModeWarning(delegating.provider.id) });
  if (params.inputBlocked != null) {
    status = 'failed';
    failure = params.inputBlocked;
    emit({ type: 'error', message: failure });
    isReady = false;
  }

  for (;;) {
    if (!isReady) break;
    // Covers an abort that landed while tools ran after the stream had already finished.
    if (signal.aborted) { status = abortedStatus(control.abortReason()); break; }
    if (control.isGracefulStopRequested()) { status = 'stopped'; break; }
    if (totals.turns >= limits.maxTurns) { status = 'limit_reached'; break; }
    // The safe boundary: every result of the previous round is stored and no request is in flight.
    const steered = steer?.take() ?? [];
    if (steered.length > 0) commit(steered.map(message => ({ message, kind: 'user' })));
    totals.turns += 1;
    syncPinned({ context, planning, now: clock.now() });
    const compactionsBefore = compactor.stats().compactions;
    try {
      // A turn boundary: every result of the previous round is stored, so no call can be separated from its result.
      await compactor.beforeTurn({ remainingTurns: limits.maxTurns - totals.turns + 1 });
    } catch (error) {
      if (signal.aborted) { status = abortedStatus(control.abortReason()); break; }
      fail(error);
      break;
    }
    // This turn's request is not sent yet, so it is not counted in the checkpoint.
    if (compactor.stats().compactions > compactionsBefore && !await checkpoint({ boundary: 'compaction', turnsDone: totals.turns - 1 })) break;
    const registry = originals.registry();
    const work = createTurnWork();
    let turn: TurnStreamResult;
    const endTurn = telemetry.timer.startTurn();
    try {
      turn = await runTurn({
        runId, agentName, instanceId, routing, registry, maxToolCalls: limits.maxToolCalls, usableBudget: params.compaction.usableBudget, clock,
        ...(ledger == null ? {} : { ledger }), ...(ledgerRunId == null ? {} : { ledgerRunId }), ...(gate == null ? {} : { approve: gate }), signal, sideEffectSignal, context, totals, work, telemetry, emit, volatile, planning,
        ...(cache == null ? {} : { cache }),
        ...(shaping == null ? {} : { shaping }),
        ...(params.guardrails == null ? {} : { guardrails: params.guardrails.checks }),
        ...(params.effects == null ? {} : { effects: params.effects }),
        ...(params.delegation == null ? {} : { delegation: params.delegation }), stopSignal: control.stopSignal, callIds,
        ...(params.responseCache == null ? {} : { responseCache: params.responseCache, previousRoundHadSideEffects }),
      });
      endTurn();
    } catch (error) {
      endTurn();
      // Only the run's own signal means it was aborted; a provider error that merely carries the 'aborted' code is a provider failure.
      if (signal.aborted) {
        status = abortedStatus(control.abortReason());
      } else {
        fail(error);
        // Tools dispatched mid-stream must not outlive a failed run.
        abortController.abort(PROVIDER_FAILED_ABORT_REASON);
      }
      const executed = await drainWork({ work, signal, emit });
      errors.push(...failedDetails(executed));
      // Every dispatched call has a result (real or aborted), so the cut-short round stays provider-valid.
      if (keepPartialRound) commit(turnMessages({ turn: work.partial, executed, registry }));
      break;
    }

    // The response is in: a resume completes this round from here rather than asking the model again.
    const inFlight = { turn: totals.turns, assistant: { role: 'assistant' as const, text: turn.visible, ...(turn.calls.length > 0 ? { toolCalls: turn.calls } : {}), ...(turn.thinkingBlocks.length > 0 ? { thinkingBlocks: turn.thinkingBlocks } : {}) } };
    // Delegated mode: the provider ran every call inside the stream and answered, so the round is complete as it is.
    const isDelegated = turn.calls.length > 0 && turn.delegatedCallIds.length === turn.calls.length;
    const isAnswer = turn.calls.length === 0 || isDelegated;
    if (!isAnswer) inFlightRound = inFlight;
    const isRecorded = isAnswer || await checkpoint({ boundary: 'message', inFlight });
    const drained = await drainWork({ work, signal, emit });
    const executed = await compressCommitted({ executed: drained, originals, clock, signal, emit, ...(params.compression == null ? {} : { compression: params.compression }) });
    commit((isDelegated ? delegatedTurnMessages : turnMessages)({ turn, executed, registry }));
    previousRoundHadSideEffects = roundHasSideEffects({ calls: turn.calls, registry });
    inFlightRound = undefined;
    errors.push(...failedDetails(executed));
    collectCitations({ executed, registry, into: citable });
    // A round cut short by a stop is not checkpointed: its response (the 'message' checkpoint) stays the latest, so a
    // suspended ask_user turn can be continued with real answers instead of its aborted results.
    // The round's effects are in the log before the checkpoint commits it; a crash before then replays them from the ledger.
    await effects?.flush();
    if (!isRecorded || (!signal.aborted && !await checkpoint({ boundary: 'turn-complete' }))) break;
    if (isAnswer) {
      const settled = await settleAnswer({ text: turn.raw.trim(), streamed: turn.visible, ...(params.guardrails == null ? {} : { guardrails: params.guardrails.checks }), structured: params.guardrails?.answer ?? {}, retriesLeft: Math.min(outputRetries, limits.maxTurns - totals.turns), emit });
      // The answer did not match the task's output schema: the model is told why and answers again.
      if (settled.kind === 'retry') { outputRetries -= 1; commit([{ kind: 'user', message: { role: 'user', text: settled.feedback } }]); continue; }
      ({ answer, citations } = resolveCitations({ answer: settled.answer, known: citable, emit }));
      if (settled.kind === 'failed') { status = 'failed'; failure = settled.failure; emit({ type: 'error', message: failure }); break; }
      output = settled.output;
      if (turn.finishReason === 'length') status = 'incomplete';
      break;
    }
  }

  lease.dispose();
  if (params.checkpoints != null && !lease.isLost()) await checkpointer.close(status).catch((error: unknown) => emit({ type: 'warning', message: `The run's final checkpoint was not written: ${describeError(error)}` }));
  return buildTurnsResult({
    ids: { runId, responseId, agentName, instanceId }, outcome: { status, answer, errors, citations, ...(failure == null ? {} : { failure }), ...(output === undefined ? {} : { output }) },
    totals, context, compactor, planning, durationMs: clock.now() - startedAt,
  });
}
