import { describe, expect, it } from 'vitest';
import { createAigent } from '../core/create-aigent.js';
import { createFakeProvider } from '../testing/fake-provider.js';
import { createScheduler } from './scheduler.js';
import { parseSchedulerOptions } from './scheduler-options.js';
import type { SchedulerOptions } from './scheduler-types.js';

interface InvalidCase {
  options: unknown;
  /** Text the message must contain: the failing path and the value it got. */
  names: string;
}

const INVALID: InvalidCase[] = [
  { options: { limits: { p: { maxConcurrent: 0 } } }, names: 'limits.p.maxConcurrent: must be a positive integer (got 0)' },
  { options: { limits: { p: { maxConcurrent: 1.5 } } }, names: 'limits.p.maxConcurrent: must be a positive integer (got 1.5)' },
  { options: { limits: { p: { requestsPerMinute: 0 } } }, names: 'limits.p.requestsPerMinute: must be a positive integer (got 0)' },
  { options: { limits: { 'p:m': { tokensPerMinute: -5 } } }, names: 'limits.p:m.tokensPerMinute: must be a positive integer (got -5)' },
  { options: { defaultLimits: { maxConcurrent: Number.NaN } }, names: 'defaultLimits.maxConcurrent: must be a positive integer (got NaN)' },
  { options: { defaultLimits: { tokensPerMinute: Number.POSITIVE_INFINITY } }, names: 'defaultLimits.tokensPerMinute: must be a positive integer (got Infinity)' },
  { options: { maxBackgroundWaitMs: -1 }, names: 'maxBackgroundWaitMs: must be a non-negative integer (got -1)' },
  { options: { limits: { p: { maxConcurent: 2 } } }, names: "limits.p: unknown key 'maxConcurent'" },
  { options: { limit: {} }, names: "(root): unknown key 'limit'" },
];

describe('parseSchedulerOptions', () => {
  it('accepts valid options and returns them unchanged', () => {
    const clock = { now: () => 0 };
    const options: SchedulerOptions = { limits: { p: { maxConcurrent: 2, requestsPerMinute: 60, tokensPerMinute: 1_000 } }, defaultLimits: {}, maxBackgroundWaitMs: 0, clock };
    expect(parseSchedulerOptions(options)).toBe(options);
  });

  it.each(INVALID)('rejects $options as invalid_definition naming $names', ({ options, names }) => {
    expect(() => parseSchedulerOptions(options as SchedulerOptions)).toThrow(expect.objectContaining({
      code: 'invalid_definition',
      message: expect.stringContaining(names),
    }));
  });

  it('names every failing field in one error', () => {
    expect(() => parseSchedulerOptions({ limits: { p: { maxConcurrent: 0, requestsPerMinute: -1 } } })).toThrow(/maxConcurrent.*; .*requestsPerMinute/);
  });
});

describe('scheduler options validation at the boundaries', () => {
  it('createScheduler throws instead of deadlocking on maxConcurrent 0', () => {
    expect(() => createScheduler({ limits: { p: { maxConcurrent: 0 } } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('createScheduler has invalid options') }));
  });

  it('createAigent throws for invalid scheduler options', () => {
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], scheduler: { defaultLimits: { requestsPerMinute: 0 } } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining('defaultLimits.requestsPerMinute') }));
  });
});
