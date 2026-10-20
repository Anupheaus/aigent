import type { AnthropicSettingsFields } from './anthropic-settings.js';
import type { JsonSchema } from './provider-types.js';

/** Wire shapes of the Anthropic Messages API request (only the fields we send). */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  /** Set for failed tool envelopes, so the model treats the content as an error. */
  is_error?: true;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicUserBlock = AnthropicTextBlock | AnthropicToolResultBlock;
export type AnthropicAssistantBlock = AnthropicThinkingBlock | AnthropicRedactedThinkingBlock | AnthropicTextBlock | AnthropicToolUseBlock;

export type AnthropicMessage =
  | { role: 'user'; content: string | AnthropicUserBlock[] }
  | { role: 'assistant'; content: AnthropicAssistantBlock[] };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface AnthropicMessagesRequest extends AnthropicSettingsFields {
  model: string;
  stream: true;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

/** The request plus any `providerOptions` fields, which may add fields but never replace a reserved one. */
export type AnthropicMessagesBody = AnthropicMessagesRequest & Record<string, unknown>;
