import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computePrefixHash } from '../context/prefix-hash.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import { createAigent } from './create-aigent.js';

const TOOL_TURNS = 3;
const REPORTED_INPUT_TOKENS = 777;

const echo = defineTool({
  name: 'echo', description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'echo' }), run: async ({ text }) => text,
});

function setup() {
  const turns = [
    ...Array.from({ length: TOOL_TURNS }, (_unused, turn) => toolTurn([{ id: `c${turn}`, name: 'echo', args: { text: `t${turn}` } }])),
    textTurn('done', { usage: { inputTokens: REPORTED_INPUT_TOKENS, outputTokens: 1, cachedTokens: 0 } }),
  ];
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], enableFeedback: false });
  return { provider, agent: ai.agent({ name: 'ctx', model: 'fake:m', tools: [echo] }) };
}

describe('createAigent context layout', () => {
  it('sends append-only prefixes with cache breakpoints at the system, non-compactable and last stable messages', async () => {
    const { provider, agent } = setup();
    await agent.task({ task: 'echo', plan: [{ id: 'p1', label: 'Echo', description: 'Echo things', acceptanceCriteria: ['echoed'] }] });
    const { requests } = provider;
    requests.forEach(({ messages, cacheBreakpoints }) => {
      // system, brief, pinned plan: the never-compacted head ends at index 2.
      // On the first request the head is the whole stable part, so its end is also the last stable message.
      expect(cacheBreakpoints).toEqual([...new Set([0, 2, messages.length - 2])]);
      expect(messages.at(-1)?.volatile).toBe(true);
    });
    for (let turn = 1; turn < requests.length; turn += 1) {
      const previous = requests[turn - 1]!.messages.slice(0, -1);
      const current = requests[turn]!.messages.slice(0, previous.length);
      expect(computePrefixHash(current, requests[turn]!.tools)).toBe(computePrefixHash(previous, requests[turn - 1]!.tools));
    }
  });

  it('reports the peak prompt size, preferring the provider-reported input tokens', async () => {
    const { agent } = setup();
    const result = await agent.task({ task: 'echo' });
    expect(result.usage.contextTokensPeak).toBe(REPORTED_INPUT_TOKENS);
  });

  it('rejects a non-boolean compactable on a tool definition', () => {
    expect(() => defineTool({ ...echo, args: z.object({}).strict(), compactable: 'no' as unknown as boolean, run: async () => 1 })).toThrow(/compactable must be a boolean/);
    expect(defineTool({ ...echo, args: z.object({}).strict(), compactable: false, run: async () => 1 }).compactable).toBe(false);
  });
});
