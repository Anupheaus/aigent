import { LIBRARY_VERSION } from '../core/library-version.js';
import { toolFailure } from '../tools/tool-failure.js';
import type { ToolFailure, ToolFailureInit } from '../tools/tool-failure.js';
import { classifyMessage, JSON_RPC_VERSION } from './json-rpc.js';
import type { JsonRpcId, JsonRpcMessage } from './json-rpc.js';
import type { McpTransport } from './mcp-transport.js';

/** The MCP revision this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Default limit for requests other than `tools/call` (whose limit is the tool's timeout, through its signal). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_NAME = 'aigent';
/** JSON-RPC "method not found", answered to server requests this client does not support. */
const METHOD_NOT_FOUND = -32_601;

/** One tool as `tools/list` describes it. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A `tools/call` result. */
export interface McpCallResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClient {
  /** Starts the transport, then `initialize` and `notifications/initialized`. */
  connect(): Promise<void>;
  /** Every tool the server offers, following `nextCursor` pages. */
  listTools(): Promise<McpToolDescriptor[]>;
  /** Calls a tool; an abort sends `notifications/cancelled` and rejects. Failures are `ToolFailure`s. */
  callTool(params: { name: string; args: unknown; signal: AbortSignal }): Promise<McpCallResult>;
  /** Fails pending requests and closes the transport (once). */
  close(): Promise<void>;
}

export interface CreateMcpClientParams {
  transport: McpTransport;
  /** For messages: `MCP server '<name>'`. */
  serverName: string;
  /** Receives what was ignored (malformed messages, unknown ids, transport warnings). */
  warn(message: string): void;
  requestTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(failure: ToolFailure): void;
}

interface RequestParams {
  method: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Default `requestTimeoutMs`; `tools/call` passes none (its signal bounds it). */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON-RPC 2.0 client for one MCP server: request/response correlation, cancellation and failure mapping. */
export function createMcpClient(params: CreateMcpClientParams): McpClient {
  const { transport, serverName, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = params;
  const label = `MCP server '${serverName}'`;
  const warn = (message: string): void => params.warn(`${label}: ${message}`);
  const pending = new Map<JsonRpcId, Pending>();
  let nextId = 0;
  /** Why requests are refused: set when the server exits or `close()` is called. */
  let ended: ToolFailureInit | undefined;
  let closing: Promise<void> | undefined;

  const failure = (init: ToolFailureInit): ToolFailure => toolFailure(init);

  function endAll(init: (method: string) => ToolFailureInit): void {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(failure(init(entry.method)));
    }
  }

  function onMessage(raw: unknown): void {
    const message = classifyMessage(raw);
    if (message.kind === 'invalid') { warn(`ignored an invalid JSON-RPC message (${message.reason})`); return; }
    if (message.kind === 'notification') return;
    if (message.kind === 'request') {
      // `ping` must be answered; nothing else is offered to servers (no sampling, roots or elicitation).
      const reply: JsonRpcMessage = message.method === 'ping'
        ? { jsonrpc: JSON_RPC_VERSION, id: message.id, result: {} }
        : { jsonrpc: JSON_RPC_VERSION, id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not supported by this client: ${message.method}` } };
      transport.send(reply).catch(() => undefined);
      return;
    }
    const entry = message.id == null ? undefined : pending.get(message.id);
    if (entry == null || message.id == null) { warn(`ignored a response to unknown request id ${String(message.id)}`); return; }
    pending.delete(message.id);
    if (message.kind === 'result') { entry.resolve(message.result); return; }
    const { code, message: text } = message.error;
    entry.reject(failure({ code: 'mcp_error', message: `${label} answered ${entry.method} with error ${code}: ${text}`, details: { server: serverName, errorCode: code } }));
  }

  function onClose(reason: string): void {
    ended ??= { code: 'mcp_server_exited', message: `${label} exited: ${reason}`, details: { server: serverName } };
    endAll(method => ({ code: 'mcp_server_exited', retryable: false, message: `${label} exited while ${method} was pending: ${reason}`, details: { server: serverName } }));
  }

  function request(requestParams: RequestParams): Promise<unknown> {
    const { method, signal, timeoutMs = requestTimeoutMs } = requestParams;
    if (ended != null) return Promise.reject(failure(ended));
    nextId += 1;
    const id = nextId;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        cleanup();
        transport.send({ jsonrpc: JSON_RPC_VERSION, method: 'notifications/cancelled', params: { requestId: id, reason: String(signal?.reason ?? 'aborted') } }).catch(() => undefined);
        reject(failure({ category: 'aborted', code: 'mcp_cancelled', message: `${label}: ${method} was cancelled (${String(signal?.reason ?? 'aborted')})`, details: { server: serverName } }));
      };
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      pending.set(id, { method, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      if (signal != null) {
        if (signal.aborted) { queueMicrotask(onAbort); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const entry = pending.get(id);
          if (entry == null) return;
          pending.delete(id);
          entry.reject(failure({ code: 'mcp_timeout', retryable: true, message: `${label} did not answer ${method} within ${timeoutMs} ms`, details: { server: serverName } }));
        }, timeoutMs);
      }
      transport.send({ jsonrpc: JSON_RPC_VERSION, id, method, ...(requestParams.params == null ? {} : { params: requestParams.params }) }).catch((error: unknown) => {
        const entry = pending.get(id);
        if (entry == null) return;
        pending.delete(id);
        entry.reject(failure({ code: 'mcp_send_failed', retryable: true, message: `${label}: could not send ${method}: ${error instanceof Error ? error.message : String(error)}`, details: { server: serverName } }));
      });
    });
  }

  async function connect(): Promise<void> {
    await transport.start({ onMessage, onClose, onWarning: warn });
    await request({ method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: LIBRARY_VERSION } } });
    await transport.send({ jsonrpc: JSON_RPC_VERSION, method: 'notifications/initialized' });
  }

  async function listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const result = await request({ method: 'tools/list', ...(cursor == null ? {} : { params: { cursor } }) });
      if (!isRecord(result) || !Array.isArray(result.tools)) throw failure({ code: 'mcp_malformed_result', message: `${label} answered tools/list without a tools array`, details: { server: serverName } });
      for (const entry of result.tools) {
        if (isRecord(entry) && typeof entry.name === 'string') tools.push({ name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}), inputSchema: entry.inputSchema });
        else warn('ignored a tools/list entry without a name');
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
    } while (cursor != null);
    return tools;
  }

  async function callTool(callParams: { name: string; args: unknown; signal: AbortSignal }): Promise<McpCallResult> {
    const { name, args, signal } = callParams;
    const result = await request({ method: 'tools/call', params: { name, arguments: args }, signal, timeoutMs: Number.POSITIVE_INFINITY });
    if (!isRecord(result) || !Array.isArray(result.content)) throw failure({ code: 'mcp_malformed_result', message: `${label} answered tools/call for '${name}' without a content array`, details: { server: serverName, tool: name } });
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}), ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}) };
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      ended ??= { code: 'mcp_closed', message: `${label} was closed`, details: { server: serverName } };
      endAll(method => ({ code: 'mcp_closed', message: `${label} was closed while ${method} was pending`, details: { server: serverName } }));
      await transport.close();
    })();
    return closing;
  }

  return { connect, listTools, callTool, close };
}
