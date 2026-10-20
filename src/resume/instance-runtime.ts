import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import { loadCallLedger } from './call-ledger.js';
import { readLatestCheckpoint } from './checkpoint-reader.js';
import { INSTANCES_COLLECTION } from './checkpoint-types.js';
import type { RunStateStatus } from './checkpoint-types.js';
import { createFencedStore } from './fencing-store.js';
import { DEFAULT_LEASE_TTL_MS } from './instance-types.js';
import type { CreateInstanceRuntimeParams, InstanceHandle, InstanceRecord, InstanceRuntime, InterruptedRun } from './instance-types.js';
import { acquireLease } from './lease.js';
import type { Lease } from './lease.js';

export { DEFAULT_LEASE_TTL_MS } from './instance-types.js';
export type { CreateInstanceRuntimeParams, InstanceHandle, InstanceRecord, InstanceRunEntry, InstanceRuntime, InterruptedRun, ResumeOptions } from './instance-types.js';

/** Statuses a run can be continued from. */
const RESUMABLE: ReadonlySet<RunStateStatus> = new Set<RunStateStatus>(['running', 'suspended', 'stopped']);

interface OpenParams {
  instanceId: string;
  agentName: string;
  agentVersion: string;
}

/** The lease side of an open instance: its fence, its lost signal, and how it ends. */
interface HeldLease {
  fence(): number;
  lost: AbortSignal;
  markLost(error: unknown): void;
  release(): Promise<void>;
}

export function createInstanceRuntime(params: CreateInstanceRuntimeParams): InstanceRuntime {
  const { options, store, writeQueue, redact, clock, sleep, ownerId } = params;
  const opened = new Map<string, Promise<InstanceHandle>>();
  const leases = new Set<Lease>();

  async function loadInterrupted(record: InstanceRecord | undefined): Promise<Map<string, InterruptedRun>> {
    const interrupted = new Map<string, InterruptedRun>();
    for (const { runId, status, mode } of record?.runs ?? []) {
      if (mode !== 'task' || !RESUMABLE.has(status)) continue;
      const checkpoint = await readLatestCheckpoint({ store, instanceId: record?.instanceId ?? '', streamId: runId });
      if (checkpoint?.state.kind === 'run') interrupted.set(runId, { state: checkpoint.state, ledger: await loadCallLedger({ store, runId }), ...(checkpoint.stale == null ? {} : { stale: checkpoint.stale }) });
    }
    return interrupted;
  }

  /** Takes the instance's lease (when leases are on); losing it closes the handle, so the next open takes it again. */
  async function holdLease(instanceId: string): Promise<HeldLease> {
    const { lease: leaseOptions = { ttlMs: DEFAULT_LEASE_TTL_MS } } = options;
    const lostController = new AbortController();
    let lease: Lease | undefined;
    const forget = (): void => {
      if (lease != null) leases.delete(lease);
      opened.delete(instanceId);
    };
    const markLost = (error: unknown): void => {
      if (lostController.signal.aborted) return;
      forget();
      // The heartbeat may not have noticed yet (a fenced write did): it is stopped too.
      void lease?.release();
      lostController.abort(`the lease of agent instance '${instanceId}' was lost: ${describeError(error)}`);
    };
    if (leaseOptions !== false) {
      lease = await acquireLease({ store, instanceId, ownerId: leaseOptions.ownerId ?? ownerId, ttlMs: leaseOptions.ttlMs, clock, sleep, onLost: markLost });
      leases.add(lease);
    }
    const held = lease;
    return { fence: () => held?.fence ?? 0, lost: lostController.signal, markLost, release: async () => { forget(); await held?.release(); } };
  }

  async function openWithLease(params: OpenParams & { held: HeldLease }): Promise<InstanceHandle> {
    const { instanceId, agentName, agentVersion, held: { fence, lost, markLost, release } } = params;
    const fenced = createFencedStore({ store, instanceId, fence });
    const records = createRecordWriter({ store: fenced, writeQueue, ...(redact == null || options.checkpointRedaction === 'raw' ? {} : { redact }) });
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
      instanceId, fence, lost, reportLost: markLost, release, store: fenced, records, interrupted: await loadInterrupted(record),
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

  async function openInstance(params: OpenParams): Promise<InstanceHandle> {
    const held = await holdLease(params.instanceId);
    try {
      return await openWithLease({ ...params, held });
    } catch (error) {
      // A failed open must not keep the instance locked (or its heartbeat running) until the process ends.
      await held.release();
      throw error;
    }
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
    release: async instanceId => {
      const handle = await opened.get(instanceId)?.catch(() => undefined);
      await handle?.release();
    },
    close: async () => {
      const held = [...leases];
      leases.clear();
      await Promise.all(held.map(lease => lease.release()));
      opened.clear();
    },
  };
}
