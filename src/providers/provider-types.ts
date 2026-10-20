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

export interface ProviderMessage {
  role: MessageRole;
  text?: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
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

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools: ProviderToolSpec[];
  maxOutputTokens?: number;
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
}

export interface Provider {
  /** Prefix used in `provider:model` strings. */
  id: string;
  capabilities: ProviderCapabilities;
  /** Must stop yielding and throw an `aborted` AigentError promptly when `signal` aborts. */
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
