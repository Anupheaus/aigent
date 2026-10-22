import type { ProviderRequest, ProviderToolSpec } from '@anupheaus/aigent';
import type { BridgedTool } from './sdk-boundary.js';

/** The in-process MCP server our tools are exposed through; the SDK names them `mcp__aigent__<tool>`. */
export const BRIDGE_SERVER_NAME = 'aigent';
/** Prefix of call ids made for bridged calls (the SDK does not hand its tool_use id to in-process tools). */
const CALL_ID_PREFIX = 'cc_';
/** Given to the model when a bridged tool is called without the core's delegated loop behind it. */
const NO_EXECUTOR_TEXT = JSON.stringify({ ok: false, error: { category: 'denied', code: 'no_executor', message: 'This tool can only run through the aigent runtime (delegated mode); it was not run' } });

/**
 * Every built-in Claude Code tool, passed as `disallowedTools`, so the SDK's own loop can only call our bridged tools
 * (`tools: []` is not documented to disable them).
 */
export const BUILT_IN_SDK_TOOLS: readonly string[] = [
  'Agent', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell', 'ListMcpResourcesTool', 'MultiEdit', 'NotebookEdit',
  'Read', 'ReadMcpResourceTool', 'SlashCommand', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
];

/** The SDK's name for a bridged tool. */
export function bridgedToolName(name: string): string {
  return `mcp__${BRIDGE_SERVER_NAME}__${name}`;
}

export interface BridgeToolsParams {
  specs: ProviderToolSpec[];
  /** The core's executor (delegated mode); without it a call is refused with a structured failure. */
  executor?: ProviderRequest['toolExecutor'];
}

/**
 * Our tools as in-process MCP tools: same names, descriptions and JSON schemas; each call is handed to the core's
 * executor, which runs it with every guard (validation, approvals, guardrails, cache, dry run, ledger, telemetry).
 */
export function bridgeTools(params: BridgeToolsParams): BridgedTool[] {
  const { specs, executor } = params;
  let calls = 0;
  return specs.map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: parameters,
    execute: async args => {
      if (executor == null) return { text: NO_EXECUTOR_TEXT, isError: true };
      calls += 1;
      const { text, isError } = await executor({ id: `${CALL_ID_PREFIX}${calls}`, name, args });
      return { text, isError };
    },
  }));
}
