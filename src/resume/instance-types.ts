import type { Clock, Sleeper } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';
import type { LedgerEntry } from './call-ledger.js';
import type { RunState, RunStateStatus } from './checkpoint-types.js';
import type { CheckpointWriterOptions } from './checkpoint-writer.js';

export const DEFAULT_LEASE_TTL_MS = 30_000;

/** `createAigent({ resume })`: checkpoint every run and chat turn so an instance can be restored and continued. */
export interface ResumeOptions extends CheckpointWriterOptions {
  /** One live owner per instance (default `{ ttlMs: 30_000 }`, owner id generated); false turns leases off. */
  lease?: { ttlMs: number; ownerId?: string } | false;
  /**
   * What the instance's runs do once its lease is lost (taken over, or not renewable until it expired): stop at once
   * (`immediate`, the default) or at the next safe boundary (`graceful`). Either way they emit a warning and write no
   * more checkpoints, and the next run re-acquires the lease.
   */
  onLeaseLost?: 'immediate' | 'graceful';
  /**
   * Required with `createAigent({ redact })`: `redacted` passes checkpoints, the call ledger and instance records through
   * `redact`, so a resumed run continues from the redacted prompt (it emits a warning saying so); `raw` stores them
   * unredacted so a resume sends exactly the original prompt. Without `redact` there is nothing to choose.
   */
  checkpointRedaction?: 'redacted' | 'raw';
}

/** One run of an instance, as its instance record lists it. */
export interface InstanceRunEntry {
  runId: string;
  mode: 'task' | 'chat';
  status: RunStateStatus;
  sessionId?: string;
  updatedAt: number;
}

/** What the store knows about an agent instance. */
export interface InstanceRecord {
  instanceId: string;
  agentName: string;
  agentVersion: string;
  runs: InstanceRunEntry[];
  sessions: string[];
  updatedAt: number;
}

/** A run that can be continued, loaded when the instance was opened. */
export interface InterruptedRun {
  state: RunState;
  ledger: LedgerEntry[];
  /** Set when checkpoints after the loaded one are missing (see `Checkpoint.stale`). */
  stale?: { missingSeq: number; latestSeq: number };
}

/** An opened instance: its lease (when on), fenced writes and what was restored. */
export interface InstanceHandle {
  instanceId: string;
  /** The lease's fence (0 without leases). */
  fence(): number;
  /** Aborts (with the reason as `signal.reason`) once the lease is lost; the handle is then closed. */
  lost: AbortSignal;
  /** A write was fenced: the lease is lost even if the heartbeat has not noticed yet. */
  reportLost(error: unknown): void;
  /** The fenced store and a queued, redacted writer over it. */
  store: Store;
  records: RecordWriter;
  /** Interrupted runs (not ended, or stopped gracefully) by run id, newest last. */
  interrupted: Map<string, InterruptedRun>;
  /** Restore warnings (e.g. a new agent version) for the next run to emit. */
  takeWarnings(): string[];
  /** Records a run's status (and the session it belongs to) on the instance record. */
  noteRun(entry: Omit<InstanceRunEntry, 'updatedAt'>): Promise<void>;
  /** Releases the lease and closes the handle (a later open takes the lease again). */
  release(): Promise<void>;
}

export interface CreateInstanceRuntimeParams {
  options: ResumeOptions;
  store: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
  clock: Clock;
  /** Heartbeat timer (unref'd real timers by default, independent of retry sleeps). */
  sleep: Sleeper;
  ownerId: string;
}

export interface InstanceRuntime {
  options: ResumeOptions;
  /** Opens an instance once (lease, then restore); later calls share the result. Rejects `instance_locked`. */
  open(params: { instanceId: string; agentName: string; agentVersion: string }): Promise<InstanceHandle>;
  /** Reads an instance record without opening it. */
  read(instanceId: string): Promise<InstanceRecord | undefined>;
  /** Releases one instance's lease (if open) so another runtime can take it over; a later open takes it again. */
  release(instanceId: string): Promise<void>;
  /** Releases every lease. */
  close(): Promise<void>;
}
