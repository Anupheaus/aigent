import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFakeTime } from './fake-time.test-support.js';
import { createScheduler } from './scheduler.js';
import type { LanePriority } from './scheduler-types.js';

const WINDOW_MS = 60_000;
/** Generous bound on simulated time; every scenario finishes far sooner. */
const MAX_SIMULATED_MS = 10 * 60 * 60_000;
/** Each advance still wakes every sleeper at its own deadline; the step only bounds the loop. */
const STEP_MS = 10_000;

interface SimulatedRequest {
  agentName: string;
  priority: LanePriority;
  estimatedTokens: number;
  durationMs: number;
  startDelayMs: number;
}

const requestArb = fc.record({
  agentName: fc.constantFrom('a', 'b', 'c', 'd'),
  priority: fc.constantFrom<LanePriority>('interactive', 'background'),
  estimatedTokens: fc.integer({ min: 1, max: 400 }),
  durationMs: fc.integer({ min: 0, max: 5_000 }),
  startDelayMs: fc.integer({ min: 0, max: 30_000 }),
});

interface Admission {
  at: number;
  tokens: number;
}

interface SimulationResult {
  maxInFlight: number;
  admissions: Admission[];
  completed: number;
  pendingSleeps: number;
  snapshotInFlight: number;
}

/** Runs every request through one scheduler under a fake clock, holding each lease for its duration. */
async function simulate(params: { requests: SimulatedRequest[]; maxConcurrent?: number; requestsPerMinute?: number; tokensPerMinute?: number }): Promise<SimulationResult> {
  const { requests, maxConcurrent, requestsPerMinute, tokensPerMinute } = params;
  const time = createFakeTime();
  const scheduler = createScheduler({ limits: { p: { maxConcurrent, requestsPerMinute, tokensPerMinute } }, clock: time.clock, sleep: time.sleep, maxBackgroundWaitMs: 20_000 });
  const signal = new AbortController().signal;
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;
  const admissions: Admission[] = [];
  const runs = requests.map(async ({ agentName, priority, estimatedTokens, durationMs, startDelayMs }) => {
    await time.sleep(startDelayMs, signal);
    const lease = await scheduler.acquire({ key: 'p:m', estimatedTokens, priority, agentName, signal });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    admissions.push({ at: time.clock.now(), tokens: estimatedTokens });
    await time.sleep(durationMs, signal);
    inFlight -= 1;
    lease.release();
    completed += 1;
  });
  for (let elapsed = 0; completed < requests.length && elapsed < MAX_SIMULATED_MS; elapsed += STEP_MS) await time.advance(STEP_MS);
  await Promise.all(runs);
  return { maxInFlight, admissions, completed, pendingSleeps: time.pendingSleeps(), snapshotInFlight: scheduler.snapshot().p?.inFlight ?? 0 };
}

function maxInAnyWindow(params: { admissions: Admission[]; measure(admission: Admission): number }): number {
  const { admissions, measure } = params;
  return Math.max(0, ...admissions.map(({ at }) => admissions.filter(other => other.at >= at && other.at < at + WINDOW_MS).reduce((sum, other) => sum + measure(other), 0)));
}

describe('scheduler under load', () => {
  it('property: never exceeds maxConcurrent, completes everything and leaks nothing', async () => {
    await fc.assert(fc.asyncProperty(fc.array(requestArb, { minLength: 1, maxLength: 200 }), fc.integer({ min: 1, max: 5 }), async (requests, maxConcurrent) => {
      const result = await simulate({ requests, maxConcurrent });
      expect(result.maxInFlight).toBeLessThanOrEqual(maxConcurrent);
      expect(result.completed).toBe(requests.length);
      expect(result.pendingSleeps).toBe(0);
      expect(result.snapshotInFlight).toBe(0);
    }), { numRuns: 25 });
  });

  it('property: never exceeds requestsPerMinute or tokensPerMinute in any sliding 60 s window', async () => {
    await fc.assert(fc.asyncProperty(fc.array(requestArb, { minLength: 1, maxLength: 60 }), async requests => {
      const result = await simulate({ requests, requestsPerMinute: 10, tokensPerMinute: 1_500 });
      expect(result.completed).toBe(requests.length);
      expect(maxInAnyWindow({ admissions: result.admissions, measure: () => 1 })).toBeLessThanOrEqual(10);
      expect(maxInAnyWindow({ admissions: result.admissions, measure: ({ tokens }) => tokens })).toBeLessThanOrEqual(1_500);
      expect(result.pendingSleeps).toBe(0);
    }), { numRuns: 25 });
  });
});
