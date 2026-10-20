import { describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest } from '../providers/provider-types.js';
import { createFakeProvider, textTurn, toolTurn } from './fake-provider.js';

const REQUEST: ProviderRequest = { model: 'm', messages: [{ role: 'user', text: 'hi' }], tools: [] };

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('createFakeProvider', () => {
  it('plays scripted turns in order and records requests', async () => {
    const provider = createFakeProvider({ turns: [textTurn('hello', { chunkSize: 2 }), textTurn('bye')] });
    const first = await collect(provider.stream(REQUEST, new AbortController().signal));
    expect(first.filter(event => event.type === 'text-delta').map(event => event.text).join('')).toBe('hello');
    expect(first.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    await collect(provider.stream(REQUEST, new AbortController().signal));
    expect(provider.requests).toHaveLength(2);
  });

  it('emits tool calls with finishReason tool_calls', async () => {
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'x', args: { a: 1 } }])] });
    const events = await collect(provider.stream(REQUEST, new AbortController().signal));
    expect(events).toContainEqual({ type: 'tool-call', call: { id: 'c1', name: 'x', args: { a: 1 } } });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('fails clearly when out of scripted turns', async () => {
    const provider = createFakeProvider({ turns: [] });
    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).rejects.toMatchObject({ code: 'provider_failed' });
  });

  it('stops yielding once aborted and throws an aborted error', async () => {
    const provider = createFakeProvider({ turns: [textTurn('abcdef', { chunkSize: 1, delayMs: 5 })] });
    const controller = new AbortController();
    const seen: ProviderEvent[] = [];
    const run = (async () => {
      for await (const event of provider.stream(REQUEST, controller.signal)) {
        seen.push(event);
        if (seen.length === 2) controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(seen.length).toBeLessThan(6);
  });
});
