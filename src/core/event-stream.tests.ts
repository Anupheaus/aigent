import { describe, expect, it } from 'vitest';
import { createEventStream } from './event-stream.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createEventStream', () => {
  it('is awaitable for the result and iterable for events', async () => {
    const stream = createEventStream<number, string>();
    stream.push(1); stream.push(2);
    stream.finish('done');
    expect(await stream.run).toBe('done');
    expect(await collect(stream.run)).toEqual([1, 2]);
  });

  it('delivers live events to a consumer that is already waiting', async () => {
    const stream = createEventStream<number, string>();
    const collecting = collect(stream.run);
    setTimeout(() => { stream.push(1); stream.push(2); stream.finish('x'); }, 5);
    expect(await collecting).toEqual([1, 2]);
  });

  it('supports several independent iterators and awaiting after partial iteration', async () => {
    const stream = createEventStream<number, string>();
    stream.push(1); stream.push(2);
    const iterator = stream.run[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(1);
    stream.finish('end');
    expect(await stream.run).toBe('end');
    expect(await collect(stream.run)).toEqual([1, 2]);
  });

  it('propagates failure to awaiters and to iterators once buffered events are consumed', async () => {
    const stream = createEventStream<number, string>();
    stream.push(1);
    stream.fail(new Error('boom'));
    await expect(stream.run).rejects.toThrow('boom');
    const seen: number[] = [];
    await expect((async () => { for await (const event of stream.run) seen.push(event); })()).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
  });

  it('does not cause an unhandled rejection when nobody awaits a failed run', async () => {
    const stream = createEventStream<number, string>();
    stream.fail(new Error('ignored'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(true).toBe(true); // vitest fails the file on unhandled rejections
  });
});
