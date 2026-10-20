import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createAigent } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const RUNS = 3;

function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${String(++counter).padStart(3, '0')}` };
}

const searchTool = defineTool({
  name: 'search', description: 'Search the code', args: z.object({ query: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Search ${args.query}` }), run: async () => ['src/providers/ThemeProvider.tsx'],
});
const readTool = defineTool({
  name: 'read', description: 'Read a file', args: z.object({ path: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Read ${args.path}` }), run: async args => `contents of ${args.path}`,
});

/** search, then read with `previous` reporting the search, then an answer whose directive reports the read. */
function findFileTurns(): FakeTurn[] {
  return [
    toolTurn([{ id: 's1', name: 'search', args: { query: 'ThemeProvider', previous: null } }]),
    toolTurn([{ id: 'r1', name: 'read', args: { path: 'src/providers/ThemeProvider.tsx', previous: { success: true, answer: 'one match' } } }]),
    textTurn('::aigent outcome {"success":true,"answer":"src/providers/ThemeProvider.tsx"}\nIt is src/providers/ThemeProvider.tsx'),
  ];
}

describe('ai.report request analysis', () => {
  it('groups similar tasks and suggests a tool for the recurring path, from real runs', async () => {
    const store = createInMemoryStore();
    const provider = createFakeProvider({ turns: Array.from({ length: RUNS }, findFileTurns).flat() });
    const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, enableFeedback: true });
    const agent = ai.agent({ name: 'finder', model: 'fake:m', tools: [searchTool, readTool] });
    const tasks = ['Find the file that defines ThemeProvider', 'Find which file defines the ThemeProvider', 'find the file defining ThemeProvider?'];
    const results = [];
    for (const task of tasks) results.push(await agent.task({ task }));

    const report = await ai.report();
    expect(report.requests).toHaveLength(1);
    expect(report.requests[0]).toMatchObject({
      sampleTask: 'Find the file that defines ThemeProvider', runs: RUNS, successfulRuns: RUNS,
      cheapestSuccessful: { runId: results[0]?.runId, path: ['search', 'read'] },
      wastedSteps: [],
    });
    expect(report.toolSuggestions).toEqual([expect.objectContaining({
      name: 'search_then_read', replaces: ['search -> read'], supportingRunIds: results.map(({ runId }) => runId).sort(), proposedArgs: [{ name: 'query', type: 'string' }],
    })]);
  });
});
