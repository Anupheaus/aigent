import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '@anupheaus/aigent';
import { createFakeRunner, resultStep, stopReason, textDelta, thinkingDelta } from './fake-runner.test-support.js';
import type { FakeStep } from './fake-runner.test-support.js';
import { mapSdkStream, usageOf } from './stream-mapper.js';

const USAGE = { inputTokens: 120, outputTokens: 30, cachedTokens: 20 };

async function mapped(steps: FakeStep[], signal = new AbortController().signal): Promise<{ events: ProviderEvent[]; error?: unknown }> {
  const runner = createFakeRunner([steps]);
  const events: ProviderEvent[] = [];
  try {
    const messages = runner.run({ prompt: 'p', system: 's', tools: [], env: {}, signal, includePartialMessages: true });
    for await (const event of mapSdkStream({ messages, signal, label: 'cc' })) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

describe('mapSdkStream', () => {
  it('maps partial text and thinking deltas, then one usage and done(stop)', async () => {
    const { events } = await mapped([{ kind: 'message', message: { type: 'system', subtype: 'init' } }, thinkingDelta('hmm'), textDelta('Hel'), textDelta('lo'), resultStep(USAGE)]);
    expect(events).toEqual([
      { type: 'thinking-delta', text: 'hmm' }, { type: 'text-delta', text: 'Hel' }, { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: USAGE }, { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('uses whole assistant messages only when they were not streamed, and never emits tool_use', async () => {
    const assistant = (text: string): FakeStep => ({ kind: 'message', message: { type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 't1', name: 'mcp__aigent__echo', input: {} }] } } });
    const { events } = await mapped([textDelta('streamed'), assistant('streamed'), assistant('whole'), resultStep(USAGE)]);
    expect(events.filter(({ type }) => type === 'text-delta')).toEqual([{ type: 'text-delta', text: 'streamed' }, { type: 'text-delta', text: 'whole' }]);
    expect(events.some(({ type }) => type === 'tool-call')).toBe(false);
  });

  it('finishes with length on max_tokens and on the SDK turn limit', async () => {
    expect((await mapped([textDelta('cut'), stopReason('max_tokens'), resultStep(USAGE)])).events.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
    expect((await mapped([textDelta('cut'), resultStep(USAGE, 'error_max_turns')])).events.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
  });

  it('turns an error result into a non-retryable provider_failed with its errors', async () => {
    const { error } = await mapped([{ kind: 'message', message: { type: 'result', subtype: 'error_during_execution', errors: ['tool crashed'] } }]);
    expect(error).toMatchObject({ code: 'provider_failed', message: "cc run failed (error_during_execution): tool crashed", details: { retryable: false } });
  });

  it('rejects a broken or truncated stream as retryable provider_failed, never done', async () => {
    const broken = await mapped([textDelta('partial'), { kind: 'throw', message: 'subprocess died' }]);
    expect(broken.error).toMatchObject({ code: 'provider_failed', message: 'cc stream failed: subprocess died', details: { retryable: true } });
    const truncated = await mapped([textDelta('partial')]);
    expect(truncated.error).toMatchObject({ code: 'provider_failed', message: 'cc stream ended without a result', details: { retryable: true } });
    expect([...broken.events, ...truncated.events].some(({ type }) => type === 'done')).toBe(false);
  });

  it('rejects aborted promptly and closes the SDK stream', async () => {
    const controller = new AbortController();
    const runner = createFakeRunner([[textDelta('a'), { kind: 'hang' }, textDelta('never'), resultStep(USAGE)]]);
    const messages = runner.run({ prompt: 'p', system: 's', tools: [], env: {}, signal: controller.signal, includePartialMessages: true });
    const events: ProviderEvent[] = [];
    const consumed = (async () => { for await (const event of mapSdkStream({ messages, signal: controller.signal, label: 'cc' })) { events.push(event); controller.abort(); } })();
    await expect(consumed).rejects.toMatchObject({ code: 'aborted' });
    expect(events).toEqual([{ type: 'text-delta', text: 'a' }]);
  });

  it('sums modelUsage across models when present', () => {
    expect(usageOf({ modelUsage: { a: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 5, cacheCreationInputTokens: 2 }, b: { inputTokens: 3, outputTokens: 4 } }, usage: { input_tokens: 999 } }))
      .toEqual({ inputTokens: 20, outputTokens: 5, cachedTokens: 5 });
    expect(usageOf({})).toBeUndefined();
  });
});
