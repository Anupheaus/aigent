import type { TaskStatus } from '../core/aigent-events.js';
import type { Clock } from '../core/runtime-services.js';
import { createCallLedger } from './call-ledger.js';
import type { CallLedger, LedgerEntry } from './call-ledger.js';
import type { CheckpointBoundary, CheckpointHead, RunState, StoredTaskInput } from './checkpoint-types.js';
import { createCheckpointWriter } from './checkpoint-writer.js';
import type { CheckpointWriterOptions } from './checkpoint-writer.js';
import type { InstanceHandle, ResumeOptions } from './instance-runtime.js';

/** The parts of a run state that change while it runs; the hooks add the fixed ones. */
export type LiveRunState = Omit<RunState, 'kind' | 'runId' | 'agentName' | 'agentVersion' | 'mode' | 'input' | 'sessionId' | 'messageId'>;

/** How a run writes its checkpoints and ledger; created per run when the runtime has `resume`. */
export interface RunCheckpoints {
  /** The checkpoint stream and ledger id (the original run's id when resumed). */
  streamId: string;
  /** Aborts once the instance's lease is lost; the run must then stop and write nothing more. */
  lost: AbortSignal;
  /** What the run does once the lease is lost. */
  onLeaseLost: 'immediate' | 'graceful';
  /** A write was fenced: marks the instance's lease lost (see `InstanceHandle.reportLost`). */
  reportLost(error: unknown): void;
  ledger: CallLedger;
  write(params: { boundary: CheckpointBoundary; live: LiveRunState }): Promise<void>;
  /** Records the run's end: an `end` checkpoint when it ended on its own, only its status when stopped or cancelled. */
  close(params: { status: TaskStatus; live: LiveRunState }): Promise<void>;
}

export interface CreateRunCheckpointsParams {
  instance: InstanceHandle;
  streamId: string;
  agent: { name: string; agentVersion: string };
  mode: 'task' | 'chat';
  input: StoredTaskInput;
  clock: Clock;
  options?: CheckpointWriterOptions & Pick<ResumeOptions, 'onLeaseLost'>;
  sessionId?: string;
  messageId?: string;
  /** A continued stream's head and ledger. */
  head?: CheckpointHead;
  ledger?: LedgerEntry[];
}

/** Statuses after which the run's latest state is kept as it was (resumable when stopped gracefully). */
const STATUS_ONLY: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['stopped', 'cancelled']);

export function createRunCheckpoints(params: CreateRunCheckpointsParams): RunCheckpoints {
  const { instance, streamId, agent, mode, input, clock, options, sessionId, messageId, head, ledger: loaded } = params;
  const writer = createCheckpointWriter({ records: instance.records, store: instance.store, instanceId: instance.instanceId, stream: { kind: 'run', id: streamId }, fence: instance.fence, clock, ...(options == null ? {} : { options }), ...(head == null ? {} : { head }) });
  const ledger = createCallLedger({ records: instance.records, runId: streamId, clock, ...(loaded == null ? {} : { loaded }) });
  const fixed = { kind: 'run' as const, runId: streamId, agentName: agent.name, agentVersion: agent.agentVersion, mode, input, ...(sessionId == null ? {} : { sessionId }), ...(messageId == null ? {} : { messageId }) };
  const note = (status: RunState['status']): Promise<void> => instance.noteRun({ runId: streamId, mode, status, ...(sessionId == null ? {} : { sessionId }) });
  let isNoted = false;
  let lastLive: LiveRunState | undefined;

  async function write(params: { boundary: CheckpointBoundary; live: LiveRunState }): Promise<void> {
    const { boundary, live } = params;
    // The instance lists the run before its first checkpoint, so a restart can always find it.
    if (!isNoted) { await note(live.status); isNoted = true; }
    lastLive = live;
    await writer.write({ boundary, state: { ...fixed, ...structuredClone(live) } });
  }

  return {
    streamId, ledger, write, lost: instance.lost, reportLost: instance.reportLost, onLeaseLost: options?.onLeaseLost ?? 'immediate',
    close: async ({ status, live }) => {
      if (STATUS_ONLY.has(status)) {
        // The state before the stop stays the latest checkpoint; only the status moves on.
        if (lastLive != null && status === 'stopped') await writer.write({ boundary: 'end', state: { ...fixed, ...structuredClone({ ...lastLive, status }) } });
        await note(status);
        return;
      }
      await write({ boundary: 'end', live: { ...live, status } });
      await note(status);
    },
  };
}
