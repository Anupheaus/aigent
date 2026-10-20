import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, ProviderRequest } from '../providers/provider-types.js';
import { createAigentError } from '../core/aigent-error.js';
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

  it('declares every setting supported and records the settings it receives', async () => {
    const provider = createFakeProvider({ turns: [textTurn('ok')] });
    expect(provider.capabilities.supportedSettings).toEqual(['maxOutputTokens', 'temperature', 'topP', 'thinking', 'effort', 'promptCaching', 'stop', 'seed', 'providerOptions']);
    await collect(provider.stream({ ...REQUEST, settings: { temperature: 0.2, providerOptions: { a: 1 } } }, new AbortController().signal));
    expect(provider.requests[0]?.settings).toEqual({ temperature: 0.2, providerOptions: { a: 1 } });
  });

  it('emits tool calls with finishReason tool_calls', async () => {
    const provider = createFakeProvider({ turns: [toolTurn([{ id: 'c1', name: 'x', args: { a: 1 } }])] });
    const events = await collect(provider.stream(REQUEST, new AbortController().signal));
    expect(events).toContainEqual({ type: 'tool-call', call: { id: 'c1', name: 'x', args: { a: 1 } } });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('throws a scripted failure before any event, consuming the turn', async () => {
    const failure = createAigentError({ code: 'provider_failed', message: 'HTTP 503', details: { retryable: true } });
    const provider = createFakeProvider({ turns: [{ events: [{ type: 'text-delta', text: 'never' }], failBeforeEvents: failure }, textTurn('ok')] });
    const seen: ProviderEvent[] = [];
    const first = (async () => { for await (const event of provider.stream(REQUEST, new AbortController().signal)) seen.push(event); })();
    await expect(first).rejects.toBe(failure);
    expect(seen).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect((await collect(provider.stream(REQUEST, new AbortController().signal))).at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
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

  describe('pending timers', () => {
    afterEach(() => { vi.useRealTimers(); });

    // Consumers assert "no pending timers" after cancelling; the fake must not leave its delay timer behind.
    it('clears its delay timer as soon as the signal aborts', async () => {
      vi.useFakeTimers();
      const provider = createFakeProvider({ turns: [textTurn('ab', { chunkSize: 1, delayMs: 60_000 })] });
      const controller = new AbortController();
      const consumed = collect(provider.stream(REQUEST, controller.signal));
      const settled = expect(consumed).rejects.toMatchObject({ code: 'aborted' });
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
