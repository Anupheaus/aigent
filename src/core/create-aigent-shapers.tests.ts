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

/** The visible result of the tool message answering `callId` in a request. */
function visibleResult(params: { provider: FakeProvider; request: number; callId: string }): unknown {
  const { provider, request, callId } = params;
  const message = provider.requests[request]?.messages.find(({ role, toolCallId }) => role === 'tool' && toolCallId === callId);
  return (JSON.parse(message!.text!) as { result: unknown }).result;
}

function setup(params: { turns: FakeTurn[]; tools: Tool[]; definition?: Partial<AgentDefinition> }) {
  const { turns, tools, definition = {} } = params;
  const provider = createFakeProvider({ turns });
  const store = createInMemoryStore();
  const ai = createAigent({ providers: [provider], clock: tickingClock(), ids: sequentialIds(), store, enableFeedback: false });
  const agent = ai.agent({ name: 'shaper', model: 'fake:m', tools, ...definition });
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

  it('expands aliases the model writes in arguments before validation and execution', async () => {
    const seenPaths: string[] = [];
    const search = defineTool({
      name: 'search', description: 'Search', args: z.object({ query: z.string() }).strict(), deterministic: false, cache: false,
      contentKind: 'search-hits', fidelity: 'lossy-ok', describeActivity: () => ({ title: 's' }),
      run: async () => ({ hits: [{ path: LONG_PATH, line: 1 }, { path: LONG_PATH, line: 7 }] }),
    });
    const read = defineTool({
      name: 'read', description: 'Read', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, contentKind: 'file-content',
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
