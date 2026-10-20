import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMPRESSED_COLLECTION } from '../compression/compression-cache.js';
import type { CompressionOptions } from '../compression/compressor-types.js';
import { createBrokenCompressor, fakeCompressor } from '../compression/fake-compressor.js';
import { computePrefixHash } from '../context/prefix-hash.js';
import { createInMemoryStore } from '../store/in-memory-store.js';
import type { Store } from '../store/store-types.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import type { FakeTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { AgentDefinition } from './agent-types.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';

const PERSONA = 'You are a careful research assistant who explains findings in plain words for a general audience every time.';
const CONTEXT = 'The team keeps its notes in a shared folder and reviews the summaries every morning before the stand up meeting starts. '.repeat(4);
const TASK = 'Read the latest notes in the shared folder and write a short summary of the main points for the team to read today. '.repeat(3);
const PROSE_RESULT = 'The meeting covered the budget for the next quarter and the plans for hiring two more people in the support team soon. '.repeat(4);
const COMPRESSION: CompressionOptions = { compressor: fakeCompressor(), minTokens: 10 };

const lookup = defineTool({
  name: 'lookup', description: 'Look up notes', args: z.object({ kind: z.enum(['prose', 'code']) }).strict(), deterministic: false, cache: false, compressible: true,
  describeActivity: () => ({ title: 'lookup' }), run: async ({ kind }) => (kind === 'prose' ? PROSE_RESULT : 'const total = 1;\nexport function run() { return total; }\n'.repeat(5)),
});

interface SetupParams {
  turns?: FakeTurn[];
  definition?: Partial<AgentDefinition>;
  store?: Store;
}

