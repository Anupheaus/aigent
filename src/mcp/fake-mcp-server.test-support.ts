import { createMemoryTransportPair } from './memory-transport.js';
import type { MemoryServerEnd } from './memory-transport.js';
import type { JsonRpcId, JsonRpcMessage } from './json-rpc.js';
import type { McpTransport } from './mcp-transport.js';

/** What a fake tool returns: an MCP `tools/call` result. */
export interface FakeCallResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Default: echoes the arguments as one text part. A promise that never settles leaves the call unanswered. */
  handler?(args: Record<string, unknown>, server: MemoryServerEnd): FakeCallResult | Promise<FakeCallResult>;
}

export interface FakeMcpServerOptions {
  tools: FakeMcpTool[];
  /** Tools per `tools/list` page (default: all on one page). */
  pageSize?: number;
  /** Answer `initialize` with this JSON-RPC error instead. */
  failInitialize?: { code: number; message: string };
}

export interface FakeMcpServer {
  transport: McpTransport;
  server: MemoryServerEnd;
  /** Every message the client sent, in order. */
  received: JsonRpcMessage[];
  /** Request ids named by `notifications/cancelled`. */
  cancelled: JsonRpcId[];
}

function textResult(text: string): FakeCallResult {
  return { content: [{ type: 'text', text }] };
}

/** An in-memory MCP server speaking initialize, tools/list (paged), tools/call and notifications. */
export function createFakeMcpServer(options: FakeMcpServerOptions): FakeMcpServer {
  const { tools, pageSize = tools.length || 1, failInitialize } = options;
  const { client, server } = createMemoryTransportPair();
  const received: JsonRpcMessage[] = [];
  const cancelled: JsonRpcId[] = [];
  const respond = (id: JsonRpcId, result: unknown): void => server.send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcId, error: { code: number; message: string }): void => server.send({ jsonrpc: '2.0', id, error });

  async function handleCall(id: JsonRpcId, params: Record<string, unknown>): Promise<void> {
    const tool = tools.find(({ name }) => name === params.name);
    if (tool == null) { fail(id, { code: -32602, message: `Unknown tool: ${String(params.name)}` }); return; }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = await (tool.handler?.(args, server) ?? textResult(JSON.stringify(args)));
    respond(id, result);
  }

  server.onMessage(message => {
    received.push(message);
    if (!('method' in message)) return;
    const params = message.params ?? {};
    if (!('id' in message)) {
      if (message.method === 'notifications/cancelled') cancelled.push(params.requestId as JsonRpcId);
      return;
    }
    const { id, method } = message;
    if (method === 'initialize') {
      if (failInitialize != null) { fail(id, failInitialize); return; }
      respond(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } });
      return;
    }
    if (method === 'tools/list') {
      const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
      const page = tools.slice(start, start + pageSize).map(({ name, description, inputSchema }) => ({ name, ...(description == null ? {} : { description }), inputSchema }));
      const next = start + pageSize < tools.length ? { nextCursor: String(start + pageSize) } : {};
      respond(id, { tools: page, ...next });
      return;
    }
    if (method === 'tools/call') { void handleCall(id, params); return; }
    fail(id, { code: -32601, message: `Method not found: ${method}` });
  });

  return { transport: client, server, received, cancelled };
}
