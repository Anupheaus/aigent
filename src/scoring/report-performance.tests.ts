import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { RunTrace } from '../telemetry/run-record.js';
import { fixtureTrace } from './fixtures.test-support.js';
import { readReport } from './read-report.js';
import { buildReport } from './report.js';

/** A large store: reports over it must stay roughly linear. */
const RUN_COUNT = 10_000;
/** Generous for this machine (the target is well under a second), so a slow CI box does not flake. */
const MAX_REPORT_MS = 3_000;
const TOOLS = ['search', 'read', 'read', 'edit', 'read', 'search'];
const TASKS = ['Find the theme file', 'Rename the user service', 'Fix the login bug', 'Add a settings page', 'Update the README'];
const TASK_VARIANTS = 2;

function largeStore(): RunTrace[] {
  return Array.from({ length: RUN_COUNT }, (_, runNumber) => fixtureTrace({
    run: {
      startedAt: runNumber * 10, runId: `run_${runNumber}`, durationMs: 500 + (runNumber % 97) * 10, inputTokens: 1_000 + (runNumber % 31) * 50,
      claimedSuccess: 1, ...(runNumber % 3 === 0 ? {} : { task: `${TASKS[runNumber % TASKS.length]} ${runNumber % TASK_VARIANTS}` }),
      ...(runNumber % 11 === 0 ? { userVerdict: 'incorrect' as const } : {}),
    },
    steps: TOOLS.map((tool, stepNumber) => ({ tool, turn: stepNumber + 1, argsSummary: '{"path":"<string>"}', argsHash: `h${(runNumber + stepNumber) % 50}`, durationMs: 50 + stepNumber })),
  }));
}

describe('buildReport performance', () => {
  it(`reports on ${RUN_COUNT} runs of 6 steps within ${MAX_REPORT_MS} ms`, () => {
    const traces = largeStore();
    const startedAt = performance.now();
    const report = buildReport({ traces, filter: undefined, generatedAt: 0 });
    const elapsedMs = performance.now() - startedAt;
    expect(report.runCount).toBe(RUN_COUNT);
    expect(elapsedMs).toBeLessThan(MAX_REPORT_MS);
  });

  it(`reads and reports ${RUN_COUNT} stored runs (schema parsing included) within ${MAX_REPORT_MS} ms`, async () => {
    const store = createInMemoryStore();
    for (const { run, steps } of largeStore()) {
      const { schemaVersion, runId, agentName, instanceId, mode, agentVersion, recordedAt } = run;
      await store.compareAndSet({ collection: 'runs', key: runId, expectedVersion: undefined, value: run });
      await store.compareAndSet({ collection: 'traces', key: runId, expectedVersion: undefined, value: { schemaVersion, runId, agentName, instanceId, mode, agentVersion, recordedAt, steps } });
    }
    const startedAt = performance.now();
    const report = await readReport({ store, filter: undefined, now: () => 0 });
    const elapsedMs = performance.now() - startedAt;
    expect(report.runCount).toBe(RUN_COUNT);
    expect(elapsedMs).toBeLessThan(MAX_REPORT_MS);
  });
});
