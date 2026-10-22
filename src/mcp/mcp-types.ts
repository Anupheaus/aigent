import type { McpTransport } from './mcp-transport.js';

/** Per-tool settings a consumer can override (`toolOverrides`), keyed by aigent tool name or `<server>/<mcp tool>`. */
export interface McpToolFlags {
  /** Only honoured together with `readOnly`. Default false. */
  deterministic: boolean;
  /** Only honoured together with `readOnly`. Default false. */
  cache: boolean;
  /** Cache lifetime for non-deterministic cached tools (default 60 000). */
  cacheTtlMs: number;
  timeoutMs: number;
  maxResultTokens: number;
  /** The tool changes nothing: it loses `hasSideEffects` and may be cached. Default false (MCP tools are assumed to mutate). */
  readOnly: boolean;
  /** False passes the server's schema through unchanged with strict decoding off (for schemas the strict subset cannot express). */
  strictSchema: boolean;
  /** Overrides the server's `approvals` for this tool. */
  requiresApproval: boolean;
}

/** Defaults for every tool of the plugin; per-tool overrides win. */
export interface McpDefaults {
  deterministic?: boolean;
  cache?: boolean;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxResultTokens?: number;
}

export interface McpStdioTransportConfig {
  type: 'stdio';
  /** Started without a shell: give the program itself (e.g. `process.execPath`, or the full path of `npx.cmd` on Windows). */
  command: string;
  args?: string[];
  /** Added to the scrubbed environment (only `DEFAULT_ENV_ALLOW` names are inherited, never credentials). */
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpTransportConfig {
  type: 'http';
  /** The server's streamable-HTTP endpoint. */
  url: string;
  headers?: Record<string, string>;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export interface McpCustomTransportConfig {
  type: 'custom';
  transport: McpTransport;
}

export interface McpServerConfig {
  /** Names the server in tool names (`<server>__<tool>`), messages and the report. */
  name: string;
  transport: McpStdioTransportConfig | McpHttpTransportConfig | McpCustomTransportConfig;
  /** Only these MCP tool names are offered (default: all). */
  allowTools?: string[];
  /** These MCP tool names are never offered (wins over `allowTools`). */
  denyTools?: string[];
  /** Every call of this server's tools needs a person's approval. Default false. */
  approvals?: boolean;
}

export interface McpPluginOptions {
  /** The plugin's name (default `mcp`), used in `pluginTools('<name>')`. */
  name?: string;
  servers: McpServerConfig[];
  defaults?: McpDefaults;
  toolOverrides?: Record<string, Partial<McpToolFlags>>;
  /** `server` (default): tools are named `<server>__<tool>`; `none`: just `<tool>` (collisions get `_2`...). */
  namePrefix?: 'server' | 'none';
  /** Receives what the plugin ignored (malformed messages, transport warnings); also kept in `report()`. */
  onWarning?(message: string): void;
}

/** How a tool's schema was taken: as is, tightened into the strict subset, or passed through loose (`strictSchema: false`). */
export type McpSchemaStatus = 'accepted' | 'tightened' | 'loose';

export interface McpToolReport {
  /** The aigent tool name. */
  name: string;
  server: string;
  mcpName: string;
  schema: McpSchemaStatus;
  /** Every change made to the schema (empty when accepted). */
  changes: string[];
  readOnly: boolean;
  cache: boolean;
  deterministic: boolean;
  requiresApproval: boolean;
}

export interface McpSkippedTool {
  server: string;
  mcpName: string;
  reason: string;
}

export interface McpServerReport {
  name: string;
  status: 'pending' | 'connected' | 'failed' | 'closed';
  /** Why the server failed to connect. */
  error?: string;
}

export interface McpReport {
  servers: McpServerReport[];
  tools: McpToolReport[];
  skipped: McpSkippedTool[];
  /** The most recent warnings (bounded). */
  warnings: string[];
}
