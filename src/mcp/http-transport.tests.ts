import { describe, expect, it } from 'vitest';
import { createHttpTransport, MAX_HTTP_BODY_BYTES } from './http-transport.js';
import { createMcpClient } from './mcp-client.js';

interface Recorded {
  method: string;
  headers: Headers;
  body?: unknown;
}

const URL_ = 'https://mcp.test/mcp';
const CHUNK_BYTES = 1024 * 1024;

/** A body of `totalBytes` produced lazily in 1 MiB chunks (`prefix` first), counting how many bytes were pulled. */
function lazyBody(params: { prefix: string; totalBytes: number }): { body: ReadableStream<Uint8Array>; pulled(): number } {
  const { prefix, totalBytes } = params;
  const filler = new Uint8Array(CHUNK_BYTES).fill('x'.charCodeAt(0));
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: controller => {
      if (pulled >= totalBytes) { controller.close(); return; }
      const chunk = pulled === 0 ? new TextEncoder().encode(prefix) : filler;
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { body, pulled: () => pulled };
}
const SESSION = 'session-42';

/** A streamable-HTTP MCP server: initialize answered as JSON, tools/list and tools/call as SSE, notifications 202. */
function fakeServer(): { fetch: typeof fetch; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = init?.body == null ? undefined : JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name?: string } };
    recorded.push({ method, headers, ...(body == null ? {} : { body }) });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (body?.id == null) return new Response(null, { status: 202 });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': SESSION } });
    }
    if (body.params?.name === 'boom') return new Response('nope', { status: 500 });
    const result = body.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'streamed' }] };
    const sse = `event: message\ndata: not json\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`;
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: fakeFetch as typeof fetch, recorded };
}

describe('streamable HTTP transport', () => {
  it('posts messages, keeps the session id, reads JSON and SSE answers and ends the session on close', async () => {
    const { fetch, recorded } = fakeServer();
    const warnings: string[] = [];
    const client = createMcpClient({ transport: createHttpTransport({ type: 'http', url: URL_, headers: { authorization: 'Bearer t' }, fetch }), serverName: 'remote', warn: message => warnings.push(message) });
    await client.connect();
    expect((await client.listTools()).map(({ name }) => name)).toEqual(['echo']);
    expect((await client.callTool({ name: 'echo', args: {}, signal: new AbortController().signal })).content).toEqual([{ type: 'text', text: 'streamed' }]);
    await expect(client.callTool({ name: 'boom', args: {}, signal: new AbortController().signal })).rejects.toMatchObject({ init: { code: 'mcp_send_failed', message: "MCP server 'remote': could not send tools/call: HTTP 500 from https://mcp.test/mcp" } });
    await client.close();

    expect(recorded[0]?.headers.get('mcp-session-id')).toBeNull();
    expect(recorded[0]?.headers.get('accept')).toBe('application/json, text/event-stream');
    expect(recorded[0]?.headers.get('authorization')).toBe('Bearer t');
    expect(recorded.slice(1).every(({ headers }) => headers.get('mcp-session-id') === SESSION)).toBe(true);
    expect(recorded.at(-1)?.method).toBe('DELETE');
    expect(warnings).toContain("MCP server 'remote': ignored an event that is not valid JSON (8 characters)");
  });
  it('refuses a JSON response body larger than the cap without reading all of it', async () => {
    const huge = lazyBody({ prefix: '{"jsonrpc":"2.0","id":1,"result":"', totalBytes: MAX_HTTP_BODY_BYTES * 1.5 });
    const fakeFetch = (async () => new Response(huge.body, { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const transport = createHttpTransport({ type: 'http', url: URL_, fetch: fakeFetch });
    const delivered: unknown[] = [];
    await transport.start({ onMessage: message => delivered.push(message), onWarning: () => undefined, onClose: () => undefined });
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(`the response body from ${URL_} is larger than ${MAX_HTTP_BODY_BYTES} bytes`);
    expect(delivered).toEqual([]);
    expect(huge.pulled()).toBeLessThan(MAX_HTTP_BODY_BYTES + 2 * CHUNK_BYTES);
    await transport.close();
  });

  it('ends an event stream that grows past the cap, with a warning', async () => {
    const huge = lazyBody({ prefix: 'event: message\ndata: ', totalBytes: MAX_HTTP_BODY_BYTES * 1.5 });
    const fakeFetch = (async () => new Response(huge.body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    const transport = createHttpTransport({ type: 'http', url: URL_, fetch: fakeFetch });
    const warnings: string[] = [];
    let onWarned: () => void = () => undefined;
    const warned = new Promise<void>(resolve => { onWarned = resolve; });
    await transport.start({ onMessage: () => undefined, onWarning: message => { warnings.push(message); onWarned(); }, onClose: () => undefined });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await warned;
    expect(warnings).toEqual([`an event stream ended early: the event stream from ${URL_} is larger than ${MAX_HTTP_BODY_BYTES} bytes`]);
    expect(huge.pulled()).toBeLessThan(MAX_HTTP_BODY_BYTES + 2 * CHUNK_BYTES);
    await transport.close();
  }, 30_000);
});
