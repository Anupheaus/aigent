/** JSON-RPC 2.0, as MCP uses it: messages, their classification and newline-delimited framing (stdio). */

export const JSON_RPC_VERSION = '2.0';
/** Longest frame a line decoder keeps (16 MiB); a longer line is dropped with a warning instead of growing without bound. */
export const MAX_FRAME_CHARS = 16 * 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResult {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResult | JsonRpcErrorResponse;

/** An incoming message after checking its shape. */
export type ClassifiedMessage =
  | { kind: 'result'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId | null; error: JsonRpcErrorObject }
  | { kind: 'request'; id: JsonRpcId; method: string; params?: Record<string, unknown> }
  | { kind: 'notification'; method: string; params?: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function paramsOf(value: Record<string, unknown>): { params?: Record<string, unknown> } {
  return isRecord(value.params) ? { params: value.params } : {};
}

function classifyError(value: Record<string, unknown>): ClassifiedMessage {
  const { error, id } = value;
  if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') return { kind: 'invalid', reason: 'error response without a numeric code and a message' };
  if (id !== null && !isId(id)) return { kind: 'invalid', reason: 'error response with an invalid id' };
  return { kind: 'error', id, error: { code: error.code, message: error.message, ...('data' in error ? { data: error.data } : {}) } };
}

/** What an incoming value is; anything that is not a valid JSON-RPC 2.0 message is `invalid`, with the reason. */
export function classifyMessage(value: unknown): ClassifiedMessage {
  if (!isRecord(value)) return { kind: 'invalid', reason: 'not a JSON object' };
  if (value.jsonrpc !== JSON_RPC_VERSION) return { kind: 'invalid', reason: `jsonrpc must be "${JSON_RPC_VERSION}"` };
  if ('error' in value) return classifyError(value);
  if ('result' in value) return isId(value.id) ? { kind: 'result', id: value.id, result: value.result } : { kind: 'invalid', reason: 'result without a valid id' };
  if (typeof value.method !== 'string') return { kind: 'invalid', reason: 'neither a response nor a method call' };
  if ('id' in value) return isId(value.id) ? { kind: 'request', id: value.id, method: value.method, ...paramsOf(value) } : { kind: 'invalid', reason: 'request with an invalid id' };
  return { kind: 'notification', method: value.method, ...paramsOf(value) };
}

/** One message as a stdio frame: compact JSON (which never contains a raw newline) and `\n`. */
export function encodeFrame(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export interface LineDecoder {
  /** Adds a chunk and returns every complete line in it (without the line ending, empty lines skipped). */
  push(chunk: string): string[];
  /** The unterminated rest, if any (the stream ended). */
  end(): string[];
}

/**
 * Splits a stream into lines whatever the chunk boundaries (`\n` or `\r\n` endings). A line longer than `maxChars`
 * is dropped as it grows and reported through `onOversized`, so a misbehaving server cannot exhaust memory.
 */
export function createLineDecoder(params: { maxChars?: number; onOversized(chars: number): void }): LineDecoder {
  const { maxChars = MAX_FRAME_CHARS, onOversized } = params;
  let pending = '';
  /** Characters of an oversized line seen so far; the rest of it is skipped up to its newline. */
  let skipping: number | undefined;

  function complete(line: string): string[] {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    return trimmed.trim() === '' ? [] : [trimmed];
  }

  function push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (let newline = rest.indexOf('\n'); newline !== -1; newline = rest.indexOf('\n')) {
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (skipping != null) { onOversized(skipping + piece.length); skipping = undefined; continue; }
      lines.push(...complete(pending + piece));
      pending = '';
    }
    if (skipping != null) { skipping += rest.length; return lines; }
    pending += rest;
    if (pending.length > maxChars) { skipping = pending.length; pending = ''; }
    return lines;
  }

  function end(): string[] {
    if (skipping != null) { onOversized(skipping); skipping = undefined; }
    const last = complete(pending);
    pending = '';
    return last;
  }

  return { push, end };
}
