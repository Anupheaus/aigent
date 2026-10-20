import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { Clock, IdGenerator } from '../core/runtime-services.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import type { WriteQueue } from '../store/write-queue.js';
import { createRecordWriter } from '../telemetry/record-writer.js';
import type { Redact } from '../telemetry/redact.js';
import { createEffectLog } from './effect-log.js';
import type { EffectLog } from './effect-log.js';

const undoOptionsSchema = z.object({ retentionMs: z.number().int().positive().optional() }).strict();

export interface CreateRuntimeEffectLogParams {
  /** The runtime's store; without one the log lives in memory (undo works within the process). */
  store?: Store;
  writeQueue: WriteQueue;
  redact?: Redact;
  clock: Clock;
  ids: IdGenerator;
  /** `createAigent({ undo })`, validated here (throws `invalid_input`). */
  options?: unknown;
}

/** The runtime's effect log, written through the keyed write queue and `redact` like every other record. */
export function createRuntimeEffectLog(params: CreateRuntimeEffectLogParams): EffectLog {
  const { writeQueue, redact, clock, ids, options = {} } = params;
  const parsed = undoOptionsSchema.safeParse(options);
  if (!parsed.success) throw createAigentError({ code: 'invalid_input', message: `Invalid undo options: ${describeIssues(parsed.error)}`, details: { issues: parsed.error.issues.length } });
  const store = params.store ?? createInMemoryStore();
  const { retentionMs } = parsed.data;
  return createEffectLog({ store, writer: createRecordWriter({ store, writeQueue, ...(redact == null ? {} : { redact }) }), clock, ids, ...(retentionMs == null ? {} : { retentionMs }) });
}
