import type { TaskUsage } from '../core/agent-types.js';
import type { TaskStatus } from '../core/aigent-events.js';
import type { Provider } from '../providers/provider-types.js';
import type { Store } from '../store/store-types.js';
import type { ToolEnvelope } from '../tools/tool-envelope.js';
import type { Tool } from '../tools/tool-types.js';

/** `onRunStart`: a run (a task or a chat turn) started. */
export interface RunStartInfo {
  runId: string;
  agentName: string;
  instanceId: string;
  /** `provider:model` of the run's primary model. */
  model: string;
  mode: 'task' | 'chat';
}

/** `onToolCall`: the model asked for a call (before it runs). */
export interface ToolCallInfo {
  runId: string;
  agentName: string;
  callId: string;
  tool: string;
  args: unknown;
}

/** `onToolResult`: a call finished (or was refused); `envelope` is what the model receives. */
export interface ToolResultInfo {
  runId: string;
  agentName: string;
  callId: string;
  envelope: ToolEnvelope;
}

/** `onRunEnd`: the run settled, its records written; called before the run's `done` event. */
export interface RunEndInfo {
  runId: string;
  agentName: string;
  instanceId: string;
  status: TaskStatus;
  usage: TaskUsage;
}

/** `onError`: the run reported an error (the same text as its `error` event). */
export interface RunErrorInfo {
  runId: string;
  agentName: string;
  message: string;
}

/**
 * Lifecycle observers. Each receives a deep-frozen copy (never the live object), so a hook cannot change a run; hooks
 * run one at a time in plugin order, each bounded by a 1000 ms timeout, and a throwing or slow hook only produces a
 * `warning` event.
 */
export interface PluginHooks {
  onRunStart?(info: RunStartInfo): void | Promise<void>;
  onToolCall?(info: ToolCallInfo): void | Promise<void>;
  onToolResult?(info: ToolResultInfo): void | Promise<void>;
  onRunEnd?(info: RunEndInfo): void | Promise<void>;
  onError?(info: RunErrorInfo): void | Promise<void>;
}

/** A store a plugin offers, selectable with `createAigent({ store: '<id>' })`. */
export interface PluginStore {
  /** Unique across the runtime's plugins. */
  id: string;
  store: Store;
}

/** What a plugin's asynchronous start-up found (e.g. the tools an MCP server lists). */
export interface PluginSetupResult {
  /** Joins the plugin's `tools`; names must stay unique within the plugin. */
  tools?: Tool[];
}

/**
 * A bundle of providers, tools, stores and hooks wired in with one line: `createAigent({ plugins: [plugin] })` or
 * `ai.use(plugin)`. Plain data, validated by `definePlugin`.
 */
export interface Plugin {
  /** Kebab-case (`my-plugin`), unique within a runtime. */
  name: string;
  /** Semver-style (`1.2.3`, `1.0.0-beta.1`). */
  version: string;
  /** Selected as `'<provider id>:<model>'`; ids must not collide with any other provider of the runtime. */
  providers?: Provider[];
  /** Offered to agents only through `tools: [pluginTools('<plugin name>')]`, never added to every agent. */
  tools?: Tool[];
  stores?: PluginStore[];
  hooks?: PluginHooks;
  /**
   * Declares hooks that want to change what they observe. Refused unless the runtime lists the plugin in
   * `allowMutatingPlugins`; even then hooks still receive frozen copies (no mutation API exists yet).
   */
  mutating?: boolean;
  /** Asynchronous start-up (connecting, listing tools), started by `ai.ready()`; its tools join `tools`. */
  setup?(): Promise<PluginSetupResult | void>;
  /** Releases what the plugin holds (processes, connections); called once by `ai.close()`. */
  close?(): Promise<void>;
}

/** Stands for every tool of the named plugin in `AgentDefinition.tools`; made by `pluginTools`. */
export interface PluginToolsRef {
  type: 'plugin-tools';
  plugin: string;
}
