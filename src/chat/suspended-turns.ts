import { createAigentError } from '../core/aigent-error.js';
import type { Clock } from '../core/runtime-services.js';
import { loadCallLedger } from '../resume/call-ledger.js';
import { readCheckpointHead, readLatestCheckpoint } from '../resume/checkpoint-reader.js';
import type { PendingApprovalState, SessionState } from '../resume/checkpoint-types.js';
import { createCheckpointWriter } from '../resume/checkpoint-writer.js';
import type { CheckpointWriter } from '../resume/checkpoint-writer.js';
import type { InstanceHandle, InstanceRuntime } from '../resume/instance-runtime.js';
import type { RunRestore } from '../resume/prepare-run-resume.js';
import type { RestoredRun } from '../resume/reconcile-calls.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import { ASK_USER_TOOL_NAME } from '../core/ask-user-name.js';
import type { ConversationState } from './conversation.js';
import type { QuestionResult } from './question-state.js';

/** A turn waiting on an `ask_user` call or an approval: the run (checkpoint stream) to continue and its message. */
export type SuspendedTurn = NonNullable<SessionState['suspended']>;

/** A turn that was waiting for an approval when the session was last open, with the requests its run waits on. */
export interface RestoredApproval {
  turn: SuspendedTurn;
  runId: string;
  states: PendingApprovalState[];
}

/** A chat's suspended turns, kept as session checkpoints so a reopened session can continue them. */
export interface SuspendedTurns {
  /** Reads the session's latest checkpoint (part of `chat.ready`). */
  load(): Promise<void>;
  /** Records that a turn waits on `callId` (and, for an approval, its request); written in the background (tracked). */
  suspend(params: SuspendedTurn & { patchSeq: number }): void;
  /** The suspended turn waiting on `callId`, if one was recorded. */
  find(callId: string): SuspendedTurn | undefined;
  /** How to continue it with these answers as the `ask_user` result. */
  restoreWith(params: { turn: SuspendedTurn; results: QuestionResult[] }): RunRestore;
  /** The loaded turn that was waiting for an approval its run still lists as pending. */
  restoredApproval(): RestoredApproval | undefined;
  /** How to continue a turn once its approval was decided: from its checkpoint, where the gate finds the decision. */
  restoreAfterApproval(turn: SuspendedTurn): RunRestore;
}

export interface CreateSuspendedTurnsParams {
  runtime: InstanceRuntime;
  agent: { name: string; instanceId: string; agentVersion: string };
  sessionId: string;
  clock: Clock;
  track(work: Promise<unknown>): void;
}

/** The answers of one `ask_user` batch, in question order, as the tool would have returned them. */
export function batchResultsFrom(params: { state: ConversationState; callId: string }): QuestionResult[] {
  const { state, callId } = params;
  return state.messages.flatMap(({ kind, meta: { questionMeta } }) => {
    if (kind !== 'question' || questionMeta?.callId !== callId) return [];
    const { questionId: id, answered, answer = null } = questionMeta;
    return [answered ? { id, ok: true, value: answer } : { id, ok: false, value: null, error: 'not answered' }];
  });
}

export function createSuspendedTurns(params: CreateSuspendedTurnsParams): SuspendedTurns {
  const { runtime, agent, sessionId, clock, track } = params;
  const turns = new Map<string, SuspendedTurn>();
  let approval: RestoredApproval | undefined;
  let opened: Promise<{ instance: InstanceHandle; writer: CheckpointWriter }> | undefined;

  const open = (): Promise<{ instance: InstanceHandle; writer: CheckpointWriter }> => {
    opened ??= (async () => {
      const instance = await runtime.open({ instanceId: agent.instanceId, agentName: agent.name, agentVersion: agent.agentVersion });
      const head = await readCheckpointHead({ store: instance.store, instanceId: agent.instanceId, streamId: sessionId });
      const writer = createCheckpointWriter({ records: instance.records, store: instance.store, instanceId: agent.instanceId, stream: { kind: 'session', id: sessionId }, fence: instance.fence, clock, options: runtime.options, ...(head == null ? {} : { head }) });
      return { instance, writer };
    })();
    return opened;
  };

  /** The run's latest checkpoint and ledger, as a resumed turn starts from them. */
  async function loadRun(params: { runId: string; overrides?: ReadonlyMap<string, ToolEnvelope> }): Promise<RestoredRun> {
    const { runId, overrides } = params;
    const { instance } = await open();
    const checkpoint = await readLatestCheckpoint({ store: instance.store, instanceId: agent.instanceId, streamId: runId });
    if (checkpoint?.state.kind !== 'run') throw createAigentError({ code: 'invalid_input', message: `The suspended turn's run '${runId}' has no checkpoint to continue from`, details: { runId, sessionId } });
    return {
      state: checkpoint.state, ledger: await loadCallLedger({ store: instance.store, runId }),
      ...(overrides == null ? {} : { overrides }), ...(checkpoint.stale == null ? {} : { stale: checkpoint.stale }),
    };
  }

  return {
    load: async () => {
      const { instance } = await open();
      const latest = await readLatestCheckpoint({ store: instance.store, instanceId: agent.instanceId, streamId: sessionId });
      const suspended = latest?.state.kind === 'session' ? latest.state.suspended : undefined;
      if (suspended == null) return;
      turns.set(suspended.callId, suspended);
      if (suspended.approvalRequestId == null) return;
      // Only while the run still waits on it: a later checkpoint without the request means it was decided already.
      const run = await readLatestCheckpoint({ store: instance.store, instanceId: agent.instanceId, streamId: suspended.runId });
      const states = run?.state.kind === 'run' ? run.state.approvals : [];
      if (states.some(({ requestId }) => requestId === suspended.approvalRequestId)) approval = { turn: suspended, runId: suspended.runId, states };
    },
    suspend: ({ patchSeq, ...turn }) => {
      turns.set(turn.callId, turn);
      const state: SessionState = { kind: 'session', sessionId, agentName: agent.name, patchSeq, suspended: turn };
      track(open().then(({ writer }) => writer.write({ boundary: turn.approvalRequestId == null ? 'question' : 'approval', state })));
    },
    find: callId => turns.get(callId),
    restoreWith: ({ turn, results }) => {
      const envelope: ToolEnvelope = { id: turn.callId, tool: ASK_USER_TOOL_NAME, ok: true, result: results };
      turns.delete(turn.callId);
      return { streamId: turn.runId, load: () => loadRun({ runId: turn.runId, overrides: new Map([[turn.callId, envelope]]) }) };
    },
    restoredApproval: () => approval,
    restoreAfterApproval: turn => {
      turns.delete(turn.callId);
      approval = undefined;
      return { streamId: turn.runId, load: () => loadRun({ runId: turn.runId }) };
    },
  };
}
