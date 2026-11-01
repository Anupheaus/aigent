import { isCacheEntry } from '../cache/cache-entry.js';
import type { KeyedCacheEntry } from '../cache/cache-findings.js';
import { TOOL_CACHE_COLLECTION } from '../cache/cache-types.js';
import { FEEDBACK_COLLECTION } from '../feedback/feedback-records.js';
import type { AgentFeedbackRecord } from '../feedback/feedback-records.js';
import type { Store } from '../store/store-types.js';
import { parseEach, readRunTraces } from '../telemetry/read-runs.js';
import { parseAgentFeedbackRecord } from '../telemetry/run-record-schema.js';
import { buildReport } from './report.js';
import type { Pricing, Report, ReportFilter } from './report-types.js';

export interface ReadReportParams {
  store?: Store;
  /** Validated by `buildReport`. */
  filter: ReportFilter | undefined;
  now(): number;
  pricing?: Pricing;
}

/** Reads every stored run and trace and builds the report (an empty one without a store). */
export async function readReport(params: ReadReportParams): Promise<Report> {
  const { store, filter, now, pricing } = params;
  const pricingField = pricing == null ? {} : { pricing };
  if (store == null) return buildReport({ traces: [], filter, generatedAt: now(), ...pricingField });
  const [traces, storedFeedback, storedCache] = await Promise.all([readRunTraces(store), store.list(FEEDBACK_COLLECTION), store.list(TOOL_CACHE_COLLECTION)]);
  // The feedback collection also holds user ratings; only agent entries are summarised.
  const agentEntries = storedFeedback.filter(({ value }) => (value as { kind?: unknown } | null)?.kind === 'agent');
  const agentFeedback: AgentFeedbackRecord[] = parseEach({ records: agentEntries, parse: ({ key, value }) => parseAgentFeedbackRecord({ collection: FEEDBACK_COLLECTION, key, value }) });
  const cacheEntries: KeyedCacheEntry[] = storedCache.flatMap(({ key, value }) => (isCacheEntry(value) ? [{ key, value }] : []));
  return buildReport({ traces, agentFeedback, cacheEntries, filter, generatedAt: now(), ...pricingField });
}
