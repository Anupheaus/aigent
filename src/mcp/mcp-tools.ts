import { z } from 'zod';
import { hashSchema } from '../cache/cache-key.js';
import { defineTool } from '../tools/define-tool.js';
import type { Tool } from '../tools/tool-types.js';
import type { JsonSchema } from '../providers/provider-types.js';
import type { McpClient, McpToolDescriptor } from './mcp-client.js';
import { toToolResult } from './mcp-result.js';
import { MAX_DESCRIPTION_CHARS, MAX_PROPERTY_DESCRIPTION_CHARS, sanitiseServerText } from './mcp-text.js';
import { mcpToolName } from './mcp-tool-name.js';
import type { McpDefaults, McpServerConfig, McpSkippedTool, McpToolFlags, McpToolReport } from './mcp-types.js';
import { schemaToStrict } from './schema-to-strict.js';

/** Default tool timeout for MCP calls. */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
/** Default lifetime of cached results of read-only, non-deterministic tools. */
export const DEFAULT_MCP_CACHE_TTL_MS = 60_000;

export interface ConvertServerToolsParams {
  server: McpServerConfig;
  descriptors: McpToolDescriptor[];
  client: McpClient;
  defaults: McpDefaults;
  toolOverrides: Record<string, Partial<McpToolFlags>>;
  namePrefix: 'server' | 'none';
  /** Names already used across the plugin (and the reserved built-ins); updated. */
  taken: Set<string>;
}

export interface ConvertedServerTools {
  tools: Tool[];
  report: McpToolReport[];
  skipped: McpSkippedTool[];
}

interface ToolPlan {
  name: string;
  mcpName: string;
  flags: McpToolFlags;
  description: string;
}

function resolveFlags(params: { name: string; mcpName: string; convert: ConvertServerToolsParams }): McpToolFlags {
  const { name, mcpName, convert: { server, defaults, toolOverrides } } = params;
  const override = toolOverrides[name] ?? toolOverrides[`${server.name}/${mcpName}`] ?? {};
  const readOnly = override.readOnly ?? false;
  // Caching or calling a mutating tool deterministic would replay or skip real effects, so both need readOnly.
  return {
    readOnly,
    cache: readOnly && (override.cache ?? defaults.cache ?? false),
    deterministic: readOnly && (override.deterministic ?? defaults.deterministic ?? false),
    cacheTtlMs: override.cacheTtlMs ?? defaults.cacheTtlMs ?? DEFAULT_MCP_CACHE_TTL_MS,
    timeoutMs: override.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    maxResultTokens: override.maxResultTokens ?? defaults.maxResultTokens ?? Number.NaN,
    strictSchema: override.strictSchema ?? true,
    requiresApproval: override.requiresApproval ?? server.approvals === true,
  };
}

function buildTool(params: { plan: ToolPlan; args: z.ZodType; client: McpClient; server: string }): Tool {
  const { plan: { name, mcpName, flags, description }, args, client, server } = params;
  const { cache, deterministic, cacheTtlMs, timeoutMs, maxResultTokens, readOnly, strictSchema, requiresApproval } = flags;
  return defineTool({
    name, description, args, deterministic, cache, ...(cache && !deterministic ? { cacheTtlMs } : {}),
    hasSideEffects: !readOnly, timeoutMs, ...(Number.isNaN(maxResultTokens) ? {} : { maxResultTokens }),
    contentKind: 'prose', fidelity: 'verbatim', strictSchema, ...(requiresApproval ? { requiresApproval } : {}),
    describeActivity: () => ({ title: `MCP ${server}: ${mcpName}` }),
    run: async (callArgs, context) => {
      // The executor's timeout does not stop a tool, so the call bounds itself and tells the server to cancel.
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      const result = await client.callTool({ name: mcpName, args: callArgs, signal });
      return toToolResult({ result, server, tool: mcpName });
    },
  });
}

/** Schema keywords whose string value is free text the model reads. */
const TEXT_KEYWORDS = new Set(['title', 'description', '$comment']);

/** A copy of a loose schema with every free-text annotation sanitised like an argument description. */
function sanitiseLooseSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitiseLooseSchema);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    TEXT_KEYWORDS.has(key) && typeof value === 'string' ? sanitiseServerText({ text: value, maxChars: MAX_PROPERTY_DESCRIPTION_CHARS }) : sanitiseLooseSchema(value),
  ]));
}

/** The server's own schema (its text sanitised), sent with strict decoding off (`strictSchema: false` overrides). */
function looseTool(params: { plan: ToolPlan; inputSchema: unknown; client: McpClient; server: string }): Tool {
  const { inputSchema, ...rest } = params;
  const tool = buildTool({ ...rest, args: z.looseObject({}) });
  const { $schema: _meta, ...jsonSchema } = sanitiseLooseSchema(typeof inputSchema === 'object' && inputSchema !== null ? inputSchema : { type: 'object' }) as JsonSchema;
  return { ...tool, jsonSchema, schemaHash: hashSchema(jsonSchema) };
}

function skipReason(params: { server: McpServerConfig; mcpName: string }): string | undefined {
  const { server: { allowTools, denyTools }, mcpName } = params;
  if (denyTools?.includes(mcpName) === true) return 'listed in denyTools';
  if (allowTools != null && !allowTools.includes(mcpName)) return 'not listed in allowTools';
  return undefined;
}

/** Turns one server's listed tools into strict aigent tools, with what was skipped and why. */
export function convertServerTools(params: ConvertServerToolsParams): ConvertedServerTools {
  const { server, descriptors, client, namePrefix, taken } = params;
  const converted: ConvertedServerTools = { tools: [], report: [], skipped: [] };
  for (const descriptor of descriptors) {
    const { name: mcpName, inputSchema } = descriptor;
    const denied = skipReason({ server, mcpName });
    if (denied != null) { converted.skipped.push({ server: server.name, mcpName, reason: denied }); continue; }
    const conversion = schemaToStrict(inputSchema);
    const probeName = mcpToolName({ server: server.name, tool: mcpName, namePrefix, taken: new Set(taken) });
    const flags = resolveFlags({ name: probeName, mcpName, convert: params });
    if (conversion.kind === 'rejected' && flags.strictSchema) {
      converted.skipped.push({ server: server.name, mcpName, reason: `schema not expressible in the strict subset (${conversion.reason}); allow it with toolOverrides: { strictSchema: false }` });
      continue;
    }
    const name = mcpToolName({ server: server.name, tool: mcpName, namePrefix, taken });
    const description = sanitiseServerText({ text: `[MCP server '${server.name}'] ${descriptor.description ?? mcpName}`, maxChars: MAX_DESCRIPTION_CHARS });
    const plan: ToolPlan = { name, mcpName, flags, description };
    const isLoose = !flags.strictSchema || conversion.kind === 'rejected';
    converted.tools.push(conversion.kind === 'rejected' || isLoose ? looseTool({ plan, inputSchema, client, server: server.name }) : buildTool({ plan, args: conversion.args, client, server: server.name }));
    const changes = conversion.kind === 'strict' && !isLoose ? conversion.changes : [];
    converted.report.push({
      name, server: server.name, mcpName, schema: isLoose ? 'loose' : changes.length === 0 ? 'accepted' : 'tightened', changes,
      readOnly: flags.readOnly, cache: flags.cache, deterministic: flags.deterministic, requiresApproval: flags.requiresApproval,
    });
  }
  return converted;
}
