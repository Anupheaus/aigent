import { z } from 'zod';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createWriteQueue } from '../store/write-queue.js';
import { executeToolCall } from '../tools/execute-tool-call.js';
import type { ExecutedToolCall } from '../tools/execute-tool-call.js';
import { defineTool } from '../tools/define-tool.js';
import type { ToolInput } from '../tools/define-tool.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import type { Tool } from '../tools/tool-types.js';
import { TOOL_CACHE_COLLECTION } from './cache-types.js';
import type { CacheEntry, CacheOptions, ToolCache } from './cache-types.js';
import { createToolCache } from './tool-cache.js';

export const LOOKUP_ARGS = z.object({ path: z.string() }).strict();

export interface CacheHarness {
  store: Store;
  cache: ToolCache;
  advance(ms: number): void;
  now(): number;
}

/** A cache over a fresh in-memory store with a manual clock starting at 1,000 ms. */
export function cacheHarness(options?: CacheOptions): CacheHarness {
  const store = createInMemoryStore();
  let time = 1_000;
  const now = (): number => time;
  const cache = createToolCache({ store, writeQueue: createWriteQueue(), now, ...(options == null ? {} : { options }) });
  return { store, cache, now, advance: ms => { time += ms; } };
}

export interface CountedTool {
  tool: Tool;
  runs(): number;
}

/** A tool that counts its runs; its result is computed by `result` from the arguments and the run number. */
export function countedTool(params: { result?(path: string, run: number): unknown; overrides?: Partial<ToolInput<typeof LOOKUP_ARGS>> }): CountedTool {
  const { result = path => `contents of ${path}`, overrides = {} } = params;
  let runCount = 0;
  const tool = defineTool({
    name: 'read', description: 'Read a file', args: LOOKUP_ARGS, deterministic: true, cache: true,
    describeActivity: ({ path }) => ({ title: `Read ${path}` }),
    run: async ({ path }) => { runCount += 1; return result(path, runCount); },
    ...overrides,
  });
  return { tool, runs: () => runCount };
}

export interface CallParams {
  harness: CacheHarness;
  tool: Tool;
  path: string;
  agentName?: string;
  instanceId?: string;
  runId?: string;
}

let callCounter = 0;

/** Runs one call through `executeToolCall` with the harness's cache. */
export function callTool(params: CallParams): Promise<ExecutedToolCall> {
  const { harness: { cache, now }, tool, path, agentName = 'agent-a', instanceId = 'instance-1', runId = 'run-1' } = params;
  callCounter += 1;
  return executeToolCall({
    registry: createToolRegistry([tool]),
    call: { id: `call-${callCounter}`, name: tool.name, args: { path } },
    context: { agentName, instanceId, runId, signal: new AbortController().signal },
    now,
    cache,
  });
}

/** Every stored cache entry. */
export async function storedEntries(store: Store): Promise<{ key: string; value: CacheEntry }[]> {
  return (await store.list<CacheEntry>(TOOL_CACHE_COLLECTION)).map(({ key, value }) => ({ key, value }));
}
