import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAigent, defineTool } from '@anupheaus/aigent';
import type { AigentEvent, Tool } from '@anupheaus/aigent';
import { claudeCodePlugin } from './claude-code-plugin.js';
import { claudeCode } from './claude-code-provider.js';
import { createFakeRunner, resultStep, textDelta } from './fake-runner.test-support.js';
import type { FakeStep } from './fake-runner.test-support.js';
import { bridgeTools, bridgedToolName } from './tool-bridge.js';
import { buildPrompt } from './prompt.js';

const USAGE = { inputTokens: 100, outputTokens: 10, cachedTokens: 0 };
// Built at runtime: a value the secrets guardrail recognises, never written as one literal.
const FAKE_AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

let lookups = 0;
const lookup = defineTool({
  name: 'lookup', description: 'Looks a word up', args: z.object({ word: z.string() }).strict(), deterministic: true, cache: true,
  describeActivity: () => ({ title: 'Lookup' }), run: async ({ word }) => { lookups += 1; return `${word}: found`; },
});
const leaky = defineTool({
  name: 'leaky', description: 'Returns a key', args: z.object({}).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'Leaky' }), run: async () => `key=${FAKE_AWS_KEY}`,
});
const remove = defineTool({
  name: 'remove', description: 'Deletes', args: z.object({ path: z.string() }).strict(), deterministic: false, cache: false, hasSideEffects: true, requiresApproval: true,
  describeActivity: () => ({ title: 'Remove' }), run: async () => 'removed',
  dryRun: async ({ path }) => [{ kind: 'delete', target: path, summary: `would delete ${path}`, reversible: false }],
});

function agentWith(params: { scripts: FakeStep[][]; tools?: Tool[] }) {
  const { scripts, tools = [lookup, leaky, remove] } = params;
  const runner = createFakeRunner(scripts);
  const ai = createAigent({ plugins: [claudeCodePlugin({ runner })] });
  const agent = ai.agent({ name: 'coder', model: 'claude-code:claude-sonnet-5-5', tools, enableFeedback: false });
  return { runner, agent, ai };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('claudeCode provider in delegated mode', () => {
  it('makes one SDK run per turn and runs bridged calls in-process through the core', async () => {
    const { runner, agent } = agentWith({ scripts: [[textDelta('Looking. '), { kind: 'call', tool: 'lookup', args: { word: 'cat' } }, textDelta('Cat is found.'), resultStep(USAGE)]] });
    const run = agent.task({ task: 'Look up cat' });
    const events = await collect(run);
    const result = await run;
    expect(result).toMatchObject({ status: 'completed', answer: 'Looking. Cat is found.', usage: { inputTokens: 100, outputTokens: 10, turns: 1, toolCalls: 1 } });
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]).toMatchObject({ model: 'claude-sonnet-5-5', includePartialMessages: true });
    expect(runner.runs[0]?.tools.map(({ name }) => name)).toEqual(expect.arrayContaining(['lookup', 'leaky', 'remove', 'aigent_multi']));
    expect(JSON.parse(runner.toolResults[0]?.text ?? '{}')).toMatchObject({ ok: true, result: 'cat: found' });
    expect(events.some(event => event.type === 'warning' && event.message.includes("Provider 'claude-code' runs its own tool loop"))).toBe(true);
  });

  it('applies the cache, guardrails, approvals and dry runs to bridged calls', async () => {
    lookups = 0;
    const call = (tool: string, args: unknown): FakeStep => ({ kind: 'call', tool, args });
    const scripts: FakeStep[][] = [[call('lookup', { word: 'a' }), call('lookup', { word: 'a' }), call('leaky', {}), call('remove', { path: 'x' }), textDelta('done'), resultStep(USAGE)]];
    const { runner, agent } = agentWith({ scripts });
    await agent.task({ task: 'x', unattended: true });
    expect(lookups).toBe(1);
    const [, , leakyResult, removeResult] = runner.toolResults;
    expect(leakyResult?.text).not.toContain(FAKE_AWS_KEY);
    expect(leakyResult?.text).toContain('[REDACTED:aws-access-key]');
    expect(removeResult).toMatchObject({ isError: true });
    expect(JSON.parse(removeResult?.text ?? '{}')).toMatchObject({ error: { category: 'denied' } });

    const dry = agentWith({ scripts: [[call('remove', { path: 'x' }), textDelta('planned'), resultStep(USAGE)]] });
    const result = await dry.agent.task({ task: 'x', dryRun: true, unattended: true });
    expect(result.plannedEffects).toEqual([expect.objectContaining({ kind: 'delete', target: 'x' })]);
  });

  it('propagates a stop to the runner signal and settles as cancelled', async () => {
    const { runner, agent } = agentWith({ scripts: [[{ kind: 'call', tool: 'lookup', args: { word: 'b' } }, { kind: 'hang' }, resultStep(USAGE)]] });
    const run = agent.task({ task: 'x' });
    for await (const event of run) if (event.type === 'tool-result') run.cancel();
    expect((await run).status).toBe('cancelled');
    expect(runner.runs[0]?.signal.aborted).toBe(true);
  });

  it('removes the API key variables only with useSubscriptionAuth, warning once', async () => {
    const name = 'ANTHROPIC_API_KEY';
    const previous = process.env[name];
    process.env[name] = ['fake', 'value'].join('-');
    try {
      const onWarning = vi.fn();
      const runner = createFakeRunner([[resultStep(USAGE)], [resultStep(USAGE)], [resultStep(USAGE)]]);
      const request = { model: 'm', messages: [{ role: 'user' as const, text: 'hi' }], tools: [] };
      const drain = async (provider: ReturnType<typeof claudeCode>): Promise<void> => { for await (const event of provider.stream(request, new AbortController().signal)) void event; };
      const subscription = claudeCode({ runner, useSubscriptionAuth: true, onWarning });
      await drain(subscription);
      await drain(subscription);
      await drain(claudeCode({ runner, onWarning }));
      expect(runner.runs.map(({ env }) => name in env)).toEqual([false, false, true]);
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning.mock.calls[0]?.[0]).toContain('removed ANTHROPIC_API_KEY');
    } finally {
      if (previous == null) delete process.env[name]; else process.env[name] = previous;
    }
  });

  it('declares the delegated-loop capabilities', () => {
    expect(claudeCode({ runner: createFakeRunner([]) }).capabilities).toEqual({
      streaming: true, toolCalling: true, parallelToolCalls: true, promptCaching: false, vision: false, maxContextTokens: 200_000, ownsLoop: true, supportedSettings: [],
    });
  });
});

