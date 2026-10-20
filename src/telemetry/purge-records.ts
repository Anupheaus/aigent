import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { PurgeFilter, Store } from '../store/store-types.js';

const purgeFilterSchema = z.object({
  agentName: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  before: z.number().finite().optional(),
}).strict().refine(
  filter => Object.values(filter).some(value => value != null),
  { message: 'give at least one of agentName, runId or before; an empty filter would delete everything' },
);

export interface PurgeRecordsParams {
  store?: Store;
  filter: unknown;
}

function invalid(message: string): Error {
  return createAigentError({ code: 'invalid_input', message });
}

/** Validates the filter and deletes matching records through `Store.purge`; resolves with how many went. */
export async function purgeRecords(params: PurgeRecordsParams): Promise<number> {
  const { store, filter } = params;
  const parsed = purgeFilterSchema.safeParse(filter);
  if (!parsed.success) throw invalid(`Invalid purge filter: ${describeIssues(parsed.error)}`);
  if (store == null) throw invalid('Cannot purge: createAigent was given no store, so nothing was stored');
  if (store.purge == null) throw invalid('Cannot purge: the configured store does not implement purge (an optional Store capability)');
  const purgeFilter: PurgeFilter = parsed.data;
  return store.purge(purgeFilter);
}
