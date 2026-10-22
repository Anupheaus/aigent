import { parseSse } from '../providers/sse-parser.js';
import type { JsonRpcMessage } from './json-rpc.js';
import type { McpTransport, McpTransportHandlers } from './mcp-transport.js';
import type { McpHttpTransportConfig } from './mcp-types.js';

/** The streamable-HTTP session header. */
const SESSION_HEADER = 'mcp-session-id';
const JSON_TYPE = 'application/json';
const SSE_TYPE = 'text/event-stream';
const NO_CONTENT = 202;

/**
 * MCP over streamable HTTP: each message is a POST; a response body is JSON (one message or a batch) or an SSE stream
 * of messages. The session id the server issues is sent back on every request; `close()` aborts in-flight bodies and
 * ends the session with a DELETE.
 */
export function createHttpTransport(config: McpHttpTransportConfig): McpTransport {
  const { url, headers = {}, fetch: fetchImpl = fetch } = config;
  const controller = new AbortController();
  let handlers: McpTransportHandlers | undefined;
  let sessionId: string | undefined;
  let isClosed = false;

  function requestHeaders(): Record<string, string> {
    return { ...headers, 'content-type': JSON_TYPE, accept: `${JSON_TYPE}, ${SSE_TYPE}`, ...(sessionId == null ? {} : { [SESSION_HEADER]: sessionId }) };
  }

  function deliver(value: unknown): void {
    for (const message of Array.isArray(value) ? value : [value]) handlers?.onMessage(message);
  }

  async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const { data } of parseSse(body)) {
        if (data.trim() === '') continue;
        try {
          deliver(JSON.parse(data));
        } catch {
          handlers?.onWarning(`ignored an event that is not valid JSON (${data.length} characters)`);
        }
      }
    } catch (error) {
      if (!isClosed) handlers?.onWarning(`an event stream ended early: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function send(message: JsonRpcMessage): Promise<void> {
    if (isClosed) throw new Error('the HTTP transport is closed');
    const response = await fetchImpl(url, { method: 'POST', headers: requestHeaders(), body: JSON.stringify(message), signal: controller.signal });
    sessionId = response.headers.get(SESSION_HEADER) ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    if (response.status === NO_CONTENT || response.body == null) return;
    const type = response.headers.get('content-type') ?? '';
    // Read in the background: an SSE response can carry the answer long after the request was accepted.
    if (type.includes(SSE_TYPE)) { void readStream(response.body); return; }
    const text = await response.text();
    if (text.trim() === '') return;
    try {
      deliver(JSON.parse(text));
    } catch {
      handlers?.onWarning(`ignored a response body that is not valid JSON (${text.length} characters)`);
    }
  }

  async function close(): Promise<void> {
    if (isClosed) return;
    isClosed = true;
    controller.abort();
    if (sessionId == null) return;
    // Ending the session is a courtesy to the server; a failure changes nothing here.
    await fetchImpl(url, { method: 'DELETE', headers: { ...headers, [SESSION_HEADER]: sessionId } }).then(response => response.body?.cancel(), () => undefined).catch(() => undefined);
  }

  return { start: async startHandlers => { handlers = startHandlers; }, send, close };
}
