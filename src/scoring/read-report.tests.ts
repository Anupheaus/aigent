import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { fixtureRun, fixtureSteps } from './fixtures.test-support.js';
import { readReport } from './read-report.js';

describe('readReport', () => {
  it('joins runs to their stored steps and skips records that do not match the schema', async () => {
    const store = createInMemoryStore();
    const run = fixtureRun({ startedAt: 1 });
    await store.compareAndSet({ collection: 'runs', key: run.runId, expectedVersion: undefined, value: run });
    await store.compareAndSet({ collection: 'runs', key: 'corrupt', expectedVersion: undefined, value: { runId: 'corrupt' } });
    const { schemaVersion, agentName, instanceId, mode, agentVersion, recordedAt } = run;
    const steps = fixtureSteps([{ tool: 'read' }, { tool: 'read' }, { tool: 'read', truncated: true }, { tool: 'read', truncated: true }]);
    await store.compareAndSet({ collection: 'traces', key: run.runId, expectedVersion: undefined, value: { schemaVersion, runId: run.runId, agentName, instanceId, mode, agentVersion, recordedAt, steps } });
    const report = await readReport({ store, filter: undefined, now: () => 42 });
    expect(report).toMatchObject({ generatedAt: 42, runCount: 1 });
    expect(report.findings.map(({ kind }) => kind)).toContain('truncation-frequent');
  });

  it('builds an empty report without a store', async () => {
    expect(await readReport({ filter: { agentName: 'a' }, now: () => 1 })).toMatchObject({ runCount: 0, filter: { agentName: 'a', minRuns: 5 } });
  });
});
