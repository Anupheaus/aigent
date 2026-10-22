import type { JsonRpcMessage } from './json-rpc.js';
import type { McpTransport, McpTransportHandlers } from './mcp-transport.js';

/** The server side of an in-memory transport pair: what a fake MCP server talks through. */
export interface MemoryServerEnd {
  /** Receives every message the client sends, in order. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Delivers a message to the client (asynchronously, like a real connection). */
  send(message: unknown): void;
  /** Delivers a raw text frame, parsed like a stdio line; malformed text reaches the client as a warning. */
  sendRaw(frame: string): void;
  /** Ends the connection from the server side, as a crash or exit would. */
  crash(reason?: string): void;
  /** Whether the client has started the connection and not yet closed it. */
  isOpen(): boolean;
  /** How many times the client called `close()`. */
  closeCount(): number;
}

/** A connected in-memory client transport and server end, for testing MCP clients without processes or sockets. */
export interface MemoryTransportPair {
  client: McpTransport;
  server: MemoryServerEnd;
}

const DEFAULT_CRASH_REASON = 'the server connection ended';

/** Creates a connected client transport and server end; nothing crosses until the client calls `start`. */
export function createMemoryTransportPair(): MemoryTransportPair {
  let handlers: McpTransportHandlers | undefined;
  let serverHandler: ((message: JsonRpcMessage) => void) | undefined;
  let isOpen = false;
  let closes = 0;

  const deliver = (action: (open: McpTransportHandlers) => void): void => {
    queueMicrotask(() => { if (isOpen && handlers != null) action(handlers); });
  };

  const client: McpTransport = {
    start: async startHandlers => { handlers = startHandlers; isOpen = true; },
    send: async message => {
      if (!isOpen) throw new Error('memory transport is closed');
      // A copy, so neither side can change the other's objects.
      const copy = structuredClone(message);
      queueMicrotask(() => serverHandler?.(copy));
    },
    close: async () => { closes += 1; isOpen = false; },
  };

  const server: MemoryServerEnd = {
    onMessage: handler => { serverHandler = handler; },
    send: message => { const copy = structuredClone(message); deliver(open => open.onMessage(copy)); },
    sendRaw: frame => deliver(open => {
      try {
        open.onMessage(JSON.parse(frame));
      } catch {
        // The same treatment the stdio transport gives a line that is not JSON.
        open.onWarning(`ignored a frame that is not valid JSON (${frame.length} characters)`);
      }
    }),
    crash: (reason = DEFAULT_CRASH_REASON) => deliver(open => { isOpen = false; open.onClose(reason); }),
    isOpen: () => isOpen,
    closeCount: () => closes,
  };

  return { client, server };
}
