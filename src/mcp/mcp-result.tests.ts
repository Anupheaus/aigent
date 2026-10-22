import { describe, expect, it } from 'vitest';
import { mcpToolName, snakeCase } from './mcp-tool-name.js';
import { toToolResult } from './mcp-result.js';

describe('mcpToolName', () => {
  it.each([
    ['files', 'readFile', 'server', 'files__read_file'],
    ['My Server', 'read-file', 'server', 'my_server__read_file'],
    ['files', 'Read File!', 'none', 'read_file'],
    ['9lives', 'go', 'server', 'mcp_9lives__go'],
    ['files', '***', 'none', 'tool'],
  ] as const)('%s / %s (%s) -> %s', (server, tool, namePrefix, expected) => {
    expect(mcpToolName({ server, tool, namePrefix, taken: new Set() })).toBe(expected);
  });

  it('caps names at 64 characters and suffixes collisions within the cap', () => {
    const taken = new Set<string>();
    const long = 'x'.repeat(100);
    const first = mcpToolName({ server: 's', tool: long, namePrefix: 'server', taken });
    const second = mcpToolName({ server: 's', tool: long, namePrefix: 'server', taken });
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(second.endsWith('_2')).toBe(true);
    expect(mcpToolName({ server: 'a', tool: 'b', namePrefix: 'none', taken: new Set(['b', 'b_2']) })).toBe('b_3');
  });

  it('snake-cases mixed text', () => {
    expect(snakeCase('getHTTPResponse2Fast')).toBe('get_httpresponse2_fast');
  });
});

describe('toToolResult', () => {
  it('returns joined text when every part is text', () => {
    expect(toToolResult({ result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, server: 's', tool: 't' })).toBe('a\nb');
  });

  it('summarises binary parts as binary refs and keeps structured content', () => {
    const result = toToolResult({
      result: {
        content: [
          { type: 'text', text: 'see image' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a.bin', blob: 'AAAAAAAA', mimeType: 'application/octet-stream' } },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline text' } },
          { type: 'resource_link', uri: 'file:///b', name: 'b' },
        ],
        structuredContent: { count: 2 },
      },
      server: 's', tool: 't',
    });
    expect(result).toEqual({
      text: 'see image\ninline text',
      binaryRefs: [
        { type: 'binary-ref', kind: 'image', mimeType: 'image/png', sizeBytes: 3 },
        { type: 'binary-ref', kind: 'resource', uri: 'file:///a.bin', mimeType: 'application/octet-stream', sizeBytes: 6 },
        { type: 'binary-ref', kind: 'resource_link', uri: 'file:///b', name: 'b' },
      ],
      structuredContent: { count: 2 },
    });
  });

  it('turns isError into a structured failure with the server text', () => {
    expect(() => toToolResult({ result: { content: [{ type: 'text', text: 'disk full' }], isError: true }, server: 'files', tool: 'write' }))
      .toThrow(expect.objectContaining({ init: expect.objectContaining({ code: 'mcp_tool_error', message: "MCP tool 'write' of server 'files' reported an error: disk full" }) }));
  });
});
