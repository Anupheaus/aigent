import type { JsonSchema, ProviderMessage, ProviderRequest, ProviderToolSpec, ToolCall } from './provider-types.js';

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
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type AnthropicMessage =
  | { role: 'user'; content: string | AnthropicToolResultBlock[] }
  | { role: 'assistant'; content: (AnthropicTextBlock | AnthropicToolUseBlock)[] };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
}

export interface AnthropicRequestSettings {
  /** Used when the request has no `maxOutputTokens`; the API rejects requests without `max_tokens`. */
  defaultMaxTokens: number;
  /** Marks the system block as an ephemeral cache breakpoint. */
  promptCaching: boolean;
}

/** System messages are concatenated with a blank line between them, as one prompt. */
const SYSTEM_SEPARATOR = '\n\n';
const EPHEMERAL_CACHE: AnthropicCacheControl = { type: 'ephemeral' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    // The model's own malformed JSON; the API only accepts an object for `input`, so it is replaced below.
    return undefined;
  }
}

/** `input` must be an object: string args are parsed when possible; anything else (malformed, arrays) becomes `{}`. */
function toToolInput(args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) return args;
  if (typeof args === 'string') return parseObject(args) ?? {};
  return {};
}

function toToolUseBlock(call: ToolCall): AnthropicToolUseBlock {
  const { id, name, args } = call;
  return { type: 'tool_use', id, name, input: toToolInput(args) };
}

function toAssistantMessage(message: ProviderMessage): AnthropicMessage {
  const { text = '', toolCalls = [] } = message;
  const textBlocks: AnthropicTextBlock[] = text === '' ? [] : [{ type: 'text', text }];
  return { role: 'assistant', content: [...textBlocks, ...toolCalls.map(toToolUseBlock)] };
}

function toToolResultBlock(message: ProviderMessage): AnthropicToolResultBlock {
  const { toolCallId = '', text = '' } = message;
  return { type: 'tool_result', tool_use_id: toolCallId, content: text };
}

/** Appends a tool result to the previous message when that one already holds tool results, else opens a new user message. */
function appendToolResult(params: { wire: AnthropicMessage[]; message: ProviderMessage }): AnthropicMessage[] {
  const { wire, message } = params;
  const block = toToolResultBlock(message);
  const previous = wire.at(-1);
  if (previous?.role === 'user' && Array.isArray(previous.content)) {
    return [...wire.slice(0, -1), { role: 'user', content: [...previous.content, block] }];
  }
  return [...wire, { role: 'user', content: [block] }];
}

/**
 * Maps conversation messages (system ones excluded). Consecutive tool results become ONE user message, because the
 * API wants every result for an assistant turn together; a plain user message after them stays separate.
 */
function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  return messages.reduce<AnthropicMessage[]>((wire, message) => {
    const { role, text = '' } = message;
    switch (role) {
      case 'system':
        return wire;
      case 'user':
        return [...wire, { role: 'user', content: text }];
      case 'assistant':
        return [...wire, toAssistantMessage(message)];
      case 'tool':
        return appendToolResult({ wire, message });
    }
  }, []);
}

function toSystem(params: { messages: ProviderMessage[]; promptCaching: boolean }): string | AnthropicTextBlock[] | undefined {
  const { messages, promptCaching } = params;
  const text = messages
    .filter(({ role }) => role === 'system')
    .map(({ text: systemText = '' }) => systemText)
    .join(SYSTEM_SEPARATOR);
  if (text === '') return undefined;
  return promptCaching ? [{ type: 'text', text, cache_control: EPHEMERAL_CACHE }] : text;
}

function toAnthropicTool(tool: ProviderToolSpec): AnthropicTool {
  // `strict` is an OpenAI decoding flag with no Anthropic equivalent, so it is not sent.
  const { name, description, parameters } = tool;
  return { name, description, input_schema: parameters };
}

/** Translates a normalised request into the Anthropic streaming Messages API body. */
export function toAnthropicMessagesRequest(request: ProviderRequest, settings: AnthropicRequestSettings): AnthropicMessagesRequest {
  const { model, messages, tools, maxOutputTokens } = request;
  const { defaultMaxTokens, promptCaching } = settings;
  const system = toSystem({ messages, promptCaching });
  return {
    model,
    max_tokens: maxOutputTokens ?? defaultMaxTokens,
    stream: true,
    ...(system == null ? {} : { system }),
    messages: toAnthropicMessages(messages),
    ...(tools.length === 0 ? {} : { tools: tools.map(toAnthropicTool) }),
  };
}
