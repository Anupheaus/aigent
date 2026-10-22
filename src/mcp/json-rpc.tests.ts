import { describe, expect, it } from 'vitest';
import { classifyMessage, createLineDecoder, encodeFrame } from './json-rpc.js';

describe('classifyMessage', () => {
  it.each([
    [{ jsonrpc: '2.0', id: 1, result: { ok: true } }, { kind: 'result', id: 1, result: { ok: true } }],
    [{ jsonrpc: '2.0', id: 'a', result: null }, { kind: 'result', id: 'a', result: null }],
    [{ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope', data: { x: 1 } } }, { kind: 'error', id: 2, error: { code: -32601, message: 'nope', data: { x: 1 } } }],
    [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } }, { kind: 'error', id: null, error: { code: -32700, message: 'parse' } }],
    [{ jsonrpc: '2.0', id: 3, method: 'ping' }, { kind: 'request', id: 3, method: 'ping' }],
    [{ jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } }, { kind: 'notification', method: 'notifications/progress', params: { p: 1 } }],
  ])('classifies %j', (message, expected) => {
    expect(classifyMessage(message)).toEqual(expected);
  });

  it.each([
    [null, 'not a JSON object'],
    [[1], 'not a JSON object'],
    [{ id: 1, result: 1 }, 'jsonrpc must be "2.0"'],
    [{ jsonrpc: '2.0', result: 1 }, 'result without a valid id'],
    [{ jsonrpc: '2.0', id: {}, result: 1 }, 'result without a valid id'],
    [{ jsonrpc: '2.0', id: 1, error: { message: 'x' } }, 'error response without a numeric code and a message'],
    [{ jsonrpc: '2.0', id: 1 }, 'neither a response nor a method call'],
    [{ jsonrpc: '2.0', id: [], method: 'x' }, 'request with an invalid id'],
  ])('rejects %j as invalid', (message, reason) => {
    expect(classifyMessage(message)).toEqual({ kind: 'invalid', reason });
  });
});

describe('newline-delimited framing', () => {
  it('encodes compact JSON with a trailing newline and no newline inside', () => {
    const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x', params: { text: 'a\nb' } });
    expect(frame).toBe('{"jsonrpc":"2.0","id":1,"method":"x","params":{"text":"a\\nb"}}\n');
    expect(frame.indexOf('\n')).toBe(frame.length - 1);
  });

  it('reassembles lines split across chunks, with \\n or \\r\\n endings, skipping blank lines', () => {
    const decoder = createLineDecoder({ onOversized: () => undefined });
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}\r\n\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.push(':3}')).toEqual([]);
    expect(decoder.end()).toEqual(['{"c":3}']);
  });

  it('handles a large message delivered byte by byte and in one piece', () => {
    const big = JSON.stringify({ text: 'x'.repeat(1_000_000) });
    const decoder = createLineDecoder({ onOversized: () => undefined });
    const lines: string[] = [];
    for (let start = 0; start < big.length; start += 65_536) lines.push(...decoder.push(big.slice(start, start + 65_536)));
    lines.push(...decoder.push('\n'));
    expect(lines).toEqual([big]);
    expect(createLineDecoder({ onOversized: () => undefined }).push(`${big}\n${big}\n`)).toEqual([big, big]);
  });

  it('drops a line longer than the limit, reports its size and keeps decoding after it', () => {
    const oversized: number[] = [];
    const decoder = createLineDecoder({ maxChars: 10, onOversized: chars => oversized.push(chars) });
    expect(decoder.push('0123456789ABCDEF')).toEqual([]);
    expect(decoder.push('GH\n{"ok":1}\n')).toEqual(['{"ok":1}']);
    expect(oversized).toEqual([18]);
  });
});
