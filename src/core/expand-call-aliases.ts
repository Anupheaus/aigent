import type { ToolCall } from '../providers/provider-types.js';
import { expandAliases } from '../shapers/alias-table.js';
import type { AliasTable } from '../shapers/alias-table.js';
import { MULTI_TOOL_NAME } from '../tools/multi-tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export interface ExpandCallAliasesParams {
  call: ToolCall;
  registry: ToolRegistry;
  aliases: AliasTable;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Expands the arguments only for a tool that opted in with `acceptsAliases`; anything else is passed on untouched. */
function expandFor(params: { toolName: unknown; args: unknown; registry: ToolRegistry; aliases: AliasTable }): unknown {
  const { toolName, args, registry, aliases } = params;
  const tool = typeof toolName === 'string' ? registry.get(toolName) : undefined;
  return tool?.acceptsAliases === true ? expandAliases(args, aliases) : args;
}

/** Each inner call of an `aigent_multi` call is expanded by its own tool's opt-in; the wrapper itself never is. */
function expandMultiArgs(params: { args: unknown; registry: ToolRegistry; aliases: AliasTable }): unknown {
  const { args, registry, aliases } = params;
  if (!isPlainObject(args) || !Array.isArray(args.calls)) return args;
  const calls = args.calls.map((inner: unknown) => {
    if (!isPlainObject(inner)) return inner;
    return { ...inner, args: expandFor({ toolName: inner.tool, args: inner.args, registry, aliases }) };
  });
  return { ...args, calls };
}

/**
 * The call with aliases the model wrote expanded, so keys, validation and traces see the full text. Only tools that
 * declare `acceptsAliases` get expansion, and only for string arguments that exactly equal an alias issued in this
 * run: a literal `F1` (a key, a plan id, a cell) sent to any other tool, including the built-in ones, reaches it as is.
 */
export function expandCallAliases(params: ExpandCallAliasesParams): ToolCall {
  const { call, registry, aliases } = params;
  if (aliases.size() === 0) return call;
  const { name, args } = call;
  if (name === MULTI_TOOL_NAME) return { ...call, args: expandMultiArgs({ args, registry, aliases }) };
  return { ...call, args: expandFor({ toolName: name, args, registry, aliases }) };
}
