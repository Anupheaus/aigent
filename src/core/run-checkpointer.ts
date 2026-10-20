import type { RunPlanning } from '../planning/run-planning.js';
import type { LiveRunState, RunCheckpoints } from '../resume/checkpoint-hooks.js';
import type { CheckpointBoundary, InFlightRound, PendingApprovalState, RunStateStatus } from '../resume/checkpoint-types.js';
import type { CallLedger } from '../resume/call-ledger.js';
import type { TaskStatus } from './aigent-events.js';
import type { RunContext } from './run-context.js';
import type { RunOriginals } from './run-originals.js';
import type { RunShaping } from './run-shaping.js';
import type { RunTotals } from './run-turn.js';

/** Writes a run's checkpoints from its live state; every method is a no-op without `resume`. */
export interface RunCheckpointer {
  ledger?: CallLedger;
  /** The id the ledger and idempotency keys use. */
  ledgerRunId?: string;
  /**
   * Writes a checkpoint. `turnsDone` overrides the turn count for boundaries reached after a turn was counted but
   * before its request was sent (a compaction), so a resume does not count that turn twice.
   */
  at(params: { boundary: CheckpointBoundary; inFlight?: InFlightRound; turnsDone?: number; status?: RunStateStatus }): Promise<void>;
  close(status: TaskStatus): Promise<void>;
}

export interface CreateRunCheckpointerParams {
  hooks?: RunCheckpoints;
  context: RunContext;
  totals: RunTotals;
  planning: RunPlanning;
  originals: RunOriginals;
  shaping?: RunShaping;
  /** Approvals waiting for a decision. */
  approvals?(): PendingApprovalState[];
}

export function createRunCheckpointer(params: CreateRunCheckpointerParams): RunCheckpointer {
  const { hooks, context, totals, planning, originals, shaping, approvals } = params;
  if (hooks == null) return { at: async () => undefined, close: async () => undefined };

  function live(params: { inFlight?: InFlightRound; turnsDone?: number; status?: RunStateStatus }): LiveRunState {
    const { inFlight, turnsDone = totals.turns, status = 'running' } = params;
    const { state, ratio, peakTokens, volatileTokens, created } = context;
    const { usage, toolCalls, retries, fallbacks, compactionTokens } = totals;
    return {
      status, context: { messages: state, ratio, peakTokens, volatileTokens, created },
      totals: { usage, turns: turnsDone, toolCalls, retries, fallbacks, compactionTokens },
      planning: planning.state, ...originals.snapshot(),
      ...(shaping == null ? {} : { aliasTable: shaping.state.aliases.toJSON() }),
      approvals: approvals?.() ?? [],
      ...(inFlight == null ? {} : { inFlight }),
    };
  }

  return {
    ledger: hooks.ledger,
    ledgerRunId: hooks.streamId,
    at: ({ boundary, ...rest }) => hooks.write({ boundary, live: live(rest) }),
    close: status => hooks.close({ status, live: live({}) }),
  };
}
