import { describe, expect, it } from 'vitest';
import { readLimitedBody } from './read-limited-body.js';

const CHUNK = 1_000;

/** An endless stream of `CHUNK`-byte chunks that counts what was pulled and whether it was cancelled. */
function endless(): { stream: ReadableStream<Uint8Array>; pulled(): number; cancelled(): boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: controller => { pulled += CHUNK; controller.enqueue(new Uint8Array(CHUNK).fill(97)); },
    cancel: () => { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function bytesOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

describe('readLimitedBody', () => {
  it('reads a short body whole', async () => {
    const { body, truncated } = await readLimitedBody({ stream: bytesOf('hello'), maxBytes: 100, signal: new AbortController().signal });
    expect(new TextDecoder().decode(body)).toBe('hello');
    expect(truncated).toBe(false);
  });

  it('stops at the cap without reading much past it, and cancels the stream', async () => {
    const source = endless();
    const { body, truncated } = await readLimitedBody({ stream: source.stream, maxBytes: 2_500, signal: new AbortController().signal });
    expect(body.byteLength).toBe(2_500);
    expect(truncated).toBe(true);
    expect(source.pulled()).toBeLessThanOrEqual(2_500 + CHUNK);
    expect(source.cancelled()).toBe(true);
  });

  it('a body of exactly the cap is not truncated', async () => {
    const { truncated } = await readLimitedBody({ stream: bytesOf('12345'), maxBytes: 5, signal: new AbortController().signal });
    expect(truncated).toBe(false);
  });

  it('abort cancels the body and rejects', async () => {
    const source = endless();
    const controller = new AbortController();
    const reading = readLimitedBody({ stream: source.stream, maxBytes: Number.MAX_SAFE_INTEGER, signal: controller.signal });
    controller.abort(new Error('stopped'));
    await expect(reading).rejects.toThrow();
    expect(source.cancelled()).toBe(true);
  });

  it('treats a missing body as empty', async () => {
    expect(await readLimitedBody({ stream: null, maxBytes: 10, signal: new AbortController().signal })).toEqual({ body: new Uint8Array(0), truncated: false });
  });
});
