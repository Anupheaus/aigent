import { createAigentError } from '../core/aigent-error.js';
import type { Clock } from '../core/runtime-services.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { ApprovalAuditRecord } from './approval-types.js';

/** Store collection of every approval decision. */
export const APPROVALS_COLLECTION = 'approvals';

/** Appends approval decisions; nothing is kept without a store. */
export interface AuditTrail {
  /** Resolves once the decision is stored (through the keyed queue and `redact`). */
  append(entry: Omit<ApprovalAuditRecord, 'at' | 'recordedAt' | 'sequence'>): Promise<void>;
}

/** Decisions kept per request: far more than a request ever gets (aborted, then decided after a restore, ...). */
const MAX_DECISIONS_PER_REQUEST = 100;

export function createAuditTrail(params: { records?: RecordWriter; clock: Clock }): AuditTrail {
  const { records, clock } = params;
  return {
    append: async entry => {
      if (records == null) return;
      const at = clock.now();
      // Append-only, one record per decision: `<requestId>:<n>`, the next free sequence number, so a later decision on
      // the same request (e.g. after an aborted wait and a restore) never replaces or loses an earlier one.
      for (let sequence = 1; sequence <= MAX_DECISIONS_PER_REQUEST; sequence += 1) {
        const record = { collection: APPROVALS_COLLECTION, key: `${entry.requestId}:${sequence}`, value: { ...entry, sequence, at, recordedAt: at } };
        if (await records.create({ queueKey: `approvals:${entry.instanceId}`, record })) return;
      }
      throw createAigentError({ code: 'store_failed', message: `Approval request '${entry.requestId}' already has ${MAX_DECISIONS_PER_REQUEST} audit records; this decision was not stored`, details: { requestId: entry.requestId } });
    },
  };
}
