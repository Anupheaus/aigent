import type { Tool } from '../tools/tool-types.js';
import type { PluginToolsRef } from './plugin-types.js';

/** Every tool of the named plugin, for an agent's `tools`: `tools: [pluginTools('mcp')]`. Resolved by `ai.agent`. */
export function pluginTools(plugin: string): PluginToolsRef {
  return { type: 'plugin-tools', plugin };
}

/** Whether an `AgentDefinition.tools` entry is a `pluginTools` reference rather than a tool. */
export function isPluginToolsRef(entry: Tool | PluginToolsRef): entry is PluginToolsRef {
  return (entry as Partial<PluginToolsRef>).type === 'plugin-tools';
}
