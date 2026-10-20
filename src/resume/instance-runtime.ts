import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import type { Clock, Sleeper } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';
import { loadCallLedger } from './call-ledger.js';
import type { LedgerEntry } from './call-ledger.js';
import { readLatestCheckpoint } from './checkpoint-reader.js';
import { INSTANCES_COLLECTION } from './checkpoint-types.js';
import type { RunState, RunStateStatus } from './checkpoint-types.js';
import type { CheckpointWriterOptions } from './checkpoint-writer.js';
import { createFencedStore } from './fencing-store.js';
import { acquireLease } from './lease.js';
import type { Lease } from './lease.js';

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
}

export interface CreateInstanceRuntimeParams {
  options: ResumeOptions;
  store: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
  clock: Clock;
  /** Heartbeat timer (real timers by default, independent of retry sleeps). */
  sleep: Sleeper;
  ownerId: string;
}

export interface InstanceRuntime {
  options: ResumeOptions;
  /** Opens an instance once (lease, then restore); later calls share the result. Rejects `instance_locked`. */
  open(params: { instanceId: string; agentName: string; agentVersion: string }): Promise<InstanceHandle>;
  /** Reads an instance record without opening it. */
  read(instanceId: string): Promise<InstanceRecord | undefined>;
  /** Releases every lease. */
  close(): Promise<void>;
}

/** Statuses a run can be continued from. */
const RESUMABLE: ReadonlySet<RunStateStatus> = new Set<RunStateStatus>(['running', 'suspended', 'stopped']);

export function createInstanceRuntime(params: CreateInstanceRuntimeParams): InstanceRuntime {
  const { options, store, writeQueue, redact, clock, sleep, ownerId } = params;
  const opened = new Map<string, Promise<InstanceHandle>>();
  const leases: Lease[] = [];

  async function loadInterrupted(record: InstanceRecord | undefined): Promise<Map<string, InterruptedRun>> {
    const interrupted = new Map<string, InterruptedRun>();
    for (const { runId, status, mode } of record?.runs ?? []) {
      if (mode !== 'task' || !RESUMABLE.has(status)) continue;
      const checkpoint = await readLatestCheckpoint({ store, instanceId: record?.instanceId ?? '', streamId: runId });
      if (checkpoint?.state.kind === 'run') interrupted.set(runId, { state: checkpoint.state, ledger: await loadCallLedger({ store, runId }) });
    }
    return interrupted;
  }

  async function openInstance(params: { instanceId: string; agentName: string; agentVersion: string }): Promise<InstanceHandle> {
    const { instanceId, agentName, agentVersion } = params;
    const { lease: leaseOptions = { ttlMs: DEFAULT_LEASE_TTL_MS } } = options;
    const lostController = new AbortController();
    const onLost = (error: unknown): void => {
      // The handle is closed: the next run (or open) of this instance takes the lease again, or fails instance_locked.
      opened.delete(instanceId);
      const index = leases.findIndex(held => held === lease);
      if (index !== -1) leases.splice(index, 1);
      lostController.abort(`the lease of agent instance '${instanceId}' was lost: ${describeError(error)}`);
    };
    const lease: Lease | undefined = leaseOptions === false ? undefined : await acquireLease({ store, instanceId, ownerId: leaseOptions.ownerId ?? ownerId, ttlMs: leaseOptions.ttlMs, clock, sleep, onLost });
    if (lease != null) leases.push(lease);
    const fence = (): number => lease?.fence ?? 0;
    const fenced = createFencedStore({ store, instanceId, fence });
    const records = createRecordWriter({ store: fenced, writeQueue, ...(redact == null ? {} : { redact }) });
    const record = (await store.get<InstanceRecord>(INSTANCES_COLLECTION, instanceId))?.value;
    if (record != null && record.agentName !== agentName) {
      throw createAigentError({ code: 'invalid_input', message: `Instance '${instanceId}' belongs to agent '${record.agentName}', not '${agentName}'`, details: { instanceId, agentName: record.agentName } });
    }
    const warnings = record != null && record.agentVersion !== agentVersion ? [`Agent instance '${instanceId}' was stored by agent version ${record.agentVersion}; restoring it with version ${agentVersion}`] : [];
    const queueKey = `instance:${instanceId}`;
    const update = (change: (current: InstanceRecord) => InstanceRecord): Promise<InstanceRecord> => records.update<InstanceRecord, InstanceRecord>({
      queueKey, collection: INSTANCES_COLLECTION, key: instanceId,
      patch: current => change(current ?? { instanceId, agentName, agentVersion, runs: [], sessions: [], updatedAt: clock.now() }),
      merge: ({ patch }) => patch,
    });
    await update(current => ({ ...current, agentVersion, updatedAt: clock.now() }));
    return {
      instanceId, fence, lost: lostController.signal, reportLost: error => { if (!lostController.signal.aborted) { void lease?.release(); onLost(error); } }, store: fenced, records, interrupted: await loadInterrupted(record),
      takeWarnings: () => warnings.splice(0),
      noteRun: async entry => {
        const at = clock.now();
        await update(current => ({
          ...current, updatedAt: at,
          runs: [...current.runs.filter(({ runId }) => runId !== entry.runId), { ...entry, updatedAt: at }],
          sessions: entry.sessionId == null || current.sessions.includes(entry.sessionId) ? current.sessions : [...current.sessions, entry.sessionId],
        }));
      },
    };
  }

  return {
    options,
    open: instance => {
      const existing = opened.get(instance.instanceId);
      if (existing != null) return existing;
      const opening = openInstance(instance);
      opened.set(instance.instanceId, opening);
      // A failed open (instance_locked) is retried by the next caller.
      opening.catch(() => { if (opened.get(instance.instanceId) === opening) opened.delete(instance.instanceId); });
      return opening;
    },
    read: async instanceId => (await store.get<InstanceRecord>(INSTANCES_COLLECTION, instanceId))?.value,
    close: async () => {
      await Promise.all(leases.splice(0).map(lease => lease.release()));
      opened.clear();
    },
  };
}
