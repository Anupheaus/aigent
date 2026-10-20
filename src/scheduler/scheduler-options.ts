import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import type { SchedulerOptions } from './scheduler-types.js';

const POSITIVE_INTEGER = 'must be a positive integer';
const NON_NEGATIVE_INTEGER = 'must be a non-negative integer';
const ROOT_PATH = '(root)';

const positiveInteger = z.number({ error: POSITIVE_INTEGER }).int({ error: POSITIVE_INTEGER }).positive({ error: POSITIVE_INTEGER });

const providerLimitsSchema = z.object({
  maxConcurrent: positiveInteger.optional(),
  requestsPerMinute: positiveInteger.optional(),
  tokensPerMinute: positiveInteger.optional(),
}).strict();

/** `clock` and `sleep` are code, checked by their types only; everything numeric is checked here. */
const schedulerOptionsSchema = z.object({
  limits: z.record(z.string(), providerLimitsSchema).optional(),
  defaultLimits: providerLimitsSchema.optional(),
  clock: z.unknown().optional(),
  sleep: z.unknown().optional(),
  maxBackgroundWaitMs: z.number({ error: NON_NEGATIVE_INTEGER }).int({ error: NON_NEGATIVE_INTEGER }).nonnegative({ error: NON_NEGATIVE_INTEGER }).optional(),
}).strict();

type PathKey = PropertyKey;

function valueAt(params: { input: unknown; path: readonly PathKey[] }): unknown {
  const { input, path } = params;
  return path.reduce<unknown>((value, key) => (value != null && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined), input);
}

function describeReceived(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** One issue as `path: problem (got value)`; unknown keys are named, since a typo would otherwise mean "unlimited". */
function describeIssue(params: { issue: z.core.$ZodIssue; input: unknown }): string {
  const { issue, input } = params;
  const path = issue.path.map(String).join('.') || ROOT_PATH;
  if (issue.code === 'unrecognized_keys') return `${path}: unknown key ${issue.keys.map(key => `'${key}'`).join(', ')}`;
  return `${path}: ${issue.message} (got ${describeReceived(valueAt({ input, path: issue.path }))})`;
}

/**
 * Validates scheduler options, so a limit of 0, a negative or fractional value, NaN or a misspelt key fails loudly
 * instead of deadlocking every request or silently meaning "unlimited". Throws `invalid_definition` naming each bad
 * field and the value it got; returns the options unchanged when they are valid.
 */
export function parseSchedulerOptions(options: SchedulerOptions): SchedulerOptions {
  const result = schedulerOptionsSchema.safeParse(options);
  if (result.success) return options;
  const problems = result.error.issues.map(issue => describeIssue({ issue, input: options })).join('; ');
  throw createAigentError({ code: 'invalid_definition', message: `createScheduler has invalid options: ${problems}`, details: { issues: result.error.issues.length } });
}
