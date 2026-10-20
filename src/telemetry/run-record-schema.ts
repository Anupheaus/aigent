import { z } from 'zod';
import { TASK_STATUSES } from '../core/aigent-events.js';
import { PLAN_STATUSES } from '../streaming/directive-schemas.js';
import { describeIssues } from '../core/describe-issues.js';
import { createAigentError } from '../core/aigent-error.js';
import { AGENT_FEEDBACK_KINDS, USER_RATINGS } from '../feedback/feedback-records.js';
import { TOOL_ERROR_CATEGORIES } from '../tools/tool-error-detail.js';
import { GUARDRAIL_STAGES } from '../guardrails/guardrail-types.js';
import { RUN_RECORD_SCHEMA_VERSION } from './run-record.js';
import type { AgentFeedbackRecord, ResponseIndexRecord } from '../feedback/feedback-records.js';
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
  mode: z.enum(['task', 'chat']),
  agentVersion: z.string().min(1),
  scope: z.record(z.string(), z.string()).optional(),
  recordedAt: z.number(),
  expiresAt: z.number().optional(),
};

const usageSchema = z.object({
  inputTokens: count, outputTokens: count, cachedTokens: count, turns: count, toolCalls: count,
  toolCallsPerTurn: z.number().nonnegative(), retries: count, fallbacks: count, durationMs,
  contextTokensPeak: count.optional(),
  compactions: count.optional(),
  compactionTokens: count.optional(),
  compactionTokensSaved: count.optional(),
});

const timingsSchema = z.object({
  startedAt: z.number(),
  firstTokenMs: durationMs.optional(),
  durationMs, modelMs: durationMs, toolMs: durationMs, queuedMs: durationMs,
});

const guardrailsSchema = z.array(z.object({
  guardrail: z.string(), stage: z.enum(GUARDRAIL_STAGES), action: z.enum(['rewrite', 'block', 'warn', 'error']), code: z.string().optional(), message: z.string(),
  callId: z.string().optional(), isBlocking: z.boolean().optional(),
})).optional();

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
  plan: z.array(z.object({
    id: z.string(), status: z.enum(PLAN_STATUSES), label: z.string().optional(), description: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(), evidence: z.string().optional(),
  })).optional(),
  todo: z.array(z.object({ id: z.string(), status: z.enum(PLAN_STATUSES), label: z.string().optional(), description: z.string().optional() })).optional(),
  compression: z.array(z.object({
    field: z.enum(['persona', 'skillset', 'context', 'task', 'references', 'examples', 'toolResult']),
    originalTokens: count, compressedTokens: count, ratio: z.number().nonnegative(), latencyMs: durationMs, cacheHit: z.boolean(),
  })).optional(),
  guardrails: guardrailsSchema,
  dryRun: z.literal(true).optional(),
  plannedEffects: z.array(z.object({
    tool: z.string(), callId: z.string(), kind: z.string(), target: z.string(), summary: z.string(), before: z.string().optional(), after: z.string().optional(), reversible: z.boolean(),
  })).optional(),
});

export const traceStepSchema = z.object({
  index: count,
  turn: count,
  callId: z.string(),
  parentCallId: z.string().optional(),
  tool: z.string(),
  argsSummary: z.string(),
  argsHash: z.string().optional(),
  args: z.unknown().optional(),
  ok: z.boolean(),
  errorCategory: z.enum(TOOL_ERROR_CATEGORIES).optional(),
  errorCode: z.string().optional(),
  itemFailures: count.optional(),
  itemTotal: count.optional(),
  cacheHit: z.boolean().optional(),
  savedMs: durationMs.optional(),
  shaped: z.array(z.object({ shaper: z.string(), tokensBefore: count, tokensAfter: count })).optional(),
  resultBytes: count,
  resultTokens: count,
  truncated: z.boolean(),
  durationMs,
  startedAtMs: z.number(),
  outcome: z.object({ success: z.boolean(), answer: z.string(), source: z.enum(['directive', 'previous']) }).optional(),
  guardrails: guardrailsSchema,
});

export const traceRecordSchema = z.object({ ...recordMetaShape, steps: z.array(traceStepSchema) });

const responseIndexSchema = z.object({ ...recordMetaShape, responseId: z.string().min(1) });

const agentFeedbackRecordSchema = z.object({
  ...recordMetaShape,
  kind: z.literal('agent'),
  callId: z.string(),
  index: count,
  entry: z.object({ kind: z.enum(AGENT_FEEDBACK_KINDS), text: z.string().optional(), textLength: count.optional(), relatedTool: z.string().optional() }),
});

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

/** Validates a stored `aigent_feedback` entry; throws `invalid_input` naming the record and every failing field. */
export function parseAgentFeedbackRecord(params: ParseStoredParams): AgentFeedbackRecord {
  const result = agentFeedbackRecordSchema.safeParse(params.value);
  if (!result.success) throw invalidStoredRecord({ ...params, error: result.error });
  return result.data as AgentFeedbackRecord;
}
