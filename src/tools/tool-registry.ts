import { createAigentError } from '../core/aigent-error.js';
import type { ProviderToolSpec } from '../providers/provider-types.js';
import type { Tool } from './tool-types.js';

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  names(): string[];
  /** Specs sorted by name so the prompt prefix is byte-stable. */
  specs(): ProviderToolSpec[];
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw createAigentError({ code: 'invalid_definition', message: `Duplicate tool name '${tool.name}' in registry`, details: { tool: tool.name } });
    }
    byName.set(tool.name, tool);
  }
  const sorted = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    get: name => byName.get(name),
    list: () => sorted,
    names: () => sorted.map(tool => tool.name),
    specs: () => sorted.map(({ name, description, jsonSchema }) => ({ name, description, parameters: jsonSchema })),
  };
}
