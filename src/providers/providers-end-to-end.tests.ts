// End to end: `createAigent` drives the tool loop through each real adapter, with HTTP served by fixture SSE bodies.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAigent } from '../core/create-aigent.js';
import type { Agent } from '../core/agent-types.js';
import type { ModelSettings } from '../core/model-settings.js';
import type { Clock, IdGenerator } from '../core/runtime-services.js';
import { defineTool } from '../tools/define-tool.js';
import { anthropic } from './anthropic.js';
import {
  anthropicSse, interleavedToolUseBlocks, messageDelta, messageStart, messageStop, redactedThinkingBlock, textBlock, textBlockStart, textDelta,
  thinkingBlock,
} from './anthropic-fixtures.test-support.js';
import type { AnthropicEventFixture, AnthropicUsageFixture } from './anthropic-fixtures.test-support.js';
import { byteChunks, createFakeBody, createFakeFetch, encodeText } from './fake-fetch.test-support.js';
import type { FakeBody, FakeResponseSpec, RecordedRequest } from './fake-fetch.test-support.js';
import { openAiCompatible } from './openai-compatible.js';
import { finishChunk, interleavedToolCallChunks, sseBody, sseBodyWithoutDone, textChunk, usageChunk } from './openai-fixtures.test-support.js';
import type { OpenAiUsageFixture } from './openai-fixtures.test-support.js';
import type { Provider, ToolCall, Usage } from './provider-types.js';

/** Bytes per network chunk: small enough to cut SSE lines and JSON mid-way. */
const NETWORK_CHUNK_BYTES = 7;
const MODEL = 'test-model';
const clock: Clock = { now: () => 1_000 };

function sequentialIds(): IdGenerator {
  let counter = 0;
  return { next: prefix => `${prefix}_${++counter}` };
}

const echoTool = defineTool({
  name: 'echo', description: 'Echo text', args: z.object({ text: z.string() }).strict(),
  deterministic: true, cache: false, describeActivity: args => ({ title: `Echo ${args.text}` }), run: async args => args.text,
});

/** One valid call and one whose `text` is a number, so the loop records exactly one validation failure. */
const PARALLEL_CALLS: ToolCall[] = [
  { id: 'call_valid', name: 'echo', args: { text: 'hi' } },
  { id: 'call_invalid', name: 'echo', args: { text: 5 } },
];
const MULTI_CALL: ToolCall = {
  id: 'call_multi',
  name: 'aigent_multi',
  args: { calls: [{ id: 'a', tool: 'echo', args: { text: 'x' } }, { id: 'b', tool: 'echo', args: { text: 'y' } }] },
};
const PREAMBLE = 'Let me echo.';
const ANSWER_CHUNKS = ['All ', 'done.'];
/** Per-turn fixture usage; the run's totals must be their sums. */
const FIRST_USAGE: Usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 40 };
const SECOND_USAGE: Usage = { inputTokens: 150, outputTokens: 10, cachedTokens: 60 };
const TOTAL_USAGE = { inputTokens: 250, outputTokens: 30, cachedTokens: 100 };

interface EndToEnd {
  agent: Agent;
  requests: RecordedRequest[];
}

type FetchImpl = typeof fetch;

interface EndToEndParams {
  createProvider(fetchImpl: FetchImpl): Provider;
  /** One per model request, served in order; a function sees the request it answers. */
  responses: (FakeResponseSpec | ((request: RecordedRequest) => FakeResponseSpec))[];
  modelSettings?: ModelSettings;
  /** Default false: these tests pin the adapters' request shapes; one test below covers the feedback fields end to end. */
  enableFeedback?: boolean;
}

/** An agent with the echo tool on the given provider, its HTTP answered by the fixtures. */
function endToEnd(params: EndToEndParams): EndToEnd {
  const { createProvider, responses, modelSettings, enableFeedback = false } = params;
  let nextResponse = 0;
  const { fetch, requests } = createFakeFetch(request => {
    const response = responses[nextResponse];
    nextResponse += 1;
    if (response == null) throw new Error(`unexpected model request #${nextResponse}; only ${responses.length} fixtures were provided`);
    return typeof response === 'function' ? response(request) : response;
  });
  const provider = createProvider(fetch);
  // These tests watch the adapters' own deltas (cancelling on the first one), so the secrets hold-back is off.
  const ai = createAigent({ providers: [provider], clock, ids: sequentialIds(), guardrails: { builtins: { secrets: false } } });
  const agent = ai.agent({ name: 'helper', model: `${provider.id}:${MODEL}`, tools: [echoTool], enableFeedback, ...(modelSettings == null ? {} : { modelSettings }) });
  return { agent, requests };
}

