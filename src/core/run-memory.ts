import { parseMemoryNotes } from '../memory/memory-schema.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { MemoryNote, ResolvedMemoryOptions } from '../memory/memory-types.js';
import { splitMemory, stripInnerMemory } from '../memory/split-memory.js';
import type { ToolCall } from '../providers/provider-types.js';
import type { TraceRecorder } from '../telemetry/trace-recorder.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { AigentEvent } from './aigent-events.js';
import { describeError } from './describe-value.js';

/** What a run's saves came to, as its run record stores them. */
export interface RunMemoryTotals {
  saved: number;
  evicted: number;
}

/** A call with its `memory` taken out, and its notes held until the call is admitted. */
export interface TakenMemory {
  /** The call without `memory` (also taken out of `aigent_multi` inner calls). */
  call: ToolCall;
  /**
   * The call passed every check (call limit, toolCall guardrails, approval, its ledger entry) and is about to run: its
   * notes are queued for saving, never awaited. Later calls do nothing.
   */
  admit(): void;
  /**
   * The call is settled: the notes of a call that was never admitted are dropped, with a warning naming the call
   * (`quietly`: none, e.g. a resumed call whose notes the interrupted process already queued).
   */
  settle(options?: SettleMemoryOptions): void;
}

export interface SettleMemoryOptions {
  /** Drop the notes without a warning. */
  quietly?: boolean;
}

/** One run's side of memory: the `memory` field taken out of calls and saved behind the agent's other writes. */
export interface RunMemory {
  /** The run's scope key (see `memoryScopeKey`). */
  scopeKey: string;
  options: ResolvedMemoryOptions;
  /** Takes `memory` out of the call; nothing is saved until the call is admitted, so notes of a refused call are never stored. */
  take(call: ToolCall): TakenMemory;
  /** Holds other queued memory work (recall's use counters) for lush; it must never reject. */
  track(work: Promise<void>): void;
  /** Waits for every queued save (it never rejects): the run's result resolves only after its memory is written. */
  flush(): Promise<RunMemoryTotals>;
}

export interface CreateRunMemoryParams {
  store: MemoryStore;
  options: ResolvedMemoryOptions;
  agentName: string;
  runId: string;
  scopeKey: string;
  recorder: Pick<TraceRecorder, 'noteMemory'>;
  /** Set when the run may not write memory (a dry run, telemetry off): notes are refused, once with this reason. */
  skipReason?: string;
  emit(event: AigentEvent): void;
}

export function createRunMemory(params: CreateRunMemoryParams): RunMemory {
  const { store, options, agentName, runId, scopeKey, recorder, skipReason, emit } = params;
  const pending: Promise<void>[] = [];
  const totals: RunMemoryTotals = { saved: 0, evicted: 0 };
  let hasWarnedSkip = false;
  const warn = (message: string): void => emit({ type: 'warning', message });

  function stripInner(call: ToolCall): ToolCall {
    if (call.name !== MULTI_TOOL_NAME) return call;
    const { args, strippedCallIds } = stripInnerMemory(call.args);
    if (strippedCallIds.length > 0) {
      warn(`Ignored memory inside aigent_multi call '${call.id}' (inner calls ${strippedCallIds.map(innerId => `'${innerId}'`).join(', ')}); only the aigent_multi call itself carries memory`);
    }
    return { ...call, args };
  }

  function save(params: { call: ToolCall; notes: MemoryNote[]; invalid: number }): void {
    const { call: { id: callId, name }, notes, invalid } = params;
    pending.push(store.save({ options, request: { agentName, scopeKey, notes, source: { runId, callId, origin: 'tool-call' } } }).then(result => {
      totals.saved += result.saved;
      totals.evicted += result.evicted;
      for (const problem of result.problems) warn(`Memory on call '${callId}' to '${name}': ${problem}`);
      recorder.noteMemory({ callId, saved: result.saved, rejected: invalid + notes.length - result.saved });
    }, (error: unknown) => {
      // save reports its problems in the result; this only guards flush against an unexpected failure.
      warn(`Memory on call '${callId}' to '${name}' was not saved: ${describeError(error)}`);
      recorder.noteMemory({ callId, saved: 0, rejected: invalid + notes.length });
    }));
  }

  function take(call: ToolCall): TakenMemory {
    const { id: callId, name } = call;
    const { args, value, isPresent } = splitMemory(call.args);
    const stripped = stripInner({ ...call, args });
    const nothingHeld: TakenMemory = { call: stripped, admit: () => undefined, settle: () => undefined };
    if (!isPresent) return nothingHeld;
    const { notes, problems } = parseMemoryNotes({ value, maxPerCall: options.maxPerCall });
    for (const problem of problems) warn(`Memory on call '${callId}' to '${name}': ${problem}`);
    const invalid = (Array.isArray(value) ? value.length : 1) - notes.length;
    if (skipReason != null) {
      if (!hasWarnedSkip) warn(`Memory notes are not saved: ${skipReason}`);
      hasWarnedSkip = true;
      recorder.noteMemory({ callId, saved: 0, rejected: invalid + notes.length });
      return nothingHeld;
    }
    if (notes.length === 0) {
      recorder.noteMemory({ callId, saved: 0, rejected: invalid });
      return nothingHeld;
    }
    let isDecided = false;
    return {
      call: stripped,
      admit: () => {
        if (isDecided) return;
        isDecided = true;
        save({ call: stripped, notes, invalid });
      },
      settle: settleOptions => {
        if (isDecided) return;
        isDecided = true;
        // A refused call (unknown tool, invalid arguments, call limit, guardrail, approval) did nothing, so what it claimed is not kept.
        if (settleOptions?.quietly !== true) warn(`Memory on call '${callId}' to '${name}' was not saved: the call was not run`);
        recorder.noteMemory({ callId, saved: 0, rejected: invalid + notes.length });
      },
    };
  }

  async function flush(): Promise<RunMemoryTotals> {
    await Promise.all(pending);
    return { ...totals };
  }

  return { scopeKey, options, take, track: work => { pending.push(work); }, flush };
}
