import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { McpPluginOptions } from './mcp-types.js';

/** Server names: letters, digits, `-` and `_`, starting with a letter or digit. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const positiveInteger = z.number().int().positive();
const fn = z.custom<(...args: never[]) => unknown>(value => typeof value === 'function', { message: 'must be a function' });

const flagsShape = z.strictObject({
  deterministic: z.boolean().optional(),
  cache: z.boolean().optional(),
  cacheTtlMs: positiveInteger.optional(),
  timeoutMs: positiveInteger.optional(),
  maxResultTokens: positiveInteger.optional(),
  readOnly: z.boolean().optional(),
  strictSchema: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
});

const transportShape = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().min(1).optional() }),
  z.strictObject({ type: z.literal('http'), url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()).optional(), fetch: fn.optional() }),
  z.strictObject({ type: z.literal('custom'), transport: z.looseObject({ start: fn, send: fn, close: fn }) }),
]);

const optionsShape = z.strictObject({
  name: z.string().optional(),
  servers: z.array(z.strictObject({
    name: z.string().regex(SERVER_NAME_PATTERN, { message: `server name must match ${SERVER_NAME_PATTERN}` }),
    transport: transportShape,
    allowTools: z.array(z.string()).optional(),
    denyTools: z.array(z.string()).optional(),
    approvals: z.boolean().optional(),
  })).min(1),
  defaults: flagsShape.omit({ readOnly: true, strictSchema: true, requiresApproval: true }).optional(),
  toolOverrides: z.record(z.string(), flagsShape).optional(),
  namePrefix: z.enum(['server', 'none']).optional(),
  onWarning: fn.optional(),
});

function invalid(message: string, details: Record<string, unknown> = {}): Error {
  return createAigentError({ code: 'invalid_definition', message: `mcpPlugin: ${message}`, details });
}

/** Validates `mcpPlugin` options: shapes, unique server names, and overrides that would cache or replay a mutating tool. */
export function parseMcpOptions(options: McpPluginOptions): McpPluginOptions {
  const parsed = optionsShape.safeParse(options);
  if (!parsed.success) throw invalid(describeIssues(parsed.error));
  const names = new Set<string>();
  for (const { name } of options.servers) {
    if (names.has(name)) throw invalid(`server name '${name}' is used twice; server names must be unique`, { server: name });
    names.add(name);
  }
  for (const [tool, flags] of Object.entries(options.toolOverrides ?? {})) {
    if ((flags.cache === true || flags.deterministic === true) && flags.readOnly !== true) {
      throw invalid(`toolOverrides['${tool}'] sets cache or deterministic without readOnly: true; MCP tools are assumed to have side effects, which must never be cached or replayed`, { tool });
    }
  }
  return options;
}