function chunked(text: string): FakeResponseSpec {
  return { body: createFakeBody({ chunks: byteChunks({ text, size: NETWORK_CHUNK_BYTES }) }) };
}

/** Delivers the opening text, then never ends: only cancelling the body finishes it. */
function hangingAfter(text: string): FakeBody {
  return createFakeBody({ chunks: [encodeText(text)], ending: 'hang' });
}

function sentBody(request: RecordedRequest | undefined): Record<string, unknown> {
  return JSON.parse(String(request?.init.body)) as Record<string, unknown>;
}

/** What the loop feeds back for each call: its result envelope, serialised. */
function envelopeOf(content: unknown): Record<string, unknown> {
  return JSON.parse(String(content)) as Record<string, unknown>;
}

/** Cancels the run as soon as the first text arrives, waits for the body to be cancelled and returns the run's status. */
async function cancelOnFirstText(params: { agent: Agent; body: FakeBody }): Promise<string> {
  const { agent, body } = params;
  const run = agent.task({ task: 'Talk' });
  for await (const event of run) {
    if (event.type === 'text-delta') run.cancel();
  }
  const { status } = await run;
  await vi.waitFor(() => expect(body.isCancelled()).toBe(true));
  return status;
}

// ─── OpenAI-compatible ───

function toOpenAiUsage(usage: Usage): OpenAiUsageFixture {
  const { inputTokens, outputTokens, cachedTokens } = usage;
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } };
}

function openAiToolTurn(calls: ToolCall[]): FakeResponseSpec {
  return chunked(sseBody([textChunk(PREAMBLE), ...interleavedToolCallChunks(calls), finishChunk('tool_calls'), usageChunk(toOpenAiUsage(FIRST_USAGE))]));
}

function openAiAnswerTurn(): FakeResponseSpec {
  return chunked(sseBody([...ANSWER_CHUNKS.map(textChunk), finishChunk('stop'), usageChunk(toOpenAiUsage(SECOND_USAGE))]));
}

function openAiEndToEnd(responses: FakeResponseSpec[], enableFeedback = false): EndToEnd {
  return endToEnd({ createProvider: fetchImpl => openAiCompatible({ id: 'compat', baseUrl: 'https://llm.test/v1', apiKey: 'sk-test', fetch: fetchImpl }), responses, enableFeedback });
}

describe('end to end through openAiCompatible', () => {
  it('runs a two-turn tool loop with parallel calls, one invalid, and sums usage', async () => {
    const { agent, requests } = openAiEndToEnd([openAiToolTurn(PARALLEL_CALLS), openAiAnswerTurn()]);
    const result = await agent.task({ task: 'Echo' });

    expect(result).toMatchObject({ status: 'completed', answer: 'All done.', usage: { ...TOTAL_USAGE, turns: 2, toolCalls: 2 } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ category: 'validation' });
    expect(requests.map(({ url }) => url)).toEqual(['https://llm.test/v1/chat/completions', 'https://llm.test/v1/chat/completions']);

    const messages = sentBody(requests[1]).messages as Record<string, unknown>[];
    // The trailing user message is the run's volatile block.
    expect(messages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(String(messages[5]?.content)).toMatch(/^# Current state \(generated by the runtime, not written by the user\)\n/);
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: PREAMBLE,
      tool_calls: [
        { id: 'call_valid', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } },
        { id: 'call_invalid', type: 'function', function: { name: 'echo', arguments: '{"text":5}' } },
      ],
    });
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_valid' });
    expect(envelopeOf(messages[3]?.content)).toEqual({ id: 'call_valid', tool: 'echo', ok: true, result: 'hi' });
    expect(messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_invalid' });
    expect(envelopeOf(messages[4]?.content)).toMatchObject({ id: 'call_invalid', ok: false, error: { category: 'validation' } });
  });

  it('with feedback on, sends aigent_feedback and a nullable previous in strict schemas, and strips previous before the tool runs', async () => {
    const withPrevious = { id: 'call_prev', name: 'echo', args: { text: 'hi', previous: null } };
    const { agent, requests } = openAiEndToEnd([openAiToolTurn([withPrevious]), openAiAnswerTurn()], true);
    const result = await agent.task({ task: 'Echo' });

    expect(result).toMatchObject({ status: 'completed', usage: { toolCalls: 1 } });
    expect(result.errors).toEqual([]);
    const tools = sentBody(requests[0]).tools as { function: { name: string; strict: boolean; parameters: { required: string[]; properties: Record<string, { type: unknown }> } } }[];
    expect(tools.map(({ function: { name, strict } }) => ({ name, strict }))).toEqual([{ name: 'aigent_feedback', strict: true }, { name: 'aigent_multi', strict: false }, { name: 'echo', strict: true }, { name: 'todo', strict: true }]);
    const echoParameters = tools[2]?.function.parameters;
    expect(echoParameters?.required).toEqual(['text', 'previous']);
    expect(echoParameters?.properties.previous?.type).toEqual(['object', 'null']);
    const messages = sentBody(requests[1]).messages as Record<string, unknown>[];
    expect(envelopeOf(messages.at(-2)?.content)).toEqual({ id: 'call_prev', tool: 'echo', ok: true, result: 'hi' });
  });

  it('runs aigent_multi with free-form args, sent with strict off for that tool only', async () => {
    const { agent, requests } = openAiEndToEnd([openAiToolTurn([MULTI_CALL]), openAiAnswerTurn()]);
    const result = await agent.task({ task: 'Echo twice' });

    expect(result).toMatchObject({ status: 'completed', usage: { turns: 2, toolCalls: 2 } });
    expect(result.errors).toEqual([]);
    const tools = sentBody(requests[0]).tools as { function: { name: string; strict: boolean } }[];
    expect(tools.map(({ function: { name, strict } }) => ({ name, strict }))).toEqual([{ name: 'aigent_multi', strict: false }, { name: 'echo', strict: true }, { name: 'todo', strict: true }]);
    const messages = sentBody(requests[1]).messages as Record<string, unknown>[];
    expect(envelopeOf(messages.at(-2)?.content)).toEqual({
      id: 'call_multi',
      tool: 'aigent_multi',
      ok: true,
      result: [{ id: 'a', tool: 'echo', ok: true, result: 'x' }, { id: 'b', tool: 'echo', ok: true, result: 'y' }],
    });
  });

  it('settles as cancelled when cancelled mid-stream and cancels the response body', async () => {
    const body = hangingAfter(sseBodyWithoutDone([textChunk('Thinking')]));
    const { agent } = openAiEndToEnd([{ body }]);
    expect(await cancelOnFirstText({ agent, body })).toBe('cancelled');
  });
});

