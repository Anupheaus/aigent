import type { ModelSettings } from '../core/model-settings.js';

/** JSON Schema document (plain JSON). */
export type JsonSchema = Record<string, unknown>;

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Provider-assigned id, echoed back on the tool result message. */
  id: string;
  name: string;
  /** Parsed JSON arguments exactly as the model produced them. */
  args: unknown;
}

/**
 * A completed reasoning block, kept so it can be sent back unmodified with the assistant turn it belongs to. Anthropic
 * requires the last assistant turn's blocks (with their signature, or encrypted `data`) ahead of its `tool_use` blocks
 * whenever thinking is on; anything else is rejected.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted-thinking'; data: string };

export interface ProviderMessage {
  role: MessageRole;
  text?: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** On assistant messages: the turn's completed thinking blocks, in order, to be replayed verbatim. */
  thinkingBlocks?: ThinkingBlock[];
  /** Present on tool messages: the call this result answers. */
  toolCallId?: string;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * True when `parameters` follows the strict subset, so adapters should request strict decoding. False only for tools
   * that opted out (`strictSchema: false`, e.g. the built-in `aigent_multi`); adapters must send those with strict off.
   */
  strict: boolean;
}

/** The settings an adapter receives: model settings minus the runtime-only ones (`contextSize`, `showThinking`). */
export type ProviderSettings = Omit<ModelSettings, 'contextSize' | 'showThinking'>;

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  /**
   * Resolved settings, already stripped of anything the provider declared it cannot honour. Absent when none are set.
   * Adapters map what they support and ignore the rest.
   */
  settings?: ProviderSettings;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length';

export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  /** A thinking block is complete (after its deltas); the run keeps it on the assistant message for replay. */
  | { type: 'thinking-block'; block: ThinkingBlock }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: FinishReason };

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  promptCaching: boolean;
  vision: boolean;
  /** Published context window in tokens. */
  maxContextTokens: number;
  /**
   * True when the provider emits `thinking-block` events and replays `ProviderMessage.thinkingBlocks`; the contract
   * suite then runs its `thinking-round-trip` scenario. Absent means false.
   */
  thinkingBlocks?: boolean;
  /** Settings this provider can map; the run warns about and leaves out any other setting before calling it. */
  supportedSettings: (keyof ProviderSettings)[];
}

export interface Provider {
  /** Prefix used in `provider:model` strings. */
  id: string;
  capabilities: ProviderCapabilities;
  /**
   * Must stop yielding and throw an `aborted` AigentError promptly when `signal` aborts. Emits at most one `usage`
   * event, and none when the backend reported no usage (never invented zeros), then a final `done`.
   */
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  /**
   * Supported settings this provider cannot honour in this combination (e.g. `temperature` while thinking is on).
   * Pure; the run warns about and leaves out each one before calling `stream`.
   */
  unsupportedSettings?(settings: ProviderSettings): (keyof ProviderSettings)[];
}
