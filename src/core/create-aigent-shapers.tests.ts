import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VERBATIM_CORPUS } from '../shapers/verbatim-corpus.test-support.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { TraceRecord } from '../telemetry/run-record.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeProvider, FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { AgentDefinition } from './agent-types.js';
import { createAigent } from './create-aigent.js';
import type { Clock, IdGenerator } from './runtime-services.js';

const NOISY = '\u001b[32mok\u001b[0m\nretry\nretry\nretry\ndone   ';
const LONG_PATH = 'src/components/theme/ThemeProvider.tsx';

function tickingClock(): Clock {
  let current = 1_000;
  return { now: () => { current += 1; return current; } };
}

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const shellTool = defineTool({
  name: 'sh', description: 'Run a command', args: z.object({ command: z.string() }).strict(), deterministic: false, cache: false,
  contentKind: 'command-output', fidelity: 'lossy-ok', describeActivity: ({ command }) => ({ title: command }), run: async () => NOISY,
});

/** Most calls one aigent_multi call takes. */
const MAX_MULTI_CALLS = 20;

/** Paths with their corpus index, in aigent_multi-sized batches. */
function multiBatches(names: string[]): { path: string; index: number }[][] {
  const indexed = names.map((path, index) => ({ path, index }));
  return Array.from({ length: Math.ceil(indexed.length / MAX_MULTI_CALLS) }, (_unused, batch) => indexed.slice(batch * MAX_MULTI_CALLS, (batch + 1) * MAX_MULTI_CALLS));
}

/** A lossy-ok search whose repeated long path becomes alias F1 in the run's table. */
const aliasingSearch = defineTool({
  name: 'search', description: 'Search', args: z.object({ query: z.string() }).strict(), deterministic: false, cache: false,
  contentKind: 'search-hits', fidelity: 'lossy-ok', describeActivity: () => ({ title: 's' }),
  run: async () => ({ hits: [{ path: LONG_PATH, line: 1 }, { path: LONG_PATH, line: 7 }] }),
});

/** The visible result of the tool message answering `callId` in a request. */
function visibleResult(params: { provider: FakeProvider; request: number; callId: string }): unknown {
  const { provider, request, callId } = params;
  const message = provider.requests[request]?.messages.find(({ role, toolCallId }) => role === 'tool' && toolCallId === callId);
  return (JSON.parse(message!.text!) as { result: unknown }).result;
}

/** A window large enough for the whole verbatim corpus several times over. */
const CORPUS_CONTEXT_SIZE = 4_000_000;

function setup(params: { turns: FakeTurn[]; tools: Tool[]; definition?: Partial<AgentDefinition> }) {
  const { turns, tools, definition = {} } = params;
  const provider = createFakeProvider({ turns });
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, enableFeedback: false });
  // The corpus holds a 1 MiB file, sent twice (read, then written back): far beyond the fake provider's window, which
  // compaction would rightly refuse with context_overflow. These tests are about bytes, not budgets.
  const agent = ai.agent({ name: 'shaper', model: 'fake:m', tools, modelSettings: { contextSize: CORPUS_CONTEXT_SIZE }, ...definition });
  return { ai, agent, provider, store };
}

