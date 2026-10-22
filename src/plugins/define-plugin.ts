import { z } from 'zod';
import { createAigentError } from '../core/aigent-error.js';
import { describeIssues } from '../core/describe-issues.js';
import type { Tool } from '../tools/tool-types.js';
import type { Plugin } from './plugin-types.js';

/** Kebab-case: lowercase words joined by single hyphens. */
const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Semver-style: `major.minor.patch`, an optional `-prerelease` and an optional `+build`. */
const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type AnyFunction = (...args: never[]) => unknown;

const fn = z.custom<AnyFunction>(value => typeof value === 'function', { message: 'must be a function' });

const providerShape = z.looseObject({
  id: z.string().min(1),
  capabilities: z.looseObject({}),
  stream: fn,
});

const toolShape = z.looseObject({
  name: z.string().min(1),
  description: z.string(),
  jsonSchema: z.looseObject({}),
  argsSchema: z.custom<z.ZodType>(value => value instanceof z.ZodType, { message: 'must be a zod schema (use defineTool)' }),
  run: fn,
});

const storeShape = z.looseObject({ get: fn, compareAndSet: fn, list: fn });

const hooksShape = z.strictObject({
  onRunStart: fn.optional(),
  onToolCall: fn.optional(),
  onToolResult: fn.optional(),
  onRunEnd: fn.optional(),
  onError: fn.optional(),
});

const pluginShape = z.strictObject({
  name: z.string().regex(PLUGIN_NAME_PATTERN, { message: `Plugin name must be kebab-case (${PLUGIN_NAME_PATTERN})` }),
  version: z.string().regex(PLUGIN_VERSION_PATTERN, { message: 'Plugin version must be semver-style, e.g. 1.2.3 or 1.0.0-beta.1' }),
  providers: z.array(providerShape).optional(),
  tools: z.array(toolShape).optional(),
  stores: z.array(z.strictObject({ id: z.string().min(1), store: storeShape })).optional(),
  hooks: hooksShape.optional(),
  mutating: z.boolean().optional(),
  setup: fn.optional(),
  close: fn.optional(),
});

function pluginLabel(plugin: unknown): string {
  const name = (plugin as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : String(name);
}

/** Throws `invalid_definition` when `values` repeats an entry, naming the plugin, the kind and the entry. */
function rejectDuplicates(params: { plugin: string; kind: string; values: string[] }): void {
  const { plugin, kind, values } = params;
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw createAigentError({ code: 'invalid_definition', message: `Plugin '${plugin}' declares ${kind} '${value}' twice; each must be unique within the plugin`, details: { plugin, [kind]: value } });
    seen.add(value);
  }
}

/** Duplicate tool names inside one plugin (also checked for tools its `setup` finds). */
export function rejectDuplicateTools(params: { plugin: string; tools: Tool[] }): void {
  const { plugin, tools } = params;
  rejectDuplicates({ plugin, kind: 'tool', values: tools.map(({ name }) => name) });
}

/** Validates a plugin (names, versions, the shape of every contribution, duplicates inside it) and returns it. */
export function definePlugin<TPlugin extends Plugin>(plugin: TPlugin): TPlugin {
  const parsed = pluginShape.safeParse(plugin);
  const label = pluginLabel(plugin);
  if (!parsed.success) {
    throw createAigentError({ code: 'invalid_definition', message: `Plugin '${label}' is invalid: ${describeIssues(parsed.error)}`, details: { plugin: label } });
  }
  const { name, providers = [], tools = [], stores = [] } = plugin;
  rejectDuplicates({ plugin: name, kind: 'provider id', values: providers.map(({ id }) => id) });
  rejectDuplicateTools({ plugin: name, tools });
  rejectDuplicates({ plugin: name, kind: 'store id', values: stores.map(({ id }) => id) });
  return plugin;
}
