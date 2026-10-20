import type { Store } from '../store/store-types.js';
import { RUNS_COLLECTION, TRACES_COLLECTION } from '../telemetry/collections.js';
import type { RunRecord, RunTrace, TraceStep } from '../telemetry/run-record.js';
import { parseRunRecord, parseTraceRecord } from '../telemetry/run-record-schema.js';
import { buildReport } from './report.js';
import type { Pricing, Report, ReportFilter } from './report-types.js';

export interface ReadReportParams {
  store?: Store;
  /** Validated by `buildReport`. */
  filter: ReportFilter | undefined;
  now(): number;
  pricing?: Pricing;
}

/** Parses each stored record, leaving out any that does not match the schema so one bad record cannot sink a report. */
function parseEach<T>(params: { records: { key: string; value: unknown }[]; parse(record: { key: string; value: unknown }): T }): T[] {
  const { records, parse } = params;
  return records.flatMap(record => {
    try {
      return [parse(record)];
    } catch { // a corrupt or foreign record is skipped rather than failing the whole report
      return [];
    }
  });
}

/** Reads every stored run and trace and builds the report (an empty one without a store). */
export async function readReport(params: ReadReportParams): Promise<Report> {
  const { store, filter, now, pricing } = params;
  const pricingField = pricing == null ? {} : { pricing };
  if (store == null) return buildReport({ traces: [], filter, generatedAt: now(), ...pricingField });
  const [storedRuns, storedTraces] = await Promise.all([store.list(RUNS_COLLECTION), store.list(TRACES_COLLECTION)]);
  const runs: RunRecord[] = parseEach({ records: storedRuns, parse: ({ key, value }) => parseRunRecord({ collection: RUNS_COLLECTION, key, value }) });
  const stepsByRun = new Map<string, TraceStep[]>(parseEach({ records: storedTraces, parse: ({ key, value }) => [key, parseTraceRecord({ collection: TRACES_COLLECTION, key, value }).steps] as const }));
  const traces: RunTrace[] = runs.map(run => ({ run, steps: stepsByRun.get(run.runId) ?? [] }));
  return buildReport({ traces, filter, generatedAt: now(), ...pricingField });
}
