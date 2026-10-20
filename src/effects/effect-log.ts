import type { Clock, IdGenerator } from '../core/runtime-services.js';
import type { Store } from '../store/store-types.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import { EFFECTS_COLLECTION } from './undo-types.js';
import type { CapturedEffect, EffectLogEntry } from './undo-types.js';

/** The append-only effect log (collection `effects`): every mutating call, and every undo applied to one. */
export interface EffectLog {
  /**
   * Appends a mutating call's effect under `effectId`; resolves once it is stored (through the keyed write queue and
   * `redact`). An effect already stored under that id is kept as it is, so recording one again is harmless.
   */
  append(params: { effect: CapturedEffect; effectId: string; agentName: string; instanceId: string; runId: string }): Promise<void>;
  /** Appends the record of an undo and marks the effect it applied to. */
  recordUndo(params: { effect: EffectLogEntry; ok: boolean; message?: string }): Promise<void>;
  /** The agent's `effect` entries. */
  effects(agentName: string): Promise<EffectLogEntry[]>;
}

export interface CreateEffectLogParams {
  store: Store;
  writer: RecordWriter;
  clock: Clock;
  ids: IdGenerator;
  /** `undo: { retentionMs }`: stamped on each effect as `expiresAt`. */
  retentionMs?: number;
}

export function createEffectLog(params: CreateEffectLogParams): EffectLog {
  const { store, writer, clock, ids, retentionMs } = params;
  let sequence = 0;
  /** Effects this process undid: undone even when recording that failed, so a later undo never applies them twice. */
  const applied = new Set<string>();
  const queueKey = (agentName: string): string => `effects:${agentName}`;

  async function put(entry: EffectLogEntry): Promise<void> {
    await writer.create({ queueKey: queueKey(entry.agentName), record: { collection: EFFECTS_COLLECTION, key: entry.effectId, value: entry } });
  }

  return {
    append: async ({ effect: { callId, tool, descriptor, descriptorHash, message }, effectId, agentName, instanceId, runId }) => {
      const at = clock.now();
      sequence += 1;
      await put({
        effectId, kind: 'effect', agentName, instanceId, runId, callId, tool, at, sequence,
        status: descriptor == null ? 'unavailable' : 'available',
        ...(descriptor == null ? {} : { descriptor }), ...(descriptorHash == null ? {} : { descriptorHash }), ...(message == null ? {} : { message }),
        ...(retentionMs == null ? {} : { expiresAt: at + retentionMs }),
      });
    },
    recordUndo: async ({ effect, ok, message }) => {
      const status = ok ? 'undone' : 'undo_failed';
      if (ok) applied.add(effect.effectId);
      await writer.update<EffectLogEntry, Partial<EffectLogEntry>>({
        queueKey: queueKey(effect.agentName), collection: EFFECTS_COLLECTION, key: effect.effectId,
        patch: () => ({ status, ...(message == null ? {} : { message }) }),
        merge: ({ current, patch }) => ({ ...(current ?? effect), ...patch }),
      });
      sequence += 1;
      const { agentName, instanceId, runId, callId, tool, effectId } = effect;
      await put({ effectId: ids.next('effect'), kind: 'undo', agentName, instanceId, runId, callId, tool, at: clock.now(), sequence, status, undoOf: effectId, ...(message == null ? {} : { message }) });
    },
    effects: async agentName => (await store.list<EffectLogEntry>(EFFECTS_COLLECTION)).map(({ value }) => value)
      .filter(entry => entry.kind === 'effect' && entry.agentName === agentName)
      .map(entry => (applied.has(entry.effectId) ? { ...entry, status: 'undone' as const } : entry)),
  };
}
