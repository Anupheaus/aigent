import { describe, expect, it } from 'vitest';
import { parseSse } from './sse-parser.js';
import type { SseMessage } from './sse-parser.js';

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of parseSse(streamOf(chunks))) messages.push(message);
  return messages;
}

function parseText(text: string): Promise<SseMessage[]> {
  return collect([encoder.encode(text)]);
}

const SAMPLE = 'event: a\ndata: one\n\n: keep-alive\ndata: two\ndata: three\n\nevent: b\r\ndata: {"x":"é日本😀"}\r\n\r\ndata: last\r\r';
const SAMPLE_EXPECTED: SseMessage[] = [
  { event: 'a', data: 'one' },
  { data: 'two\nthree' },
  { event: 'b', data: '{"x":"é日本😀"}' },
  { data: 'last' },
];

describe('parseSse', () => {
  it('yields simple messages terminated by a blank line', async () => {
    expect(await parseText('data: hello\n\ndata: world\n\n')).toEqual([{ data: 'hello' }, { data: 'world' }]);
  });

  it('pairs an event field with its data', async () => {
    expect(await parseText('event: message_start\ndata: {"a":1}\n\n')).toEqual([{ event: 'message_start', data: '{"a":1}' }]);
  });

  it('joins multi-line data with newlines', async () => {
    expect(await parseText('data: a\ndata: b\ndata: c\n\n')).toEqual([{ data: 'a\nb\nc' }]);
  });

  it('handles CRLF line endings', async () => {
    expect(await parseText('data: a\r\n\r\ndata: b\r\n\r\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('handles bare CR line endings', async () => {
    expect(await parseText('data: a\r\rdata: b\r\r')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('ignores comment lines and unknown fields', async () => {
    expect(await parseText(': ping\nid: 7\nretry: 100\nfoo: bar\ndata: x\n\n')).toEqual([{ data: 'x' }]);
  });

  it('does not yield a message that has no data lines', async () => {
    expect(await parseText(': only a comment\n\nevent: lonely\n\n')).toEqual([]);
  });

  it('does not leak the event name into the next message', async () => {
    expect(await parseText('event: a\ndata: 1\n\ndata: 2\n\n')).toEqual([{ event: 'a', data: '1' }, { data: '2' }]);
  });

  it('flushes a final message that has no trailing blank line', async () => {
    expect(await parseText('data: a\n\ndata: tail')).toEqual([{ data: 'a' }, { data: 'tail' }]);
    expect(await parseText('data: a\n\ndata: tail\n')).toEqual([{ data: 'a' }, { data: 'tail' }]);
  });

  it('accepts data with no space after the colon', async () => {
    expect(await parseText('data:x\n\n')).toEqual([{ data: 'x' }]);
  });

  it('strips only one leading space from a value', async () => {
    expect(await parseText('data:  two\n\n')).toEqual([{ data: ' two' }]);
  });

  it('splits a field at the first colon only', async () => {
    expect(await parseText('data: {"a":"b:c"}\n\n')).toEqual([{ data: '{"a":"b:c"}' }]);
  });

  it('treats a field with no colon as an empty value', async () => {
    expect(await parseText('data\n\n')).toEqual([{ data: '' }]);
  });

  it('does not interpret [DONE]', async () => {
    expect(await parseText('data: [DONE]\n\n')).toEqual([{ data: '[DONE]' }]);
  });

  it('parses the sample unsplit', async () => {
    expect(await parseText(SAMPLE)).toEqual(SAMPLE_EXPECTED);
  });

  it('gives identical output for every two-chunk split at every byte boundary', async () => {
    const bytes = encoder.encode(SAMPLE);
    for (let splitAt = 0; splitAt <= bytes.length; splitAt += 1) {
      expect(await collect([bytes.slice(0, splitAt), bytes.slice(splitAt)])).toEqual(SAMPLE_EXPECTED);
    }
  });

  it('gives identical output when delivered one byte at a time', async () => {
    const bytes = encoder.encode(SAMPLE);
    const singleBytes = Array.from(bytes, byte => new Uint8Array([byte]));
    expect(await collect(singleBytes)).toEqual(SAMPLE_EXPECTED);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    for (const text of ['é', '日本', '😀']) {
      const bytes = encoder.encode(`data: ${text}\n\n`);
      for (let splitAt = 0; splitAt <= bytes.length; splitAt += 1) {
        expect(await collect([bytes.slice(0, splitAt), bytes.slice(splitAt)])).toEqual([{ data: text }]);
      }
    }
  });

  it('cancels the body when the consumer abandons the iterator', async () => {
    let isCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: a\n\ndata: b\n\n')); },
      cancel() { isCancelled = true; },
    });
    for await (const message of parseSse(body)) {
      expect(message).toEqual({ data: 'a' });
      break;
    }
    expect(isCancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('propagates a stream error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\n\n'));
        controller.error(new Error('network down'));
      },
    });
    const messages: SseMessage[] = [];
    await expect((async () => { for await (const message of parseSse(body)) messages.push(message); })()).rejects.toThrow('network down');
  });
});