// ─── Anthropic ───

/** Anthropic reports cache reads apart from uncached input; the adapter adds them back into `inputTokens`. */
function toAnthropicUsage(usage: Usage): AnthropicUsageFixture {
  const { inputTokens, cachedTokens } = usage;
  return { input_tokens: inputTokens - cachedTokens, output_tokens: 1, cache_read_input_tokens: cachedTokens, cache_creation_input_tokens: 0 };
}

function anthropicChunked(events: AnthropicEventFixture[]): FakeResponseSpec {
  return chunked(anthropicSse(events));
}

function anthropicToolTurn(calls: ToolCall[]): FakeResponseSpec {
  return anthropicChunked([
    messageStart(toAnthropicUsage(FIRST_USAGE)), ...textBlock({ index: 0, chunks: [PREAMBLE] }), ...interleavedToolUseBlocks({ calls, firstIndex: 1 }),
    messageDelta({ stopReason: 'tool_use', outputTokens: FIRST_USAGE.outputTokens }), messageStop(),
  ]);
}

function anthropicAnswerTurn(): FakeResponseSpec {
  return anthropicChunked([
    messageStart(toAnthropicUsage(SECOND_USAGE)), ...textBlock({ index: 0, chunks: ANSWER_CHUNKS }),
    messageDelta({ stopReason: 'end_turn', outputTokens: SECOND_USAGE.outputTokens }), messageStop(),
  ]);
}

function anthropicEndToEnd(responses: EndToEndParams['responses'], modelSettings?: ModelSettings): EndToEnd {
  return endToEnd({ createProvider: fetchImpl => anthropic({ apiKey: 'sk-ant-test', baseUrl: 'https://anthropic.test', fetch: fetchImpl }), responses, ...(modelSettings == null ? {} : { modelSettings }) });
}

const THINKING_SIGNATURE = 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds';
const REDACTED_DATA = 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpPkNRj2YfWXGmKDxH4mPnZ5sQ7vB5URj';
const ASSISTANT_THINKING_BLOCKS = [
  { type: 'thinking', thinking: 'I should echo hi.', signature: THINKING_SIGNATURE },
  { type: 'redacted_thinking', data: REDACTED_DATA },
];

function anthropicThinkingToolTurn(): FakeResponseSpec {
  return anthropicChunked([
    messageStart(toAnthropicUsage(FIRST_USAGE)),
    ...thinkingBlock({ index: 0, chunks: ['I should ', 'echo hi.'], signature: THINKING_SIGNATURE }),
    ...redactedThinkingBlock({ index: 1, data: REDACTED_DATA }),
    ...interleavedToolUseBlocks({ calls: [{ id: 'call_valid', name: 'echo', args: { text: 'hi' } }], firstIndex: 2 }),
    messageDelta({ stopReason: 'tool_use', outputTokens: FIRST_USAGE.outputTokens }), messageStop(),
  ]);
}