describe('createAigent shaper pipeline', () => {
  it('shapes lossy-ok results, records the sizes on the step, and returns the original through result_original', async () => {
    const { agent, provider, store } = setup({
      tools: [shellTool],
      turns: [toolTurn([{ id: 'c1', name: 'sh', args: { command: 'build' } }]), toolTurn([{ id: 'c2', name: 'result_original', args: { handles: ['H1'] } }]), textTurn('done')],
    });
    const result = await agent.task({ task: 'build' });
    expect(provider.requests[0]?.tools.map(({ name }) => name)).toContain('result_original');
    expect(visibleResult({ provider, request: 1, callId: 'c1' })).toEqual({
      result: 'ok\nretry (x3)\ndone',
      shaping: [{ shaper: 'strip-noise', note: expect.any(String), handle: 'H1' }, { shaper: 'fold-repeats', note: expect.any(String), handle: 'H1' }],
    });
    expect(visibleResult({ provider, request: 2, callId: 'c2' })).toEqual([{ index: 0, ok: true, result: { handle: 'H1', text: NOISY } }]);
    const { steps } = (await store.get<TraceRecord>('traces', result.runId))!.value;
    expect(steps[0]?.shaped).toEqual([
      { shaper: 'strip-noise', tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) },
      { shaper: 'fold-repeats', tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) },
    ]);
    // Telemetry sizes are the full result's, before shaping.
    expect(steps[0]?.resultBytes).toBe(Buffer.byteLength(JSON.stringify(NOISY)));
  });

  it('does not register result_original without a lossy-ok tool, or with shapers off', async () => {
    const plain = defineTool({ name: 'echo', description: 'Echo', args: z.object({}).strict(), deterministic: true, cache: false, describeActivity: () => ({ title: 'e' }), run: async () => 'x' });
    const withoutLossy = setup({ tools: [plain], turns: [textTurn('done')] });
    await withoutLossy.agent.task({ task: 'x' });
    expect(withoutLossy.provider.requests[0]?.tools.map(({ name }) => name)).not.toContain('result_original');
    const off = setup({ tools: [shellTool], definition: { shapers: 'off' }, turns: [toolTurn([{ id: 'c1', name: 'sh', args: { command: 'b' } }]), textTurn('done')] });
    await off.agent.task({ task: 'x' });
    expect(off.provider.requests[0]?.tools.map(({ name }) => name)).not.toContain('result_original');
    expect(visibleResult({ provider: off.provider, request: 1, callId: 'c1' })).toBe(NOISY);
  });

  it('lets a task narrow the shapers with an allow list, over the agent default', async () => {
    const { agent, provider } = setup({ tools: [shellTool], turns: [toolTurn([{ id: 'c1', name: 'sh', args: { command: 'b' } }]), textTurn('done')] });
    await agent.task({ task: 'x', shapers: { allow: ['fold-repeats'] } });
    expect(visibleResult({ provider, request: 1, callId: 'c1' })).toEqual({
      result: '\u001b[32mok\u001b[0m\nretry (x3)\ndone   ',
      shaping: [{ shaper: 'fold-repeats', note: expect.any(String), handle: 'H1' }],
    });
  });

  it('rejects unknown shaper names on agents and tasks', () => {
    const { ai, agent } = setup({ tools: [shellTool], turns: [] });
    expect(() => ai.agent({ name: 'bad', model: 'fake:m', shapers: { allow: ['nope'] } })).toThrow(expect.objectContaining({ code: 'invalid_definition', message: expect.stringContaining("unknown shaper 'nope'") }));
    expect(() => agent.task({ task: 'x', shapers: { allow: ['nope'] } })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('expands aliases the model writes in arguments of a tool that accepts them, before validation and execution', async () => {
    const seenPaths: string[] = [];
    const search = defineTool({
      name: 'search', description: 'Search', args: z.object({ query: z.string() }).strict(), deterministic: false, cache: false,
      contentKind: 'search-hits', fidelity: 'lossy-ok', describeActivity: () => ({ title: 's' }),
      run: async () => ({ hits: [{ path: LONG_PATH, line: 1 }, { path: LONG_PATH, line: 7 }] }),
    });
    const read = defineTool({
      name: 'read', description: 'Read', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, contentKind: 'file-content', acceptsAliases: true,
      describeActivity: () => ({ title: 'r' }), run: async ({ path }) => { seenPaths.push(path); return 'file'; },
    });
    const { agent, provider } = setup({
      tools: [search, read],
      turns: [toolTurn([{ id: 'c1', name: 'search', args: { query: 'theme' } }]), toolTurn([{ id: 'c2', name: 'read', args: { path: 'F1' } }]), textTurn('done')],
    });
    await agent.task({ task: 'find' });
    expect(visibleResult({ provider, request: 1, callId: 'c1' })).toMatchObject({ result: { hits: [{ path: 'F1', line: 1 }, { path: 'F1', line: 7 }] } });
    expect(seenPaths).toEqual([LONG_PATH]);
  });

  it('never expands an alias for a tool that did not opt in: press_key F1 gets F1 (review C2)', async () => {
    const pressed: string[] = [];
    const pressKey = defineTool({
      name: 'press_key', description: 'Press a key', args: z.object({ key: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
      describeActivity: () => ({ title: 'k' }), run: async ({ key }) => { pressed.push(key); return 'ok'; },
    });
    const { agent } = setup({
      tools: [aliasingSearch, pressKey],
      turns: [toolTurn([{ id: 'c1', name: 'search', args: { query: 'x' } }]), toolTurn([{ id: 'c2', name: 'press_key', args: { key: 'F1' } }]), textTurn('done')],
    });
    await agent.task({ task: 'press' });
    expect(pressed).toEqual(['F1']);
  });

  it('never expands an alias in plan_complete: plan item F1 is found (review C2)', async () => {
    const { agent } = setup({
      tools: [aliasingSearch],
      turns: [
        toolTurn([{ id: 'c1', name: 'search', args: { query: 'x' } }]),
        toolTurn([{ id: 'c2', name: 'plan_complete', args: { updates: [{ id: 'F1', status: 'done', evidence: 'shipped' }] } }]),
        textTurn('done'),
      ],
    });
    const result = await agent.task({ task: 'plan', plan: [{ id: 'F1', label: 'Feature 1', description: 'Ship it', acceptanceCriteria: ['shipped'] }] });
    expect(result.plan).toEqual([expect.objectContaining({ id: 'F1', status: 'done' })]);
    expect(result.errors).toEqual([]);
  });

  it('expands only exact issued aliases, and inside aigent_multi only for inner tools that opt in (review C2)', async () => {
    const seen: string[] = [];
    const read = defineTool({
      name: 'read', description: 'Read', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, acceptsAliases: true,
      describeActivity: () => ({ title: 'r' }), run: async ({ path }) => { seen.push(`read:${path}`); return 'file'; },
    });
    const note = defineTool({
      name: 'note', description: 'Note', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
      describeActivity: () => ({ title: 'n' }), run: async ({ text }) => { seen.push(`note:${text}`); return 'ok'; },
    });
    const { agent } = setup({
      tools: [aliasingSearch, read, note],
      turns: [
        toolTurn([{ id: 'c1', name: 'search', args: { query: 'x' } }]),
        toolTurn([{
          id: 'm1', name: 'aigent_multi', args: { calls: [
            { id: 'i1', tool: 'read', args: { path: 'F1' } },
            { id: 'i2', tool: 'read', args: { path: 'F9' } },
            { id: 'i3', tool: 'read', args: { path: 'see F1' } },
            { id: 'i4', tool: 'note', args: { text: 'F1' } },
          ] },
        }]),
        textTurn('done'),
      ],
    });
    await agent.task({ task: 'multi' });
    expect(seen.sort()).toEqual([`read:${LONG_PATH}`, 'read:F9', 'read:see F1', 'note:F1'].sort());
  });

  it('verbatim corpus end to end with a populated alias table: misses, cache hits inside aigent_multi and writes are byte-identical (review I7)', async () => {
    const disk = new Map(Object.entries(VERBATIM_CORPUS));
    const written: { path: string; content: string }[] = [];
    // A real file tool: cached, verbatim, and its path argument is a reference the alias legend may cover.
    const readFile = defineTool({
      name: 'read_file', description: 'Read', args: z.object({ path: z.string() }).strict(), deterministic: true, cache: true, contentKind: 'file-content', acceptsAliases: true,
      describeActivity: () => ({ title: 'r' }), run: async ({ path }) => disk.get(path),
    });
    // Its content argument is literal data, so it does not opt in to aliases.
    const writeFile = defineTool({
      name: 'write_file', description: 'Write', args: z.object({ path: z.string(), content: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
      describeActivity: () => ({ title: 'w' }), run: async ({ path, content }) => { written.push({ path, content }); return 'ok'; },
    });
    const names = Object.keys(VERBATIM_CORPUS);
    const { agent, provider, store } = setup({
      tools: [aliasingSearch, readFile, writeFile],
      turns: [
        toolTurn([{ id: 's1', name: 'search', args: { query: 'theme' } }]),
        toolTurn(names.map((path, index) => ({ id: `r${index}`, name: 'read_file', args: { path } }))),
        // aigent_multi takes at most 20 calls, so the corpus is read back in batches.
        toolTurn(multiBatches(names).map((batch, batchIndex) => ({ id: `m${batchIndex}`, name: 'aigent_multi', args: { calls: batch.map(({ path, index }) => ({ id: `i${index}`, tool: 'read_file', args: { path } })) } }))),
        toolTurn(names.map((path, index) => ({ id: `w${index}`, name: 'write_file', args: { path, content: VERBATIM_CORPUS[path] } }))),
        textTurn('done'),
      ],
    });
    const result = await agent.task({ task: 'touch every file' });
    // The alias table really holds F1, so any expansion bug would show below.
    expect(visibleResult({ provider, request: 1, callId: 's1' })).toMatchObject({ result: { hits: [{ path: 'F1' }, { path: 'F1' }] } });
    const multi = multiBatches(names).flatMap((_batch, batchIndex) => visibleResult({ provider, request: 3, callId: `m${batchIndex}` }) as { id: string; ok: boolean; result: unknown }[]);
    names.forEach((path, index) => {
      expect(visibleResult({ provider, request: 2, callId: `r${index}` })).toBe(VERBATIM_CORPUS[path]);
      expect(multi[index]).toEqual({ id: `i${index}`, tool: 'read_file', ok: true, result: VERBATIM_CORPUS[path] });
    });
    expect(written).toEqual(names.map(path => ({ path, content: VERBATIM_CORPUS[path] })));
    const { steps } = (await store.get<TraceRecord>('traces', result.runId))!.value;
    const innerHits = steps.filter(({ parentCallId, cacheHit }) => parentCallId?.startsWith('m') === true && cacheHit === true);
    // Every file under maxEntryBytes is served from the cache the second time; the 1 MiB one is never cached.
    expect(innerHits).toHaveLength(names.length - 1);
  });

  it('read-edit round trip: a verbatim file tool shows the model exactly the bytes on disk, and writing them back changes nothing', async () => {
    const disk = new Map(Object.entries(VERBATIM_CORPUS));
    const readFile = defineTool({
      name: 'read_file', description: 'Read', args: z.object({ path: z.string() }).strict(), deterministic: true, cache: true, contentKind: 'file-content',
      describeActivity: () => ({ title: 'r' }), run: async ({ path }) => disk.get(path),
    });
    const writeFile = defineTool({
      name: 'write_file', description: 'Write', args: z.object({ path: z.string(), content: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true,
      describeActivity: () => ({ title: 'w' }), run: async ({ path, content }) => { disk.set(path, content); return 'ok'; },
    });
    const names = Object.keys(VERBATIM_CORPUS);
    const { agent, provider } = setup({
      tools: [readFile, writeFile, shellTool],
      turns: [
        toolTurn(names.map((path, index) => ({ id: `r${index}`, name: 'read_file', args: { path } }))),
        toolTurn(names.map((path, index) => ({ id: `w${index}`, name: 'write_file', args: { path, content: VERBATIM_CORPUS[path] } }))),
        textTurn('done'),
      ],
    });
    await agent.task({ task: 'touch every file' });
    names.forEach((path, index) => {
      expect(visibleResult({ provider, request: 1, callId: `r${index}` })).toBe(VERBATIM_CORPUS[path]);
      expect(disk.get(path)).toBe(VERBATIM_CORPUS[path]);
    });
  });
});
