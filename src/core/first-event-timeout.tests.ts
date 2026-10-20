import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createFakeTime } from '../scheduler/fake-time.test-support.js';
import { createAigentError } from './aigent-error.js';
import { withFirstEventTimeout } from './first-event-timeout.js';

const TEXT: ProviderEvent = { type: 'text-delta', text: 'hi' };
const DONE: ProviderEvent = { type: 'done', finishReason: 'stop' };
const TIMEOUT_MS = 1_000;

interface ListenerCount {
  signal: AbortSignal;
  active(): number;
}

/** A signal that counts its live abort listeners, to prove none is left behind. */
function countingSignal(): ListenerCount {
  const { signal } = new AbortController();
  let active = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { active += 1; add(...args); }) as AbortSignal['addEventListener'];
  signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { active -= 1; remove(...args); }) as AbortSignal['removeEventListener'];
  return { signal, active: () => active };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const seen: ProviderEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('withFirstEventTimeout', () => {
  it('passes a stream whose first event arrives in time through, cancelling the timer', async () => {
    const time = createFakeTime();
    async function* quick(): AsyncGenerator<ProviderEvent> { yield TEXT; yield DONE; }
    const { signal, active } = countingSignal();
    expect(await collect(withFirstEventTimeout({ open: quick, signal, timeoutMs: TIMEOUT_MS, sleep: time.sleep, label: 'p:m' }))).toEqual([TEXT, DONE]);
    expect(time.pendingSleeps()).toBe(0);
    expect(active()).toBe(0);
  });

  it('fails retryably with details.timeout when no event arrives in time, aborting the stream', async () => {
    const time = createFakeTime();
    let streamSignal: AbortSignal | undefined;
    async function* silent(openSignal: AbortSignal): AsyncGenerator<ProviderEvent> {
      streamSignal = openSignal;
      await new Promise(() => undefined);
      yield DONE;
    }
    const outcome = collect(withFirstEventTimeout({ open: silent, signal: new AbortController().signal, timeoutMs: TIMEOUT_MS, sleep: time.sleep, label: 'p:m' }));
    const settled = outcome.catch((error: unknown) => error);
    await time.advance(TIMEOUT_MS);
    expect(await settled).toMatchObject({ code: 'provider_failed', message: "Provider 'p:m' sent no event within 1000 ms", details: { retryable: true, timeout: true, timeoutMs: TIMEOUT_MS } });
    expect(streamSignal?.aborted).toBe(true);
  });

  it('rethrows a synchronous throw from open and leaves no listener or timer behind', async () => {
    const time = createFakeTime();
    const thrown = createAigentError({ code: 'provider_failed', message: 'no key', details: { retryable: false } });
    const { signal, active } = countingSignal();
    await expect(collect(withFirstEventTimeout({ open: () => { throw thrown; }, signal, timeoutMs: TIMEOUT_MS, sleep: time.sleep, label: 'p:m' }))).rejects.toBe(thrown);
    expect(active()).toBe(0);
    expect(time.pendingSleeps()).toBe(0);
  });

  it('forwards the caller abort to the stream', async () => {
    const time = createFakeTime();
    const controller = new AbortController();
    let streamSignal: AbortSignal | undefined;
    async function* first(openSignal: AbortSignal): AsyncGenerator<ProviderEvent> { streamSignal = openSignal; yield TEXT; }
    for await (const event of withFirstEventTimeout({ open: first, signal: controller.signal, timeoutMs: TIMEOUT_MS, sleep: time.sleep, label: 'p:m' })) {
      expect(event).toEqual(TEXT);
      controller.abort();
    }
    expect(streamSignal?.aborted).toBe(true);
  });
});