function setup(params: SetupParams = {}) {
  const { turns = [textTurn('done')], definition = {}, store } = params;
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], enableFeedback: false, ...(store == null ? {} : { store }) });
  const agent = ai.agent({ name: 'writer', model: 'fake:m', persona: PERSONA, context: CONTEXT, tools: [lookup], compression: COMPRESSION, ...definition });
  return { provider, ai, agent };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createAigent compression', () => {
  it('previews exactly the system prompt, brief and tools the provider then receives', async () => {
    const { provider, agent } = setup();
    const input = { task: TASK, acceptanceCriteria: ['Mentions every note'] };
    const preview = await agent.preview(input);
    await agent.task(input);
    const [request] = provider.requests;
    expect(request?.messages[0]).toEqual({ role: 'system', text: preview.system });
    expect(request?.messages[1]).toEqual({ role: 'user', text: preview.brief });
    expect(request?.tools).toEqual(preview.tools);
    expect(preview.fields.map(({ field, compressed }) => ({ field, compressed }))).toEqual([
      { field: 'persona', compressed: false }, { field: 'context', compressed: true }, { field: 'task', compressed: true },
    ]);
    expect(preview.fields[1]?.finalTokens).toBeLessThan(preview.fields[1]!.originalTokens);
    expect(preview.totalTokens).toBeGreaterThan(0);
    // Persona is off by default; lists such as acceptance criteria are never compressed.
    expect(preview.system).toContain(PERSONA);
    expect(preview.brief).toContain('- Mentions every note');
  });

  it('previews the agent alone without an input, and rejects an invalid input', async () => {
    const { agent } = setup();
    expect(await agent.preview()).toMatchObject({ brief: '', fields: [expect.objectContaining({ field: 'persona' }), expect.objectContaining({ field: 'context', compressed: true })] });
    await expect(agent.preview({ task: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('keeps the prefix byte-stable across turns and across two runtimes sharing a store (cache hits)', async () => {
    const store = createInMemoryStore();
    const turns = [toolTurn([{ id: 'a', name: 'lookup', args: { kind: 'prose' } }]), textTurn('done')];
    const first = setup({ store, turns });
    await first.agent.task({ task: TASK });
    await first.ai.close();
    const second = setup({ store, turns });
    const result = await second.agent.task({ task: TASK });
    await second.ai.close();
    const [firstRequest, firstNext] = first.provider.requests;
    expect(computePrefixHash(firstNext!.messages.slice(0, 2), [])).toBe(computePrefixHash(firstRequest!.messages.slice(0, 2), []));
    expect(second.provider.requests[0]?.messages.slice(0, 2)).toEqual(firstRequest?.messages.slice(0, 2));
    expect(second.provider.requests[1]?.messages.slice(0, -1)).toEqual(firstNext?.messages.slice(0, -1));
    const trace = await second.ai.trace(result.runId);
    expect(trace?.run.compression?.every(({ cacheHit }) => cacheHit)).toBe(true);
    expect((await store.list(COMPRESSED_COLLECTION)).length).toBeGreaterThanOrEqual(3);
  });

  it('changes the agent version with the compressor version or parameters, and not without compression', () => {
    const { ai } = setup();
    const base: AgentDefinition = { name: 'v', model: 'fake:m', context: CONTEXT };
    const plain = ai.agent(base).agentVersion;
    const compressed = ai.agent({ ...base, compression: COMPRESSION }).agentVersion;
    expect(compressed).not.toBe(plain);
    expect(ai.agent({ ...base, compression: { ...COMPRESSION, compressor: fakeCompressor({ version: '2' }) } }).agentVersion).not.toBe(compressed);
    expect(ai.agent({ ...base, compression: { ...COMPRESSION, targetRatio: 0.3 } }).agentVersion).not.toBe(compressed);
  });

  it('rejects a compressor that drops protected content: warning, original text sent', async () => {
    const { provider, agent } = setup({ definition: { context: `${CONTEXT} You must not share these notes.`, compression: { ...COMPRESSION, compressor: createBrokenCompressor() } } });
    const events = await collect(agent.task({ task: 'Summarise' }));
    expect(events).toContainEqual({ type: 'warning', message: 'Compression of context dropped protected content and was ignored' });
    expect(provider.requests[0]?.messages[0]?.text).toContain('You must not share these notes.');
  });

  it('never compresses tool schemas, directive lines or text under minTokens', async () => {
    const plain = createFakeProvider({ turns: [textTurn('done')] });
    await createAigent({ providers: [plain], enableFeedback: false }).agent({ name: 'writer', model: 'fake:m', tools: [lookup] }).task({ task: 'short' });
    const directive = '::aigent outcome {"success":true,"answer":"keep me"}';
    const { provider, agent } = setup({ definition: { context: `${CONTEXT}\n${directive}\n${CONTEXT}`, compression: { ...COMPRESSION, minTokens: 50 } } });
    await agent.task({ task: 'short' });
    const [request] = provider.requests;
    // Same schemas byte for byte; compressing tool results only adds result_original.
    expect(request?.tools.filter(({ name }) => name !== 'result_original')).toEqual(plain.requests[0]?.tools);
    expect(request?.messages[0]?.text).toContain(directive);
    expect(request?.messages[1]?.text).toBe('# Task\nshort');
  });

  it('compresses compressible prose results when committed, with the original behind a handle; code stays verbatim', async () => {
    const turns = [
      toolTurn([{ id: 'p', name: 'lookup', args: { kind: 'prose' } }, { id: 'c', name: 'lookup', args: { kind: 'code' } }]),
      toolTurn([{ id: 'o', name: 'result_original', args: { handles: ['H1'] } }]),
      textTurn('done'),
    ];
    const { provider, agent } = setup({ turns });
    const run = agent.task({ task: 'Summarise' });
    const events = await collect(run);
    const second = provider.requests[1]!;
    const prose = JSON.parse(second.messages.find(({ toolCallId }) => toolCallId === 'p')!.text!) as { result: string };
    expect(prose.result).toMatch(/\n\[compressed from ~\d+ tokens; full original: result_original handle H1\]$/);
    expect(prose.result.length).toBeLessThan(PROSE_RESULT.length);
    const code = JSON.parse(second.messages.find(({ toolCallId }) => toolCallId === 'c')!.text!) as { result: string };
    expect(code.result).toContain('export function run()');
    expect(code.result).not.toContain('compressed from');
    const original = events.find(event => event.type === 'tool-result' && event.callId === 'o');
    expect(original).toMatchObject({ envelope: { ok: true, result: [{ ok: true, result: { handle: 'H1', text: PROSE_RESULT } }] } });
    // The consumer's tool-result event always carries the uncompressed result.
    expect(events.find(event => event.type === 'tool-result' && event.callId === 'p')).toMatchObject({ envelope: { result: PROSE_RESULT } });
    // result_original is there from the first request, so compressing a result never changes the tool list (the prefix).
    expect(provider.requests[0]?.tools.map(({ name }) => name)).toContain('result_original');
    expect(events.filter(event => event.type === 'warning')).toEqual([]);
  });

  it('records every compression on the run record without any text', async () => {
    const store = createInMemoryStore();
    const { ai, agent } = setup({ store, turns: [toolTurn([{ id: 'p', name: 'lookup', args: { kind: 'prose' } }]), textTurn('done')] });
    const result = await agent.task({ task: TASK });
    await ai.close();
    const compression = (await ai.trace(result.runId))?.run.compression;
    expect(compression?.map(({ field }) => field)).toEqual(['context', 'task', 'toolResult']);
    for (const record of compression ?? []) {
      expect(Object.keys(record).sort()).toEqual(['cacheHit', 'compressedTokens', 'field', 'latencyMs', 'originalTokens', 'ratio']);
      expect(record.compressedTokens).toBeLessThan(record.originalTokens);
    }
  });

  it('runs an A/B evaluation of compression through the agent\'s provider', async () => {
    const { provider, ai } = setup({ turns: [textTurn('same'), textTurn('same'), textTurn('a'), textTurn('b')] });
    const report = await ai.evalCompression({ agent: { name: 'writer', model: 'fake:m', context: CONTEXT, compression: { ...COMPRESSION, compressor: createBrokenCompressor() } }, tasks: [{ task: TASK }, { task: 'Other' }], compressor: fakeCompressor() });
    expect(report.summary).toMatchObject({ tasks: 2, sameStatus: 2, sameAnswer: 1, sameCriteria: 2 });
    expect(report.results[0]).toMatchObject({ task: TASK, isSameAnswer: true, baseline: { status: 'completed', answer: 'same' }, compressed: { answer: 'same' } });
    // The baseline request carries the original context, the compressed one a shorter one.
    expect(provider.requests[1]!.messages[0]!.text!.length).toBeLessThan(provider.requests[0]!.messages[0]!.text!.length);
  });
});
