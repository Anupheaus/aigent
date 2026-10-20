import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { RunRecord } from '../telemetry/run-record.js';
import type { ReportFilter } from './report-types.js';
import { DEFAULT_MIN_RUNS } from './score.js';

const reportFilterSchema = z.object({
  agentName: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  agentVersion: z.string().min(1).optional(),
  since: z.number().finite().optional(),
  label: z.string().optional(),
  unattended: z.boolean().optional(),
  includeDisabled: z.literal(false, { message: 'disableTelemetry runs are never stored, so includeDisabled can only be false' }).optional(),
  compareVersions: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  minRuns: z.number().int().positive().optional(),
}).strict();

/** Validates `ai.report(filter)` and fills in `minRuns`; throws `invalid_input` naming each bad field. */
export function parseReportFilter(raw: unknown): ReportFilter {
  const result = reportFilterSchema.safeParse(raw ?? {});
  if (!result.success) throw createAigentError({ code: 'invalid_input', message: `Invalid report filter: ${describeIssues(result.error)}` });
  return { minRuns: DEFAULT_MIN_RUNS, ...result.data };
}

/** A version given as the hash or as the definition's human label. */
export function isVersion(params: { run: RunRecord; version: string }): boolean {
  const { run: { agentVersion, version: label }, version } = params;
  return agentVersion === version || label === version;
}

/** Every field the filter sets must match; `compareVersions` and `minRuns` do not select runs. */
export function matchesFilter(params: { run: RunRecord; filter: ReportFilter }): boolean {
  const { run, filter: { agentName, instanceId, agentVersion, since, label, unattended } } = params;
  if (agentName != null && run.agentName !== agentName) return false;
  if (instanceId != null && run.instanceId !== instanceId) return false;
  if (agentVersion != null && !isVersion({ run, version: agentVersion })) return false;
  if (since != null && run.timings.startedAt < since) return false;
  if (label != null && run.label !== label) return false;
  if (unattended != null && run.unattended !== unattended) return false;
  return true;
}
