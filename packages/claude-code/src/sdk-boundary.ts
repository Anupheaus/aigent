import { createAigentError } from '@anupheaus/aigent';
import type { JsonSchema } from '@anupheaus/aigent';
import { z } from 'zod';
import { BRIDGE_SERVER_NAME, BUILT_IN_SDK_TOOLS, bridgedToolName } from './tool-bridge.js';

/** The optional peer; imported only when the default runner first runs, never at module load. */
const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

/**
 * One message of the Claude Agent SDK stream (`stream_event`, `assistant`, `user`, `system`, `result`...). Kept
 * loose on purpose: the mapper reads only the fields it knows and ignores the rest, so SDK additions do not break it.
 */
export interface SdkMessage {
  type: string;
  [field: string]: unknown;
}

/** One of our tools as the SDK sees it: an in-process MCP tool whose call runs in this process. */
export interface BridgedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(args: unknown): Promise<{ text: string; isError: boolean }>;
}

export interface ClaudeAgentRunParams {
  prompt: string;
  system: string;
  model?: string;
  tools: BridgedTool[];
  env: Record<string, string>;
  cwd?: string;
  /** Aborting it must stop the run and kill the Claude Code subprocess. */
  signal: AbortSignal;
  includePartialMessages: true;
}

/** The boundary to Claude Code: the real SDK by default, a fake in tests. */
export interface ClaudeAgentRunner {
  run(params: ClaudeAgentRunParams): AsyncIterable<SdkMessage>;
}

/** The parts of the SDK module the default runner uses. */
interface SdkModule {
  query(params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): AsyncIterable<SdkMessage>;
  createSdkMcpServer(options: { name: string; version?: string; tools: unknown[] }): unknown;
  tool(name: string, description: string, shape: Record<string, z.ZodType>, handler: (args: Record<string, unknown>) => Promise<unknown>): unknown;
}

async function loadSdk(): Promise<SdkModule> {
  try {
    // A variable specifier: the SDK is an optional peer, so nothing may resolve it before it is needed.
    const specifier: string = SDK_MODULE;
    return await import(specifier) as SdkModule;
  } catch (error) {
    throw createAigentError({
      code: 'provider_failed',
      message: `The Claude Code provider needs the optional peer '${SDK_MODULE}' (not installed or failed to load: ${error instanceof Error ? error.message : String(error)}); install it, or pass claudeCode({ runner })`,
      details: { module: SDK_MODULE, retryable: false },
    });
  }
}

/** Values pass through unvalidated here: the core validates every call against the tool's strict schema. */
function passThroughShape(schema: JsonSchema): Record<string, z.ZodType> {
  const properties = typeof schema.properties === 'object' && schema.properties !== null ? Object.keys(schema.properties) : [];
  return Object.fromEntries(properties.map(name => [name, z.unknown()]));
}

/** Streaming input mode (required for in-process MCP tools): the prompt as a single user message. */
async function* promptMessages(prompt: string): AsyncGenerator<unknown> {
  yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
}

/**
 * The default runner over `@anthropic-ai/claude-agent-sdk` `query()`: our tools as one in-process MCP server, every
 * built-in Claude Code tool disallowed, no settings files loaded, only bridged tools permitted. UNVERIFIED against the
 * real SDK (the live spike is pending; see README).
 */
export function createSdkRunner(): ClaudeAgentRunner {
  return {
    async *run(params) {
      const { prompt, system, model, tools, env, cwd, signal, includePartialMessages } = params;
      const sdk = await loadSdk();
      const server = sdk.createSdkMcpServer({
        name: BRIDGE_SERVER_NAME,
        tools: tools.map(bridged => sdk.tool(bridged.name, bridged.description, passThroughShape(bridged.inputSchema), async args => {
          const { text, isError } = await bridged.execute(args);
          return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
        })),
      });
      const abortController = new AbortController();
      const onAbort = (): void => abortController.abort(signal.reason);
      if (signal.aborted) onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      const allowed = new Set(tools.map(({ name }) => bridgedToolName(name)));
      try {
        yield* sdk.query({
          prompt: promptMessages(prompt),
          options: {
            systemPrompt: system, ...(model == null ? {} : { model }), ...(cwd == null ? {} : { cwd }), env, abortController, includePartialMessages,
            mcpServers: { [BRIDGE_SERVER_NAME]: server }, allowedTools: [...allowed], disallowedTools: [...BUILT_IN_SDK_TOOLS], settingSources: [],
            // Belt and braces: anything that is not one of our bridged tools is denied, whatever the SDK offers.
            canUseTool: async (toolName: string, input: Record<string, unknown>) => (allowed.has(toolName) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `Only aigent tools may run; '${toolName}' is disabled` }),
          },
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
