import { parseMemoryNotes } from '../memory/memory-schema.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ResolvedMemoryOptions } from '../memory/memory-types.js';
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

/** One run's side of memory: the `memory` field taken out of calls and saved behind the agent's other writes. */
export interface RunMemory {
  /** The run's scope key (see `memoryScopeKey`). */
  scopeKey: string;
  options: ResolvedMemoryOptions;
  /** The call without `memory` (also taken out of `aigent_multi` inner calls); its notes are queued, never awaited. */
  take(call: ToolCall): ToolCall;
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

  function take(call: ToolCall): ToolCall {
    const { id: callId, name } = call;
    const { args, value, isPresent } = splitMemory(call.args);
    const stripped = stripInner({ ...call, args });
    if (!isPresent) return stripped;
    const { notes, problems } = parseMemoryNotes({ value, maxPerCall: options.maxPerCall });
    for (const problem of problems) warn(`Memory on call '${callId}' to '${name}': ${problem}`);
    const invalid = (Array.isArray(value) ? value.length : 1) - notes.length;
    if (skipReason != null) {
      if (!hasWarnedSkip) warn(`Memory notes are not saved: ${skipReason}`);
      hasWarnedSkip = true;
      recorder.noteMemory({ callId, saved: 0, rejected: invalid + notes.length });
      return stripped;
    }
    if (notes.length === 0) {
      recorder.noteMemory({ callId, saved: 0, rejected: invalid });
      return stripped;
    }
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
    return stripped;
  }

  async function flush(): Promise<RunMemoryTotals> {
    await Promise.all(pending);
    return { ...totals };
  }

  return { scopeKey, options, take, track: work => { pending.push(work); }, flush };
}
