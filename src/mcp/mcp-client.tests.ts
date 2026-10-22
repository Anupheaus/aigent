import { describe, expect, it } from 'vitest';
import { createFakeMcpServer } from './fake-mcp-server.test-support.js';
import { createMcpClient, MCP_PROTOCOL_VERSION } from './mcp-client.js';
import type { McpClient } from './mcp-client.js';
import type { FakeMcpServer, FakeMcpTool } from './fake-mcp-server.test-support.js';

const ECHO: FakeMcpTool = { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };

interface Connected {
  client: McpClient;
  fake: FakeMcpServer;
  warnings: string[];
}

async function connected(tools: FakeMcpTool[] = [ECHO], options: { pageSize?: number; requestTimeoutMs?: number } = {}): Promise<Connected> {
  const fake = createFakeMcpServer({ tools, ...(options.pageSize == null ? {} : { pageSize: options.pageSize }) });
  const warnings: string[] = [];
  const client = createMcpClient({ transport: fake.transport, serverName: 'files', warn: message => warnings.push(message), ...(options.requestTimeoutMs == null ? {} : { requestTimeoutMs: options.requestTimeoutMs }) });
  await client.connect();
  return { client, fake, warnings };
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

describe('createMcpClient', () => {
  it('initializes with the protocol version, then sends notifications/initialized', async () => {
    const { fake } = await connected();
    expect(fake.received[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'aigent' } } });
    expect(fake.received[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
  });

  it('lists tools across pages', async () => {
    const tools = ['a', 'b', 'c'].map(name => ({ ...ECHO, name }));
    const { client } = await connected(tools, { pageSize: 2 });
    expect((await client.listTools()).map(({ name }) => name)).toEqual(['a', 'b', 'c']);
  });

  it('correlates concurrent responses by id, whatever order they arrive in', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow: FakeMcpTool = { ...ECHO, name: 'slow', handler: () => new Promise(resolve => { releaseSlow = () => resolve({ content: [{ type: 'text', text: 'slow' }] }); }) };
    const fast: FakeMcpTool = { ...ECHO, name: 'fast', handler: () => ({ content: [{ type: 'text', text: 'fast' }] }) };
    const { client } = await connected([slow, fast]);
    const signal = new AbortController().signal;
    const slowCall = client.callTool({ name: 'slow', args: {}, signal });
    const fastResult = await client.callTool({ name: 'fast', args: {}, signal });
    expect(fastResult.content).toEqual([{ type: 'text', text: 'fast' }]);
    releaseSlow?.();
    expect((await slowCall).content).toEqual([{ type: 'text', text: 'slow' }]);
  });

  it('turns a JSON-RPC error into a structured failure with the server message', async () => {
    const { client } = await connected();
    await expect(client.callTool({ name: 'missing', args: {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ isToolFailure: true, init: { code: 'mcp_error', message: "MCP server 'files' answered tools/call with error -32602: Unknown tool: missing" } });
  });

  it('fails pending calls with a structured failure when the server crashes mid-call, and refuses later calls', async () => {
    const crashing: FakeMcpTool = { ...ECHO, name: 'crash', handler: (_args, server) => { server.crash('exit code 3'); return never(); } };
    const { client } = await connected([crashing]);
    const signal = new AbortController().signal;
    await expect(client.callTool({ name: 'crash', args: {}, signal })).rejects.toMatchObject({ init: { code: 'mcp_server_exited', retryable: false, message: "MCP server 'files' exited while tools/call was pending: exit code 3" } });
    await expect(client.callTool({ name: 'crash', args: {}, signal })).rejects.toMatchObject({ init: { code: 'mcp_server_exited' } });
  });

  it('ignores malformed and unknown messages with a warning and keeps working', async () => {
    const { client, fake, warnings } = await connected();
    fake.server.sendRaw('{not json');
    fake.server.send({ hello: 'world' });
    fake.server.send({ jsonrpc: '2.0', id: 999, result: {} });
    fake.server.send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
    const result = await client.callTool({ name: 'echo', args: { text: 'still fine' }, signal: new AbortController().signal });
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"still fine"}' }]);
    expect(warnings).toEqual([
      "MCP server 'files': ignored a frame that is not valid JSON (9 characters)",
      "MCP server 'files': ignored an invalid JSON-RPC message (jsonrpc must be \"2.0\")",
      "MCP server 'files': ignored a response to unknown request id 999",
    ]);
  });

  it('rejects a tools/call result that is not an MCP result as malformed', async () => {
    const bad: FakeMcpTool = { ...ECHO, name: 'bad', handler: () => ({ content: 'nope' as unknown as unknown[] }) };
    const { client } = await connected([bad]);
    await expect(client.callTool({ name: 'bad', args: {}, signal: new AbortController().signal })).rejects.toMatchObject({ init: { code: 'mcp_malformed_result' } });
  });

  it('on abort, sends notifications/cancelled for the request and rejects as aborted', async () => {
    const hanging: FakeMcpTool = { ...ECHO, name: 'hang', handler: () => never() };
    const { client, fake } = await connected([hanging]);
    const controller = new AbortController();
    const call = client.callTool({ name: 'hang', args: {}, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort('stopped by the user');
    await expect(call).rejects.toMatchObject({ init: { category: 'aborted', code: 'mcp_cancelled' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    const callId = (fake.received.find(message => 'method' in message && message.method === 'tools/call') as { id: number }).id;
    expect(fake.cancelled).toEqual([callId]);
  });

  it('times out requests other than tools/call after requestTimeoutMs', async () => {
    const fake = createFakeMcpServer({ tools: [] });
    fake.server.onMessage(() => undefined);
    const client = createMcpClient({ transport: fake.transport, serverName: 'silent', warn: () => undefined, requestTimeoutMs: 20 });
    await expect(client.connect()).rejects.toMatchObject({ init: { code: 'mcp_timeout', message: "MCP server 'silent' did not answer initialize within 20 ms" } });
  });

  it('closes the transport once and fails pending calls as closed', async () => {
    const hanging: FakeMcpTool = { ...ECHO, name: 'hang', handler: () => never() };
    const { client, fake } = await connected([hanging]);
    const call = client.callTool({ name: 'hang', args: {}, signal: new AbortController().signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.all([client.close(), client.close()]);
    await expect(call).rejects.toMatchObject({ init: { code: 'mcp_closed' } });
    expect(fake.server.closeCount()).toBe(1);
    expect(fake.server.isOpen()).toBe(false);
  });
});
