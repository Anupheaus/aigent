import type { ContextMessage } from '../context/context-message.js';
import type { TaskStatus } from '../core/aigent-events.js';
import type { TaskInput } from '../core/task-input.js';
import type { PlanningState } from '../planning/plan-state.js';
import type { ProviderMessage, Usage } from '../providers/provider-types.js';
import type { AliasTableJson } from '../shapers/alias-table.js';

/** Version of every checkpoint record written now; older records are upgraded by `migrateCheckpoint`. */
export const CHECKPOINT_SCHEMA_VERSION = 1;
/** Append-only checkpoint records, keyed `<instanceId>:<runId|sessionId>:<seq padded>`. */
export const CHECKPOINTS_COLLECTION = 'checkpoints';
/** One head per checkpoint stream (`<instanceId>:<runId|sessionId>`): latest seq and the kept snapshots. */
export const CHECKPOINT_HEADS_COLLECTION = 'checkpoint-heads';
/** One call ledger per run (`<runId>`). */
export const CALLS_COLLECTION = 'calls';
/** One lease per agent instance (`<instanceId>`). */
export const LEASES_COLLECTION = 'leases';
/** One record per agent instance (`<instanceId>`): its agent, version, runs and sessions. */
export const INSTANCES_COLLECTION = 'instances';

/** The safe points at which a run or session writes a checkpoint. */
export const CHECKPOINT_BOUNDARIES = ['message', 'turn-complete', 'tool-batch-complete', 'directive', 'question', 'compaction', 'plan', 'approval', 'start', 'end'] as const;

export type CheckpointBoundary = typeof CHECKPOINT_BOUNDARIES[number];

/** A run's input as stored: everything but the live values (`signal`, `onQuestion`), which a resume supplies again. */
export type StoredTaskInput = Omit<TaskInput, 'signal' | 'onQuestion'> & {
  /** The run had a user to ask (`onQuestion`, or a chat), so `ask_user` was among its tools. */
  hasUser?: boolean;
};

/** A run's totals as stored (`RunTotals`). */
export interface StoredTotals {
  usage: Usage;
  turns: number;
  toolCalls: number;
  retries: number;
  fallbacks: number;
  compactionTokens: number;
}

/** The stored messages of a run with what the run learnt about their size (`RunContext` without the id). */
export interface StoredContext {
  messages: ContextMessage[];
  ratio: number;
  peakTokens: number;
  volatileTokens: number;
  /** Messages created so far, so restored ids continue where they stopped. */
  created: number;
}

/** A model response whose tool calls had started when the checkpoint was written (the round is not committed yet). */
export interface InFlightRound {
  /** The turn's number (1-based). */
  turn: number;
  /** The assistant message as it will be committed: visible text, calls, thinking blocks. */
  assistant: ProviderMessage;
}

/** An approval request still waiting for `agent.approve` (see `approvals`). */
export interface PendingApprovalState {
  requestId: string;
  callId: string;
  tool: string;
  args: unknown;
  risk?: 'low' | 'medium' | 'high';
  reason?: string;
  requestedAt: number;
}

/** Whether a run can still be continued, and how it ended otherwise. */
export type RunStateStatus = 'running' | 'suspended' | TaskStatus;

/** Everything needed to rebuild a run at a checkpoint and send the identical next request. */
export interface RunState {
  kind: 'run';
  runId: string;
  agentName: string;
  agentVersion: string;
  mode: 'task' | 'chat';
  status: RunStateStatus;
  input: StoredTaskInput;
  context: StoredContext;
  totals: StoredTotals;
  planning: PlanningState;
  /** `result_original` handles and their texts, in issue order. */
  originals: [string, string][];
  /** Whether `result_original` was in the run's tools. */
  hasResultOriginal: boolean;
  aliasTable?: AliasTableJson;
  inFlight?: InFlightRound;
  approvals: PendingApprovalState[];
  /** Chat turns: the session and the agent message the run streams into. */
  sessionId?: string;
  messageId?: string;
}

/** A chat session at a checkpoint: its patch log is stored by the chat itself; this says where it stands. */
export interface SessionState {
  kind: 'session';
  sessionId: string;
  agentName: string;
  /** Seq of the last patch at the checkpoint. */
  patchSeq: number;
  /** The turn suspended in `ask_user` (or an approval), resumed when its questions are answered. */
  suspended?: { runId: string; callId: string; agentMessageId: string };
}

/** One checkpoint record. */
export interface Checkpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  instanceId: string;
  runId?: string;
  sessionId?: string;
  seq: number;
  boundary: CheckpointBoundary;
  /** Epoch ms. */
  at: number;
  /** The writer's lease fence; a record from a stale owner is never written. */
  fence: number;
  /** A full record. Otherwise `state.context.messages` holds only the messages from `messagesFrom` on. */
  isSnapshot: boolean;
  messagesFrom?: number;
  state: RunState | SessionState;
  /**
   * Set by the reader (never stored) when records between this one and the head are missing: the state is older than
   * the stream's latest, and a resume from it says so.
   */
  stale?: { missingSeq: number; latestSeq: number };
}

/** Where a checkpoint stream stands, read first so a restore reads only the latest snapshot and its tail. */
export interface CheckpointHead {
  instanceId: string;
  streamId: string;
  kind: 'run' | 'session';
  latestSeq: number;
  /** Kept snapshot seqs, oldest first; records before the first were pruned. */
  snapshots: number[];
  /** The latest record's run status (runs only). */
  status?: RunStateStatus;
  updatedAt: number;
}
