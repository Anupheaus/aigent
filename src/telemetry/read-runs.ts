import type { Store } from '../store/store-types.js';
import { RUNS_COLLECTION, TRACES_COLLECTION } from './collections.js';
import type { RunRecord, RunTrace, TraceStep } from './run-record.js';
import { parseRunRecord, parseTraceRecord } from './run-record-schema.js';

/** Parses each stored record, leaving out any that does not match the schema, so one bad record cannot sink a reader. */
export function parseEach<T>(params: { records: { key: string; value: unknown }[]; parse(record: { key: string; value: unknown }): T }): T[] {
  const { records, parse } = params;
  return records.flatMap(record => {
    try {
      return [parse(record)];
    } catch { // a corrupt or foreign record is skipped rather than failing the whole read
      return [];
    }
  });
}

/** Every stored run record (none without a store). */
export async function readRunRecords(store: Store | undefined): Promise<RunRecord[]> {
  if (store == null) return [];
  return parseEach({ records: await store.list(RUNS_COLLECTION), parse: ({ key, value }) => parseRunRecord({ collection: RUNS_COLLECTION, key, value }) });
}

/** Every stored run with its steps (a run without a stored trace has none). */
export async function readRunTraces(store: Store | undefined): Promise<RunTrace[]> {
  if (store == null) return [];
  const [runs, storedTraces] = await Promise.all([readRunRecords(store), store.list(TRACES_COLLECTION)]);
  const stepsByRun = new Map<string, TraceStep[]>(parseEach({ records: storedTraces, parse: ({ key, value }) => [key, parseTraceRecord({ collection: TRACES_COLLECTION, key, value }).steps] as const }));
  return runs.map(run => ({ run, steps: stepsByRun.get(run.runId) ?? [] }));
}
