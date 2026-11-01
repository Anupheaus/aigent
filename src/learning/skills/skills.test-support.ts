import { z } from 'zod';
import { fixtureTrace } from '../../scoring/fixtures.test-support.js';
import type { FixtureStepParams } from '../../scoring/fixtures.test-support.js';
import type { RunTrace } from '../../telemetry/run-record.js';
import { resultHash, resultLeaves } from '../../telemetry/result-leaves.js';
import { defineTool } from '../../tools/define-tool.js';
import type { Tool } from '../../tools/tool-types.js';
import type { Store } from '../../store/store-types.js';

/** What each run of the fixture looked up: a query, the file it found, the name that file mentions, and that name's file. */
export interface LookupRun {
  query: string;
  firstPath: string;
  mention: string;
  secondPath: string;
}

export const LOOKUPS: LookupRun[] = [
  { query: 'login handler', firstPath: 'src/auth/login.ts', mention: 'hashPassword', secondPath: 'src/auth/hash.ts' },
  { query: 'invoice total', firstPath: 'src/billing/invoice.ts', mention: 'sumLines', secondPath: 'src/billing/lines.ts' },
  { query: 'retry policy', firstPath: 'src/net/retry.ts', mention: 'backoffMs', secondPath: 'src/net/backoff.ts' },
  { query: 'cache key', firstPath: 'src/cache/key.ts', mention: 'hashArgs', secondPath: 'src/cache/hash.ts' },
];

/** The results the fixture's tools return; the traces record their leaves exactly as the trace recorder would. */
export function searchResult(path: string): { matches: { path: string; line: number }[] } {
  return { matches: [{ path, line: 1 }] };
}

export function readResult(params: { path: string; mention?: string }): { path: string; mentions: string } {
  return { path: params.path, mentions: params.mention ?? 'nothing' };
}

function step(params: { tool: string; args: Record<string, unknown>; result: unknown; isSuccess?: boolean }): FixtureStepParams {
  const { tool, args, result, isSuccess } = params;
  return { tool, args, argsSummary: JSON.stringify(args), resultLeaves: resultLeaves(result), resultHash: resultHash(result), ...(isSuccess == null ? {} : { outcome: { success: isSuccess, answer: '', source: 'previous' } }) };
}

/** One run of "search -> read -> search -> read": the second search looks for the name the first file mentions. */
export function lookupTrace(params: { index: number; lookup: LookupRun }): RunTrace {
  const { index, lookup: { query, firstPath, mention, secondPath } } = params;
  return fixtureTrace({
    run: { startedAt: index * 100, runId: `run_${index}`, task: `where is the ${query} implemented` },
    steps: [
      step({ tool: 'search', args: { query, root: 'src' }, result: searchResult(firstPath) }),
      step({ tool: 'read', args: { path: firstPath }, result: readResult({ path: firstPath, mention }) }),
      step({ tool: 'search', args: { query: mention, root: 'src' }, result: searchResult(secondPath) }),
      step({ tool: 'read', args: { path: secondPath }, result: readResult({ path: secondPath }), isSuccess: true }),
    ],
  });
}

export function lookupTraces(count = LOOKUPS.length): RunTrace[] {
  return LOOKUPS.slice(0, count).map((lookup, index) => lookupTrace({ index: index + 1, lookup }));
}

/** `search` and `read` over a fixed map of files, plus a `write` with side effects; each counts its runs. */
export function lookupTools(): { tools: Tool[]; calls: string[] } {
  const calls: string[] = [];
  const pathFor = new Map(LOOKUPS.flatMap(({ query, firstPath, mention, secondPath }) => [[query, firstPath], [mention, secondPath]] as const));
  const mentionFor = new Map(LOOKUPS.map(({ firstPath, mention }) => [firstPath, mention]));
  const knownPaths = new Set(LOOKUPS.flatMap(({ firstPath, secondPath }) => [firstPath, secondPath]));
  const search = defineTool({
    name: 'search', description: 'Search files', args: z.object({ query: z.string(), root: z.string() }).strict(), deterministic: true, cache: false,
    describeActivity: ({ query }) => ({ title: `Searching ${query}` }),
    run: async ({ query }) => { calls.push(`search:${query}`); return searchResult(pathFor.get(query) ?? 'none'); },
  });
  const read = defineTool({
    name: 'read', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: true, cache: false,
    describeActivity: ({ path }) => ({ title: `Reading ${path}` }),
    run: async ({ path }) => {
      calls.push(`read:${path}`);
      if (!knownPaths.has(path)) throw new Error(`No file ${path}`);
      const mention = mentionFor.get(path);
      return readResult({ path, ...(mention == null ? {} : { mention }) });
    },
  });
  const write = defineTool({
    name: 'write', description: 'Write a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
    describeActivity: ({ path }) => ({ title: `Writing ${path}` }),
    run: async ({ path }) => { calls.push(`write:${path}`); return { written: path }; },
    dryRun: async ({ path }) => [{ kind: 'write', target: path, summary: `would write ${path}`, reversible: false }],
  });
  return { tools: [search, read, write], calls };
}

/** Stores the fixture runs and traces as the runtime would have written them, for `ai.skills.distil` to read. */
export async function storeTraces(params: { store: Store; traces: RunTrace[] }): Promise<void> {
  const { store, traces } = params;
  for (const { run, steps } of traces) {
    const { schemaVersion, runId, agentName, instanceId, mode, agentVersion, recordedAt } = run;
    await store.compareAndSet({ collection: 'runs', key: runId, expectedVersion: undefined, value: run });
    await store.compareAndSet({ collection: 'traces', key: runId, expectedVersion: undefined, value: { schemaVersion, runId, agentName, instanceId, mode, agentVersion, recordedAt, steps } });
  }
}
