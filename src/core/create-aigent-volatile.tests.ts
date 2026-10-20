import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computePrefixHash } from '../context/prefix-hash.js';
import { PREFIX_CHANGED_WARNING } from '../context/stability-monitor.js';
import { createFakeProvider, textTurn, toolTurn } from '../testing/fake-provider.js';
import { defineTool } from '../tools/define-tool.js';
import type { AigentEvent } from './aigent-events.js';
import { createAigent } from './create-aigent.js';
import type { AigentOptions } from './create-aigent.js';
import type { Clock } from './runtime-services.js';

const TOOL_TURNS = 5;
/** Each clock read moves time on by 7 minutes, so every request sees a different time. */
const STEP_MS = 7 * 60_000;

function steppingClock(): Clock {
  let current = Date.UTC(2026, 9, 20, 9, 0);
  return { now: () => { current += STEP_MS; return current; } };
}

const echo = defineTool({
  name: 'echo', description: 'Echo', args: z.object({ text: z.string() }).strict(), deterministic: false, cache: false,
  describeActivity: () => ({ title: 'echo' }), run: async ({ text }) => text,
});

function setup(options: Partial<AigentOptions> = {}) {
  const turns = [...Array.from({ length: TOOL_TURNS }, (_unused, turn) => toolTurn([{ id: `c${turn}`, name: 'echo', args: { text: `t${turn}` } }])), textTurn('done')];
  const provider = createFakeProvider({ turns });
  const ai = createAigent({ providers: [provider], clock: steppingClock(), enableFeedback: false, ...options });
  return { provider, agent: ai.agent({ name: 'v', model: 'fake:m', tools: [echo] }) };
}

async function collect(iterable: AsyncIterable<AigentEvent>): Promise<AigentEvent[]> {
  const events: AigentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createAigent volatile block', () => {
  it('appends the block to each request only, keeping every earlier message byte-stable across turns', async () => {
    const { provider, agent } = setup();
    const events = await collect(agent.task({ task: 'echo five times' }));
    const { requests } = provider;
    expect(requests).toHaveLength(TOOL_TURNS + 1);
    requests.forEach((request, index) => {
      const last = request.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.text).toMatch(new RegExp(`^# Current state\\nDate and time: 2026-10-20 \\d\\d:\\d\\d \\(UTC\\)\\nProgress: turn ${index + 1} of 25; ${index} of 100 tool calls used$`));
      // No stored message is a volatile block: only the request's last message is.
      expect(request.messages.slice(0, -1).filter(({ text }) => text?.startsWith('# Current state'))).toEqual([]);
    });
    for (let turn = 0; turn < TOOL_TURNS; turn += 1) {
      const stable = requests[turn]!.messages.slice(0, -1);
      const next = requests[turn + 1]!.messages.slice(0, stable.length);
      expect(computePrefixHash(next, requests[turn + 1]!.tools)).toBe(computePrefixHash(stable, requests[turn]!.tools));
    }
    // The clock moved on, yet the times differ only in the block.
    expect(new Set(requests.map(({ messages }) => messages.at(-1)?.text)).size).toBe(TOOL_TURNS + 1);
    expect(events.filter(event => event.type === 'warning')).toEqual([]);
  });

  it('honours the options and sends no block when nothing is left', async () => {
    const tokyo = setup({ volatile: { timezone: 'Asia/Tokyo', locale: 'ja-JP', dateTime: { granularity: 'day' } } });
    await tokyo.agent.task({ task: 'x' });
    expect(tokyo.provider.requests[0]?.messages.at(-1)?.text).toBe('# Current state\nDate and time: 2026-10-20 (Asia/Tokyo)\nLocale: ja-JP\nProgress: turn 1 of 25; 0 of 100 tool calls used');
    const none = setup({ volatile: { dateTime: false, progress: false } });
    await none.agent.task({ task: 'x' });
    expect(none.provider.requests[0]?.messages.map(({ role }) => role)).toEqual(['system', 'user']);
  });

  it('rejects invalid volatile options at createAigent', () => {
    expect(() => createAigent({ providers: [], volatile: { timezone: 'Nowhere/City' } })).toThrow(expect.objectContaining({ code: 'invalid_definition' }));
  });

  it('exports the warning text the monitor emits', () => {
    expect(PREFIX_CHANGED_WARNING).toContain('Move changing content to the volatile block');
  });
});
