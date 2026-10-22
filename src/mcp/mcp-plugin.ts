import { createAigentError } from '../core/aigent-error.js';
import { describeError } from '../core/describe-value.js';
import { LIBRARY_VERSION } from '../core/library-version.js';
import { definePlugin } from '../plugins/define-plugin.js';
import type { Plugin } from '../plugins/plugin-types.js';
import type { Tool } from '../tools/tool-types.js';
import { createHttpTransport } from './http-transport.js';
import { createMcpClient } from './mcp-client.js';
import type { McpClient } from './mcp-client.js';
import { parseMcpOptions } from './mcp-options.js';
import { RESERVED_TOOL_NAMES } from './mcp-tool-name.js';
import { convertServerTools } from './mcp-tools.js';
import type { McpTransport } from './mcp-transport.js';
import type { McpPluginOptions, McpReport, McpServerConfig } from './mcp-types.js';
import { createStdioTransport } from './stdio-transport.js';

const DEFAULT_PLUGIN_NAME = 'mcp';
/** Warnings kept for `report()`. */
const MAX_REPORTED_WARNINGS = 100;

/** The MCP plugin: a `Plugin` whose tools come from its servers, plus what the conversion did. */
export interface McpPlugin extends Plugin {
  /** Servers, converted tools (accepted / tightened / loose, with every schema change), skipped tools and recent warnings. */
  report(): McpReport;
}

function transportFor(server: McpServerConfig): McpTransport {
  const { transport } = server;
  if (transport.type === 'stdio') return createStdioTransport(transport);
  if (transport.type === 'http') return createHttpTransport(transport);
  return transport.transport;
}

/**
 * Consumes MCP servers: on `ai.ready()` it connects to each, lists its tools and converts them into strict aigent
 * tools (offered with `tools: [pluginTools('mcp')]`). Results go through the standard envelope, telemetry, guardrails
 * and `maxResultTokens`; `ai.close()` closes every connection (killing stdio servers' process trees).
 */
export function mcpPlugin(options: McpPluginOptions): McpPlugin {
  const parsed = parseMcpOptions(options);
  const { servers, defaults = {}, toolOverrides = {}, namePrefix = 'server', onWarning } = parsed;
  const report: McpReport = { servers: servers.map(({ name }) => ({ name, status: 'pending' })), tools: [], skipped: [], warnings: [] };
  const clients: McpClient[] = [];
  const warn = (message: string): void => {
    report.warnings.push(message);
    if (report.warnings.length > MAX_REPORTED_WARNINGS) report.warnings.shift();
    onWarning?.(message);
  };
  const setStatus = (index: number, status: McpReport['servers'][number]['status'], error?: string): void => {
    const entry = report.servers[index];
    if (entry != null) Object.assign(entry, { status }, error == null ? {} : { error });
  };

  async function close(): Promise<void> {
    await Promise.allSettled(clients.map(client => client.close()));
    report.servers.forEach((entry, index) => { if (entry.status === 'connected') setStatus(index, 'closed'); });
  }

  async function setup(): Promise<{ tools: Tool[] }> {
    const connected = await Promise.allSettled(servers.map(async (server, index) => {
      const client = createMcpClient({ transport: transportFor(server), serverName: server.name, warn });
      clients.push(client);
      try {
        await client.connect();
        const descriptors = await client.listTools();
        setStatus(index, 'connected');
        return { server, client, descriptors };
      } catch (error) {
        setStatus(index, 'failed', describeError(error));
        throw error;
      }
    }));
    const failed = connected.flatMap((outcome, index) => (outcome.status === 'rejected' ? [`${servers[index]?.name}: ${describeError(outcome.reason)}`] : []));
    if (failed.length > 0) {
      await close();
      throw createAigentError({ code: 'invalid_definition', message: `MCP server(s) could not be set up: ${failed.join('; ')}`, details: { servers: failed } });
    }
    const taken = new Set(RESERVED_TOOL_NAMES);
    const tools: Tool[] = [];
    for (const outcome of connected) {
      if (outcome.status !== 'fulfilled') continue;
      // Converted in server order, so names (and collision suffixes) do not depend on which server answered first.
      const converted = convertServerTools({ ...outcome.value, defaults, toolOverrides, namePrefix, taken });
      tools.push(...converted.tools);
      report.tools.push(...converted.report);
      report.skipped.push(...converted.skipped);
    }
    return { tools };
  }

  const plugin = definePlugin({ name: parsed.name ?? DEFAULT_PLUGIN_NAME, version: LIBRARY_VERSION, setup, close });
  // Not enumerable: the plugin stays exactly the validated shape when the runtime validates it again.
  return Object.defineProperty(plugin, 'report', { value: (): McpReport => structuredClone(report), enumerable: false }) as McpPlugin;
}
