import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '../providers/provider-types.js';
import { createAigentError } from './aigent-error.js';
import { openStreamIterator } from './open-stream-iterator.js';

const DONE: ProviderEvent = { type: 'done', finishReason: 'stop' };
const signal = new AbortController().signal;

async function* events(): AsyncGenerator<ProviderEvent> {
  yield DONE;
}

describe('openStreamIterator', () => {
  it('returns the iterator of the stream open returns, passing the signal through', async () => {
    let received: AbortSignal | undefined;
    const iterator = openStreamIterator({ open: openSignal => { received = openSignal; return events(); }, signal, label: 'p:m' });
    expect(received).toBe(signal);
    expect(await iterator.next()).toEqual({ done: false, value: DONE });
  });

  it('rethrows a synchronous throw from open unchanged', () => {
    const thrown = createAigentError({ code: 'provider_failed', message: 'missing key', details: { retryable: true } });
    expect(() => openStreamIterator({ open: () => { throw thrown; }, signal, label: 'p:m' })).toThrow(thrown);
  });

  it.each([
    ['object', {}],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['number', 42],
  ])('fails a return value of %s as non-retryable provider_failed naming the label', (kind, value) => {
    const open = (() => value) as unknown as () => AsyncIterable<ProviderEvent>;
    expect(() => openStreamIterator({ open, signal, label: 'p:m' })).toThrow(expect.objectContaining({
      code: 'provider_failed',
      message: expect.stringContaining(`Provider 'p:m' stream() returned ${kind}, which is not an async iterable`),
      details: { retryable: false },
    }));
  });
});
