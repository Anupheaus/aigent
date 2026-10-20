import { createHash } from 'node:crypto';
import { createAigentError } from '../core/aigent-error.js';
import { canonicalJson } from '../core/canonical-json.js';
import type { Clock } from '../core/runtime-services.js';
import type { ThinkingBlock } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { ToolErrorDetail } from '../tools/tool-error-detail.js';
import { CALLS_COLLECTION } from './checkpoint-types.js';
import type { CapturedEffect } from '../effects/undo-types.js';

/** One tool call's lifecycle: written `started` before the tool runs, then `done` or `failed` with what it returned. */
export interface LedgerEntry {
  callId: string;
  tool: string;
  args: unknown;
  /** Per-run salted digest of the arguments (see `digest-args`). */
  argsHash: string;
  /** `<runId>:<callId>`, handed to the tool as `ToolContext.idempotencyKey`. */
  idempotencyKey: string;
  /** The turn whose model response made the call. */
  turn: number;
  /** `aigent_multi` inner calls: the wrapper call they belong to (their own `callId` is `<parentCallId>:<innerId>`). */
  parentCallId?: string;
  /**
   * The response's thinking blocks streamed before this call (top-level calls only, when there were any), so a round
   * rebuilt from the ledger after a crash still starts with the signed thinking a provider may require.
   */
  thinkingBlocks?: ThinkingBlock[];
  status: 'started' | 'done' | 'failed';
  /** What the model was (or will be) given for the call, once it finished. */
  envelope?: ToolEnvelope;
  /**
   * The effects the call had, with their undo data: a resumed run records them again when the effect-log write was
   * lost in a crash (effect-log keys are stable, so a write that did happen is not repeated).
   */
  effects?: CapturedEffect[];
  startedAt: number;
  finishedAt?: number;
}

/** The stored ledger of one run. */
export interface CallLedgerRecord {
  runId: string;
  entries: LedgerEntry[];
}

export interface BeginCallParams {
  callId: string;
  tool: string;
  args: unknown;
  argsHash: string;
  turn: number;
  parentCallId?: string;
  thinkingBlocks?: ThinkingBlock[];
}

/** How a call finished: what the model is given, and the effects it had. */
export interface CallOutcome {
  envelope: ToolEnvelope;
  effects?: CapturedEffect[];
}

/** The run's record of every call, so a resumed run never executes a finished call again. */
export interface CallLedger {
  /** Resolves once the `started` entry is stored; the tool must not run before. */
  begin(params: BeginCallParams): Promise<LedgerEntry>;
  complete(callId: string, outcome: CallOutcome): Promise<void>;
  fail(callId: string, error: ToolErrorDetail): Promise<void>;
  get(callId: string): LedgerEntry | undefined;
  /** Every entry, in begin order. */
  entries(): LedgerEntry[];
}

export interface CreateCallLedgerParams {
  /** Writes through the keyed queue and `redact` (over the fenced store when the instance holds a lease). */
  records: RecordWriter;
  runId: string;
  clock: Clock;
  /** A resumed run's stored entries. */
  loaded?: LedgerEntry[];
}

/** sha-256 of the arguments' canonical JSON, so a ledger entry can be matched without comparing values. */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args ?? null)).digest('hex');
}

/** The id an `aigent_multi` inner call has in the ledger and approvals: unique across wrappers, whose inner ids may repeat. */
export function innerLedgerId(params: { parentCallId: string; innerId: string }): string {
  return `${params.parentCallId}:${params.innerId}`;
}

export function idempotencyKeyOf(params: { runId: string; callId: string }): string {
  return `${params.runId}:${params.callId}`;
}

export async function loadCallLedger(params: { store: Store; runId: string }): Promise<LedgerEntry[]> {
  const { store, runId } = params;
  return (await store.get<CallLedgerRecord>(CALLS_COLLECTION, runId))?.value.entries ?? [];
}

export function createCallLedger(params: CreateCallLedgerParams): CallLedger {
  const { records, runId, clock, loaded = [] } = params;
  const byCall = new Map(loaded.map(entry => [entry.callId, entry]));
  const queueKey = `calls:${runId}`;

  /** Stores `entry` in place of (or after) the stored entry for its call; the record write is queued per run. */
  async function store(entry: LedgerEntry): Promise<void> {
    byCall.set(entry.callId, entry);
    await records.update<CallLedgerRecord, LedgerEntry>({
      queueKey, collection: CALLS_COLLECTION, key: runId,
      patch: () => entry,
      merge: ({ current, patch }) => {
        const entries = current?.entries ?? [];
        const index = entries.findIndex(({ callId }) => callId === patch.callId);
        return { runId, entries: index === -1 ? [...entries, patch] : entries.map((existing, position) => (position === index ? patch : existing)) };
      },
    });
  }

  function finish(params: { callId: string; status: 'done' | 'failed'; envelope: ToolEnvelope; effects?: CapturedEffect[] }): Promise<void> {
    const { callId, status, envelope, effects = [] } = params;
    const entry = byCall.get(callId);
    if (entry == null) throw createAigentError({ code: 'invalid_input', message: `Call '${callId}' of run '${runId}' was never begun in the ledger`, details: { runId, callId } });
    return store({ ...entry, status, envelope, ...(effects.length === 0 ? {} : { effects }), finishedAt: clock.now() });
  }

  return {
    begin: async ({ callId, tool, args, argsHash, turn, parentCallId, thinkingBlocks }) => {
      const entry: LedgerEntry = {
        callId, tool, args, argsHash, idempotencyKey: idempotencyKeyOf({ runId, callId }), turn, status: 'started', startedAt: clock.now(),
        ...(parentCallId == null ? {} : { parentCallId }), ...(thinkingBlocks == null ? {} : { thinkingBlocks }),
      };
      await store(entry);
      return entry;
    },
    complete: (callId, { envelope, effects }) => finish({ callId, status: envelope.ok ? 'done' : 'failed', envelope, ...(effects == null ? {} : { effects }) }),
    fail: (callId, error) => finish({ callId, status: 'failed', envelope: { id: callId, tool: byCall.get(callId)?.tool ?? '', ok: false, error } }),
    get: callId => byCall.get(callId),
    entries: () => [...byCall.values()],
  };
}
