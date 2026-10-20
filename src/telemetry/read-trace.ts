import type { Store } from '../store/store-types.js';
import { RUNS_COLLECTION, TRACES_COLLECTION } from './collections.js';
import type { RunTrace } from './run-record.js';
import { parseRunRecord, parseTraceRecord } from './run-record-schema.js';

export interface ReadTraceParams {
  store?: Store;
  runId: string;
}

/** The stored run and its steps (validated against the schema), or undefined when the run was not stored. */
export async function readTrace(params: ReadTraceParams): Promise<RunTrace | undefined> {
  const { store, runId } = params;
  if (store == null) return undefined;
  const storedRun = await store.get(RUNS_COLLECTION, runId);
  if (storedRun == null) return undefined;
  const run = parseRunRecord({ collection: RUNS_COLLECTION, key: runId, value: storedRun.value });
  const storedTrace = await store.get(TRACES_COLLECTION, runId);
  // A run whose trace write failed still has a record; it simply has no steps to show.
  const steps = storedTrace == null ? [] : parseTraceRecord({ collection: TRACES_COLLECTION, key: runId, value: storedTrace.value }).steps;
  return { run, steps };
}
