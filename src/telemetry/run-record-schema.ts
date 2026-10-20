import { z } from 'zod';
import { TASK_STATUSES } from '../core/aigent-events.js';
import { describeIssues } from '../core/describe-issues.js';
import { createAigentError } from '../core/aigent-error.js';
import { USER_RATINGS } from '../feedback/feedback-records.js';
import { TOOL_ERROR_CATEGORIES } from '../tools/tool-error-detail.js';
import { RUN_RECORD_SCHEMA_VERSION } from './run-record.js';
import type { ResponseIndexRecord } from '../feedback/feedback-records.js';
import type { RunRecord, TraceRecord } from './run-record.js';

const count = z.number().int().nonnegative();
const durationMs = z.number().nonnegative();
/** Settings are stored as sent (or as a `redact` hook left them), so their inner shape is not re-validated here. */
const settingsSchema = z.record(z.string(), z.unknown());

const recordMetaShape = {
  schemaVersion: z.literal(RUN_RECORD_SCHEMA_VERSION),
  runId: z.string().min(1),
  agentName: z.string().min(1),
  instanceId: z.string().min(1),
  mode: z.literal('task'),
  agentVersion: z.string().min(1),
  scope: z.record(z.string(), z.string()).optional(),
  recordedAt: z.number(),
  expiresAt: z.number().optional(),
};

const usageSchema = z.object({
  inputTokens: count, outputTokens: count, cachedTokens: count, turns: count, toolCalls: count,
  toolCallsPerTurn: z.number().nonnegative(), retries: count, fallbacks: count, durationMs,
});

const timingsSchema = z.object({
  startedAt: z.number(),
  firstTokenMs: durationMs.optional(),
  durationMs, modelMs: durationMs, toolMs: durationMs, queuedMs: durationMs,
});

const fallbackSchema = z.object({ model: z.string(), settings: settingsSchema, droppedSettings: z.array(z.string()).optional() });

export const runRecordSchema = z.object({
  ...recordMetaShape,
  responseId: z.string().min(1),
  version: z.string().optional(),
  label: z.string().optional(),
  model: z.string(),
  settings: settingsSchema,
  droppedSettings: z.array(z.string()).optional(),
  runtimeSettings: z.object({ contextSize: z.number().optional(), showThinking: z.boolean().optional() }).optional(),
  fallbacks: z.array(fallbackSchema).optional(),
  unattended: z.boolean(),
  status: z.enum(TASK_STATUSES),
  usage: usageSchema,
  timings: timingsSchema,
  stepCount: count,
  failureCount: count,
  task: z.string().optional(),
  answer: z.string().optional(),
  outcomeSummary: z.object({ claimedSuccess: count, claimedFailure: count }),
  toolUse: z.object({ calls: count, items: count, repeats: count }),
  userVerdict: z.enum(USER_RATINGS).optional(),
});

export const traceStepSchema = z.object({
  index: count,
  turn: count,
  callId: z.string(),
  parentCallId: z.string().optional(),
  tool: z.string(),
  argsSummary: z.string(),
  args: z.unknown().optional(),
  ok: z.boolean(),
  errorCategory: z.enum(TOOL_ERROR_CATEGORIES).optional(),
  errorCode: z.string().optional(),
  itemFailures: count.optional(),
  itemTotal: count.optional(),
  cacheHit: z.boolean().optional(),
  resultBytes: count,
  resultTokens: count,
  truncated: z.boolean(),
  durationMs,
  startedAtMs: z.number(),
  outcome: z.object({ success: z.boolean(), answer: z.string(), source: z.enum(['directive', 'previous']) }).optional(),
});

export const traceRecordSchema = z.object({ ...recordMetaShape, steps: z.array(traceStepSchema) });

const responseIndexSchema = z.object({ ...recordMetaShape, responseId: z.string().min(1) });

interface ParseStoredParams {
  collection: string;
  key: string;
  value: unknown;
}

function invalidStoredRecord(params: ParseStoredParams & { error: z.ZodError }): Error {
  const { collection, key, error } = params;
  return createAigentError({
    code: 'invalid_input',
    message: `Stored record '${collection}/${key}' does not match telemetry schema version ${RUN_RECORD_SCHEMA_VERSION}: ${describeIssues(error)}`,
    details: { collection, key },
  });
}

/** Validates a stored run record; throws `invalid_input` naming the record and every failing field. */
export function parseRunRecord(params: ParseStoredParams): RunRecord {
  const result = runRecordSchema.safeParse(params.value);
  if (!result.success) throw invalidStoredRecord({ ...params, error: result.error });
  return result.data as RunRecord;
}

/** Validates a stored trace record; throws `invalid_input` naming the record and every failing field. */
export function parseTraceRecord(params: ParseStoredParams): TraceRecord {
  const result = traceRecordSchema.safeParse(params.value);
  if (!result.success) throw invalidStoredRecord({ ...params, error: result.error });
  return result.data as TraceRecord;
}

/** Validates a stored `responses` index entry; throws `invalid_input` naming the record and every failing field. */
export function parseResponseIndex(params: ParseStoredParams): ResponseIndexRecord {
  const result = responseIndexSchema.safeParse(params.value);
  if (!result.success) throw invalidStoredRecord({ ...params, error: result.error });
  return result.data as ResponseIndexRecord;
}