describe('tool bridge', () => {
  it('keeps names, descriptions and schemas, and names tools as the SDK does', async () => {
    const executor = vi.fn(async ({ id }: { id: string }) => ({ callId: id, text: '{"ok":true}', isError: false }));
    const [bridged] = bridgeTools({ specs: [{ name: 'lookup', description: 'Looks up', parameters: { type: 'object' }, strict: true }], executor });
    expect(bridged).toMatchObject({ name: 'lookup', description: 'Looks up', inputSchema: { type: 'object' } });
    expect(await bridged?.execute({ word: 'a' })).toEqual({ text: '{"ok":true}', isError: false });
    expect(executor).toHaveBeenCalledWith({ id: 'cc_1', name: 'lookup', args: { word: 'a' } });
    expect(bridgedToolName('lookup')).toBe('mcp__aigent__lookup');
  });

  it('refuses calls without the core executor', async () => {
    const [bridged] = bridgeTools({ specs: [{ name: 't', description: '', parameters: {}, strict: true }] });
    expect(await bridged?.execute({})).toMatchObject({ isError: true });
  });
});

describe('buildPrompt', () => {
  it('sends a lone user message as the prompt and the volatile block with the system prompt', () => {
    expect(buildPrompt([{ role: 'system', text: 'Be brief.' }, { role: 'user', text: 'Hi' }, { role: 'user', text: '# Current state\nPlan: 1 open', volatile: true }]))
      .toEqual({ system: 'Be brief.\n\n# Current state\nPlan: 1 open', prompt: 'Hi' });
  });

  it('renders a longer history as a transcript with tool calls and results', () => {
    const { prompt } = buildPrompt([
      { role: 'user', text: 'Find cat' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'lookup', args: { word: 'cat' } }] },
      { role: 'tool', toolCallId: 'c1', text: '{"ok":true}' },
      { role: 'assistant', text: 'Found.' },
      { role: 'user', text: 'And dog?' },
    ]);
    expect(prompt).toBe('The conversation so far follows. Continue it: reply to the last user message.\n\n### User\nFind cat\n\n### Tool call lookup (c1)\n{"word":"cat"}\n\n### Tool result (c1)\n{"ok":true}\n\n### Assistant\nFound.\n\n### User\nAnd dog?');
  });
});
