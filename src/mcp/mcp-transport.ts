import type { JsonRpcMessage } from './json-rpc.js';

/** What a transport reports to its client. */
export interface McpTransportHandlers {
  /** One parsed incoming message (not yet checked: the client classifies it). */
  onMessage(message: unknown): void;
  /** The connection ended without `close()` (the server exited or crashed); `reason` says how. Called at most once. */
  onClose(reason: string): void;
  /** Something was dropped (malformed JSON, an oversized frame) without ending the connection. */
  onWarning(message: string): void;
}

/**
 * The byte-level connection to one MCP server. Implementations: stdio (`child_process`), streamable HTTP (`fetch`),
 * and an in-memory pair for tests (`createMemoryTransportPair` in `@anupheaus/aigent/testing`).
 */
export interface McpTransport {
  /** Opens the connection (spawns the process, ...); called once, before the first `send`. */
  start(handlers: McpTransportHandlers): Promise<void>;
  /** Sends one message; rejects when it cannot be delivered (the client then fails that request). */
  send(message: JsonRpcMessage): Promise<void>;
  /** Ends the connection and releases everything it holds (a stdio server's whole process tree). Idempotent. */
  close(): Promise<void>;
}
