import type { Clock } from '../core/runtime-services.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { ApprovalAuditRecord } from './approval-types.js';

/** Store collection of every approval decision. */
export const APPROVALS_COLLECTION = 'approvals';

/** Appends approval decisions; nothing is kept without a store. */
export interface AuditTrail {
  /** Resolves once the decision is stored (through the keyed queue and `redact`). */
  append(entry: Omit<ApprovalAuditRecord, 'at' | 'recordedAt'>): Promise<void>;
}

export function createAuditTrail(params: { records?: RecordWriter; clock: Clock }): AuditTrail {
  const { records, clock } = params;
  return {
    append: async entry => {
      if (records == null) return;
      const at = clock.now();
      // One record per decision: a request is decided once, so its id keys the record.
      await records.create({ queueKey: `approvals:${entry.instanceId}`, record: { collection: APPROVALS_COLLECTION, key: entry.requestId, value: { ...entry, at, recordedAt: at } } });
    },
  };
}
