import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createAigent } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const RUNS = 7;
const PRICING = { 'fake:m': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } };

/** Each run takes a little longer than the one before, so speed has something to measure. */
function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${String(++counter).padStart(3, '0')}` };
}

const readTool = defineTool({
  name: 'read', description: 'Read a file', args: z.object({ path: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Read ${args.path}` }), run: async args => `contents of ${args.path}`,
});

/** One unbatched run shape: three separate reads in three turns, then the answer. */
function unbatchedRunTurns(): FakeTurn[] {
  return [
    toolTurn([{ id: 'r1', name: 'read', args: { path: 'a.ts' } }]),
    toolTurn([{ id: 'r2', name: 'read', args: { path: 'b.ts' } }]),
    toolTurn([{ id: 'r3', name: 'read', args: { path: 'c.ts' } }]),
    textTurn('Found it in c.ts'),
  ];
}

function setup() {
  const store = createInMemoryStore();
  const turns = Array.from({ length: RUNS }, unbatchedRunTurns).flat();
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, pricing: PRICING, enableFeedback: false });
  const agent = ai.agent({ name: 'finder', model: 'fake:m', tools: [readTool] });
  return { ai, agent, store };
}

describe('ai.report', () => {
  it('scores and reports runs stored by real runs of the FakeProvider', async () => {
    const { ai, agent } = setup();
    const results = [];
    for (let runNumber = 0; runNumber < RUNS; runNumber += 1) results.push(await agent.task({ task: `Find the file, attempt ${runNumber}` }));
    await results[RUNS - 1]?.feedback({ rating: 'incorrect' });

    const report = await ai.report({ agentName: 'finder' });
    expect(report.runCount).toBe(RUNS);
    expect(report.filter).toEqual({ agentName: 'finder', minRuns: 5 });
    expect(report.agents).toHaveLength(1);
    const [agentReport] = report.agents;
    expect(agentReport).toMatchObject({ agentName: 'finder', agentVersion: agent.agentVersion, runs: RUNS, totals: { turns: RUNS * 4, toolCalls: RUNS * 3 } });
    expect(agentReport?.totals.costUsd).toBeGreaterThan(0);
    // Runs 6 and 7 have five earlier runs; the last one was rated incorrect.
    expect(agentReport?.scores.reliability).toMatchObject({ value: 50 });
    expect(agentReport?.scores.speed.value).not.toBeNull();
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'unbatched-repeats', subject: 'read', agentName: 'finder' }));
    // Similar tasks form one request; with feedback off there are no outcomes, so nothing counts as successful and no
    // sequence can be mined, but the back-to-back reads still show as unbatched.
    expect(report.requests).toEqual([expect.objectContaining({ runs: RUNS, successfulRuns: 0, wastedSteps: expect.arrayContaining([{ runId: results[0]?.runId, stepIndex: 1, reason: 'unbatched' }]) })]);
    expect(report.toolSuggestions).toEqual([]);
    // The reads use different paths and the tool is not cached: nothing to report.
    expect(report.cache).toEqual({ hottest: [], hitRateByTool: {}, hitRateByAgent: {}, worthMarkingDeterministic: [], frequentlyInvalidated: [] });
  });

  it('leaves out disableTelemetry runs, filters, and compares versions', async () => {
    const { ai, agent } = setup();
    await agent.task({ task: 'x', label: 'nightly' });
    await agent.task({ task: 'y', disableTelemetry: true });
    expect((await ai.report()).runCount).toBe(1);
    expect((await ai.report({ label: 'other' })).runCount).toBe(0);
    const { comparison } = await ai.report({ compareVersions: [agent.agentVersion, 'v-next'] });
    expect(comparison?.before.runs).toBe(1);
    expect(comparison?.after.runs).toBe(0);
  });

  it('rejects an invalid filter and invalid pricing clearly', async () => {
    const { ai } = setup();
    await expect(ai.report({ minRuns: 0 })).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('minRuns') }));
    await expect(ai.report({ includeDisabled: true } as never)).rejects.toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('includeDisabled') }));
    expect(() => createAigent({ providers: [createFakeProvider({ turns: [] })], pricing: { 'fake:m': { inputPerMTokUsd: -1, outputPerMTokUsd: 1 } } })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('returns an empty report without a store', async () => {
    const ai = createAigent({ providers: [createFakeProvider({ turns: [] })] });
    expect(await ai.report()).toMatchObject({ runCount: 0, agents: [], findings: [] });
  });
});
