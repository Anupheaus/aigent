import { describe, expect, it } from 'vitest';
import { createAigentError } from './aigent-error.js';
import { computeBackoffMs, DEFAULT_RESILIENCE_POLICY, isRetryable, parseResiliencePolicy } from './resilience-policy.js';
import type { ResiliencePolicy } from './resilience-policy.js';

const NO_JITTER: ResiliencePolicy = { ...DEFAULT_RESILIENCE_POLICY, jitter: 0 };
const MIDPOINT = (): number => 0.5;

describe('DEFAULT_RESILIENCE_POLICY', () => {
  it('retries twice from 500 ms up to 20 s with 20% jitter, and falls back only after retryable failures', () => {
    expect(DEFAULT_RESILIENCE_POLICY).toEqual({ maxRetries: 2, baseDelayMs: 500, maxDelayMs: 20_000, jitter: 0.2, fallbackOnNonRetryable: false });
  });
});

describe('computeBackoffMs', () => {
  it('doubles from baseDelayMs per attempt and is capped at maxDelayMs', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map(attempt => computeBackoffMs({ attempt, policy: NO_JITTER, random: MIDPOINT }));
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 20_000, 20_000]);
  });

  it('is monotonic in attempt for a fixed random value', () => {
    for (const randomValue of [0, 0.3, 0.99]) {
      const delays = Array.from({ length: 12 }, (_, attempt) => computeBackoffMs({ attempt, policy: DEFAULT_RESILIENCE_POLICY, random: () => randomValue }));
      delays.slice(1).forEach((delay, index) => expect(delay).toBeGreaterThanOrEqual(delays[index] ?? 0));
    }
  });

  it('keeps jitter within ±jitter of the un-jittered delay', () => {
    expect(computeBackoffMs({ attempt: 1, policy: DEFAULT_RESILIENCE_POLICY, random: () => 0 })).toBeCloseTo(800, 6);
    expect(computeBackoffMs({ attempt: 1, policy: DEFAULT_RESILIENCE_POLICY, random: MIDPOINT })).toBeCloseTo(1_000, 6);
    expect(computeBackoffMs({ attempt: 1, policy: DEFAULT_RESILIENCE_POLICY, random: () => 0.999_999 })).toBeLessThanOrEqual(1_200);
  });

  it('never waits less than retryAfterMs, even when that exceeds maxDelayMs or jitter would lower it', () => {
    expect(computeBackoffMs({ attempt: 0, policy: DEFAULT_RESILIENCE_POLICY, retryAfterMs: 3_000, random: () => 0 })).toBe(3_000);
    expect(computeBackoffMs({ attempt: 0, policy: NO_JITTER, retryAfterMs: 3_000, random: MIDPOINT })).toBe(3_000);
    expect(computeBackoffMs({ attempt: 0, policy: NO_JITTER, retryAfterMs: 60_000, random: MIDPOINT })).toBe(60_000);
    expect(computeBackoffMs({ attempt: 3, policy: NO_JITTER, retryAfterMs: 100, random: MIDPOINT })).toBe(4_000);
  });
});

describe('isRetryable', () => {
  it('accepts only provider_failed errors marked retryable', () => {
    expect(isRetryable(createAigentError({ code: 'provider_failed', message: '503', details: { retryable: true } }))).toBe(true);
    expect(isRetryable(createAigentError({ code: 'provider_failed', message: '401', details: { retryable: false } }))).toBe(false);
    expect(isRetryable(createAigentError({ code: 'provider_failed', message: 'no details' }))).toBe(false);
    expect(isRetryable(createAigentError({ code: 'aborted', message: 'stop', details: { retryable: true } }))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable('text')).toBe(false);
  });
});

describe('parseResiliencePolicy', () => {
  it('fills defaults for missing fields', () => {
    expect(parseResiliencePolicy({ agentName: 'a', resilience: undefined })).toEqual(DEFAULT_RESILIENCE_POLICY);
    expect(parseResiliencePolicy({ agentName: 'a', resilience: { maxRetries: 0, firstEventTimeoutMs: 5_000 } })).toEqual({ ...DEFAULT_RESILIENCE_POLICY, maxRetries: 0, firstEventTimeoutMs: 5_000 });
  });

  it.each([
    [{ maxRetries: -1 }, 'maxRetries'],
    [{ maxRetries: 1.5 }, 'maxRetries'],
    [{ baseDelayMs: -5 }, 'baseDelayMs'],
    [{ jitter: 1.5 }, 'jitter'],
    [{ firstEventTimeoutMs: 0 }, 'firstEventTimeoutMs'],
    [{ retries: 3 }, 'retries'],
    [{ baseDelayMs: 5_000, maxDelayMs: 1_000 }, 'maxDelayMs'],
  ])('rejects %j naming %s', (resilience, field) => {
    expect(() => parseResiliencePolicy({ agentName: 'flaky', resilience })).toThrow(expect.objectContaining({
      code: 'invalid_definition', message: expect.stringMatching(new RegExp(`^Agent 'flaky' has an invalid resilience policy: .*${field}`)),
    }));
  });
});
