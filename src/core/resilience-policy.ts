import { z } from 'zod';
import { createAigentError, isAigentError } from './aigent-error.js';
import { describeIssues } from './describe-issues.js';

/** How provider calls are retried, timed out and handed to fallback models. */
export interface ResiliencePolicy {
  /** Retries per model after a retryable failure before any event arrived (0 disables retrying). */
  maxRetries: number;
  /** First retry delay in ms; doubles for each further retry. */
  baseDelayMs: number;
  /** Longest delay in ms before jitter (a server's `retry-after` may still ask for longer). */
  maxDelayMs: number;
  /** Fails an attempt (retryably) when no event arrives within this many ms of the request starting. */
  firstEventTimeoutMs?: number;
  /** Random spread applied to each delay, as a fraction: 0.2 means ±20%. */
  jitter: number;
  /** Also move to the next fallback model after a non-retryable failure (e.g. 400 or 401). Default false. */
  fallbackOnNonRetryable: boolean;
}

export const DEFAULT_RESILIENCE_POLICY: ResiliencePolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: 0.2,
  fallbackOnNonRetryable: false,
};

const BACKOFF_GROWTH = 2;

const partialPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  firstEventTimeoutMs: z.number().int().positive().optional(),
  jitter: z.number().min(0).max(1).optional(),
  fallbackOnNonRetryable: z.boolean().optional(),
}).strict();

export interface ParseResiliencePolicyParams {
  agentName: string;
  resilience: unknown;
}

function invalidPolicy(params: { agentName: string; reason: string }): Error {
  const { agentName, reason } = params;
  return createAigentError({ code: 'invalid_definition', message: `Agent '${agentName}' has an invalid resilience policy: ${reason}`, details: { agentName } });
}

/** Validates an agent's partial policy and fills the rest from `DEFAULT_RESILIENCE_POLICY`; throws `invalid_definition`. */
export function parseResiliencePolicy(params: ParseResiliencePolicyParams): ResiliencePolicy {
  const { agentName, resilience } = params;
  if (resilience === undefined) return DEFAULT_RESILIENCE_POLICY;
  const result = partialPolicySchema.safeParse(resilience);
  if (!result.success) throw invalidPolicy({ agentName, reason: describeIssues(result.error) });
  const defined = Object.fromEntries(Object.entries(result.data).filter(([, value]) => value !== undefined));
  const policy: ResiliencePolicy = { ...DEFAULT_RESILIENCE_POLICY, ...defined };
  if (policy.maxDelayMs < policy.baseDelayMs) {
    throw invalidPolicy({ agentName, reason: `maxDelayMs (${policy.maxDelayMs}) must be at least baseDelayMs (${policy.baseDelayMs})` });
  }
  return policy;
}

export interface ComputeBackoffParams {
  /** 0 for the first retry. */
  attempt: number;
  policy: ResiliencePolicy;
  /** The server's requested wait, a floor on the result. */
  retryAfterMs?: number;
  /** Uniform in [0, 1). */
  random(): number;
}

/** `min(maxDelayMs, max(retryAfterMs, baseDelayMs * 2^attempt))` with ±jitter, never below `retryAfterMs`. */
export function computeBackoffMs(params: ComputeBackoffParams): number {
  const { attempt, policy: { baseDelayMs, maxDelayMs, jitter }, retryAfterMs = 0, random } = params;
  const delay = Math.min(maxDelayMs, Math.max(retryAfterMs, baseDelayMs * BACKOFF_GROWTH ** attempt));
  // random() * 2 - 1 spreads the factor evenly over [1 - jitter, 1 + jitter).
  const jittered = delay * (1 + jitter * (random() * 2 - 1));
  return Math.max(retryAfterMs, jittered);
}

/** A `provider_failed` error the provider marked `retryable` (5xx, 408/409/429, dropped streams, timeouts). Never an abort. */
export function isRetryable(error: unknown): boolean {
  return isAigentError(error) && error.code === 'provider_failed' && error.details?.retryable === true;
}

/** The server's requested wait from a `provider_failed` error, when it sent one. */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (!isAigentError(error)) return undefined;
  const retryAfterMs = error.details?.retryAfterMs;
  return typeof retryAfterMs === 'number' ? retryAfterMs : undefined;
}
