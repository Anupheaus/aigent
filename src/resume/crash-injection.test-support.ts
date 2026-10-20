import { z } from 'zod';
import type { AgentDefinition } from '../core/agent-types.js';
import { createAigent } from '../core/create-aigent.js';
import type { AigentOptions } from '../core/aigent-types.js';
import type { Provider, ProviderEvent, ProviderRequest } from '../providers/provider-types.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';

/** Where a simulated crash fires. */
export const CRASH_BOUNDARIES = ['mid-stream', 'tool-dispatched', 'mid-batch', 'checkpoint-write', 'ledger-done'] as const;
export type CrashBoundary = typeof CRASH_BOUNDARIES[number];

/** A crash at the `n`-th occurrence (1-based) of a boundary. */
export interface CrashPlan {
  boundary: CrashBoundary;
  n: number;
}

/** The store as a process sees it: after `crash()` nothing it writes reaches the real store (the process is gone). */
export interface CrashableStore {
  store: Store;
  crash(): void;
  isCrashed(): boolean;
}

/** Called before each write; may crash the process first. */
export type WriteHook = (params: { collection: string; value: unknown }) => void;

export function crashableStore(params: { store: Store; beforeWrite?: WriteHook }): CrashableStore {
  const { store, beforeWrite } = params;
  let isCrashed = false;
  const dead = (): never => { throw new Error('simulated crash: the process is gone'); };
  const wrapped: Store = {
    get: (collection, key) => store.get(collection, key),
    list: collection => store.list(collection),
    compareAndSet: async write => {
      beforeWrite?.({ collection: write.collection, value: write.value });
      if (isCrashed) dead();
      return store.compareAndSet(write);
    },
    delete: async (collection, key) => { if (isCrashed) dead(); return store.delete?.(collection, key); },
  };
  return { store: wrapped, crash: () => { isCrashed = true; }, isCrashed: () => isCrashed };
}

export const SCRIPT_ANSWER = 'Saved both notes and read the file.';

/**
 * The scripted model's next move, chosen by which results the request already holds (so a resumed process continues
 * the script): like a real model, it asks again for what a lost part of a response never ran.
 */
function scriptFor(results: ReadonlySet<string>): FakeTurn {
  const first = { id: 'n1', name: 'save_note', args: { text: 'first' } };
  const read = { id: 'r1', name: 'read_file', args: { path: 'a.txt' } };
  if (!results.has('n1')) return toolTurn(results.has('r1') ? [first] : [first, read]);
  if (!results.has('r1')) return toolTurn([read]);
  if (!results.has('n2')) return toolTurn([{ id: 'n2', name: 'save_note', args: { text: 'second' } }]);
  return textTurn(SCRIPT_ANSWER);
}

export interface ScriptedProvider extends Provider {
  requests: ProviderRequest[];
}

/** A deterministic model: its response depends only on the request, never on how many requests came before. */
export function scriptedProvider(params: { onEvent?(params: { request: number; event: ProviderEvent }): void } = {}): ScriptedProvider {
  const { onEvent } = params;
  const requests: ProviderRequest[] = [];
  return {
    id: 'fake', requests,
    capabilities: { streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 128_000, supportedSettings: [] },
    stream: async function* stream(request) {
      requests.push(structuredClone(request));
      const turn = scriptFor(new Set(request.messages.flatMap(({ toolCallId }) => (toolCallId == null ? [] : [toolCallId]))));
      for (const event of turn.events) {
        onEvent?.({ request: requests.length, event });
        yield event;
      }
    },
  };
}

/** The world outside the agent: side effects by idempotency key, and how often each tool body ran. */
export interface World {
  effects: Map<string, string>;
  runs: Map<string, number>;
}

export function createWorld(): World {
  return { effects: new Map(), runs: new Map() };
}

/** `save_note` (side effects, verified by idempotency key) and `read_file` (read-only, re-run on resume). */
export function worldTools(params: { world: World; beforeRun?(tool: string): void }): Tool[] {
  const { world, beforeRun } = params;
  const count = (tool: string): void => { world.runs.set(tool, (world.runs.get(tool) ?? 0) + 1); };
  const saveNote = defineTool({
    name: 'save_note', description: 'Save a note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, resume: 'verify',
    describeActivity: () => ({ title: 'save' }),
    verify: async (_args, { idempotencyKey = '' }) => ({ done: world.effects.has(idempotencyKey), result: world.effects.get(idempotencyKey) }),
    run: async ({ text }, { idempotencyKey = '' }) => {
      count('save_note');
      world.effects.set(idempotencyKey, `saved ${text}`);
      beforeRun?.('save_note');
      return `saved ${text}`;
    },
  });
  const readFile = defineTool({
    name: 'read_file', description: 'Read a file', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false,
    describeActivity: () => ({ title: 'read' }),
    run: async ({ path }) => { count('read_file'); beforeRun?.('read_file'); return `contents of ${path}`; },
  });
  return [saveNote, readFile];
}

export const INSTANCE_ID = 'inst-1';
export const LEASE_TTL_MS = 1_000;

export function definitionFor(tools: Tool[]): AgentDefinition {
  return { name: 'notes', model: 'fake:m', tools, instanceId: INSTANCE_ID, todo: false };
}

/** A runtime over `store` with resume on and a manual clock. */
export function runtimeOver(params: { store: Store; provider: Provider; now(): number; options?: Partial<AigentOptions> }) {
  const { store, provider, now, options = {} } = params;
  return createAigent({ providers: [provider], store, enableFeedback: false, clock: { now }, resume: { lease: { ttlMs: LEASE_TTL_MS } }, ...options });
}

export { createInMemoryStore };
