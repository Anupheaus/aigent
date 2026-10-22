import { toolFailure } from '../tools/tool-failure.js';
import type { McpCallResult } from './mcp-client.js';

/** Longest server error text kept in a failure message. */
const MAX_ERROR_TEXT_CHARS = 2_000;
/** Base64 carries 3 bytes in every 4 characters. */
const BASE64_BYTES_PER_CHAR = 3 / 4;

/** A non-text part of an MCP result, summarised (its bytes are never put in front of the model). */
export interface McpBinaryRef {
  type: 'binary-ref';
  /** The MCP content type: `image`, `audio`, `resource`, `resource_link` or what the server sent. */
  kind: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  /** Approximate decoded size of inline base64 data. */
  sizeBytes?: number;
}

/** A tool result with more than text: the text parts joined, plus summaries and structured content. */
export interface McpRichResult {
  text: string;
  binaryRefs?: McpBinaryRef[];
  structuredContent?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

function binaryRef(part: Record<string, unknown>): McpBinaryRef {
  const source = isRecord(part.resource) ? part.resource : part;
  const data = typeof source.data === 'string' ? source.data : typeof source.blob === 'string' ? source.blob : undefined;
  return {
    type: 'binary-ref', kind: typeof part.type === 'string' ? part.type : 'unknown',
    ...stringField(source, 'mimeType'), ...stringField(source, 'uri'), ...stringField(source, 'name'),
    ...(data == null ? {} : { sizeBytes: Math.floor(data.length * BASE64_BYTES_PER_CHAR) }),
  };
}

/** The text of a part, when it has one: a text part, or an embedded text resource. */
function textOf(part: Record<string, unknown>): string | undefined {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'resource' && isRecord(part.resource) && typeof part.resource.text === 'string') return part.resource.text;
  return undefined;
}

/**
 * What the model receives for an MCP result: the text parts joined (a plain string when that is all there is), other
 * parts as `binary-ref` summaries. `isError` becomes a structured failure carrying the server's text.
 */
export function toToolResult(params: { result: McpCallResult; server: string; tool: string }): string | McpRichResult {
  const { result: { content, isError, structuredContent }, server, tool } = params;
  const parts = content.filter(isRecord);
  const texts = parts.flatMap(part => { const text = textOf(part); return text == null ? [] : [text]; });
  const text = texts.join('\n');
  if (isError === true) {
    const reported = text === '' ? '(the server gave no text)' : text.slice(0, MAX_ERROR_TEXT_CHARS);
    throw toolFailure({ code: 'mcp_tool_error', message: `MCP tool '${tool}' of server '${server}' reported an error: ${reported}`, details: { server, tool } });
  }
  const binaryRefs = parts.filter(part => textOf(part) == null).map(binaryRef);
  if (binaryRefs.length === 0 && structuredContent === undefined) return text;
  return { text, ...(binaryRefs.length === 0 ? {} : { binaryRefs }), ...(structuredContent === undefined ? {} : { structuredContent }) };
}