/** Answers like the Messages API with thinking on: a 400 unless the tool_use turn starts with its thinking blocks, unmodified. */
function requireReplayedThinking(request: RecordedRequest): FakeResponseSpec {
  const messages = sentBody(request).messages as { role: string; content: Record<string, unknown>[] }[];
  const assistant = messages.find(({ role }) => role === 'assistant');
  const replayed = JSON.stringify(assistant?.content.slice(0, ASSISTANT_THINKING_BLOCKS.length)) === JSON.stringify(ASSISTANT_THINKING_BLOCKS);
  if (!replayed) {
    return { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`."}}' };
  }
  return anthropicAnswerTurn();
}

describe('end to end through anthropic', () => {
  it('runs a two-turn tool loop with parallel calls, one invalid, and sums usage', async () => {
    const { agent, requests } = anthropicEndToEnd([anthropicToolTurn(PARALLEL_CALLS), anthropicAnswerTurn()]);
    const result = await agent.task({ task: 'Echo' });

    expect(result).toMatchObject({ status: 'completed', answer: 'All done.', usage: { ...TOTAL_USAGE, turns: 2, toolCalls: 2 } });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ category: 'validation' });
    expect(requests.map(({ url }) => url)).toEqual(['https://anthropic.test/v1/messages', 'https://anthropic.test/v1/messages']);

    const body = sentBody(requests[1]);
    expect(body.system).toEqual([expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } })]);
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: PREAMBLE },
      { type: 'tool_use', id: 'call_valid', name: 'echo', input: { text: 'hi' } },
      { type: 'tool_use', id: 'call_invalid', name: 'echo', input: { text: 5 } },
    ]);
    const [validResult, invalidResult] = messages[2]?.content ?? [];
    expect(validResult).toMatchObject({ type: 'tool_result', tool_use_id: 'call_valid' });
    expect(envelopeOf(validResult?.content)).toEqual({ id: 'call_valid', tool: 'echo', ok: true, result: 'hi' });
    expect(invalidResult).toMatchObject({ type: 'tool_result', tool_use_id: 'call_invalid' });
    expect(envelopeOf(invalidResult?.content)).toMatchObject({ id: 'call_invalid', ok: false, error: { category: 'validation' } });
  });

  it('runs aigent_multi with free-form args, its tool_use input passed through unchanged', async () => {
    const { agent, requests } = anthropicEndToEnd([anthropicToolTurn([MULTI_CALL]), anthropicAnswerTurn()]);
    const result = await agent.task({ task: 'Echo twice' });

    expect(result).toMatchObject({ status: 'completed', usage: { turns: 2, toolCalls: 2 } });
    expect(result.errors).toEqual([]);
    // Anthropic has no strict flag, so no tool carries one (aigent_multi, echo and the built-in todo).
    const tools = sentBody(requests[0]).tools as Record<string, unknown>[];
    expect(tools.map(tool => Object.keys(tool).sort())).toEqual([['description', 'input_schema', 'name'], ['description', 'input_schema', 'name'], ['description', 'input_schema', 'name']]);
    const messages = sentBody(requests[1]).messages as { content: Record<string, unknown>[] }[];
    expect(messages[1]?.content.at(-1)).toEqual({ type: 'tool_use', id: 'call_multi', name: 'aigent_multi', input: MULTI_CALL.args });
    expect(envelopeOf(messages[2]?.content[0]?.content)).toMatchObject({ id: 'call_multi', ok: true });
  });

  it('runs a two-turn tool loop with effort on, replaying the thinking blocks and signature before tool_use', async () => {
    const { agent, requests } = anthropicEndToEnd([anthropicThinkingToolTurn(), requireReplayedThinking], { effort: 'medium' });
    const result = await agent.task({ task: 'Echo' });

    expect(result).toMatchObject({ status: 'completed', answer: 'All done.', usage: { turns: 2, toolCalls: 1 } });
    expect(sentBody(requests[0]).thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    const messages = sentBody(requests[1]).messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages[1]?.content).toEqual([...ASSISTANT_THINKING_BLOCKS, { type: 'tool_use', id: 'call_valid', name: 'echo', input: { text: 'hi' } }]);
  });

  it('settles as cancelled when cancelled mid-stream and cancels the response body', async () => {
    const body = hangingAfter(anthropicSse([messageStart(), textBlockStart(0), textDelta({ index: 0, text: 'Thinking' })]));
    const { agent } = anthropicEndToEnd([{ body }]);
    expect(await cancelOnFirstText({ agent, body })).toBe('cancelled');
  });
});
