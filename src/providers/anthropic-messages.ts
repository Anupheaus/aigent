import { ANTHROPIC_RESERVED_BODY_FIELDS, toAnthropicSettingsFields } from './anthropic-settings.js';
import { bodyOptions } from './provider-options.js';
import type { AnthropicSettingsFields } from './anthropic-settings.js';
import type { JsonSchema, ProviderMessage, ProviderRequest, ProviderToolSpec, ThinkingBlock, ToolCall } from './provider-types.js';

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
  /** Set for failed tool envelopes, so the model treats the content as an error. */
  is_error?: true;
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

export interface AnthropicRequestSettings {
  /** Used when the request has no `maxOutputTokens` setting; the API rejects requests without `max_tokens`. */
  defaultMaxTokens: number;
  /** Marks the system block as an ephemeral cache breakpoint, unless the request's `promptCaching` setting says otherwise. */
  promptCaching: boolean;
}

/** System messages are concatenated with a blank line between them, as one prompt. */
const SYSTEM_SEPARATOR = '\n\n';
const EPHEMERAL_CACHE: AnthropicCacheControl = { type: 'ephemeral' };
/** Starts a tool result whose call's arguments could not be replayed as an object; the original text follows. */
const REPLACED_ARGS_NOTE = 'The arguments you sent for this call were not a JSON object, so the call above shows {}. You sent: ';
const NOTE_SEPARATOR = '\n\n';

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

/** The args as the model sent them when `toToolInput` had to replace them with `{}`; undefined when they replay as-is. */
function replacedArgsText(args: unknown): string | undefined {
  if (isPlainObject(args)) return undefined;
  if (typeof args === 'string') return parseObject(args) == null ? args : undefined;
  return JSON.stringify(args) ?? String(args);
}

/** Call id → original args text, for every call whose args were replayed as `{}`. */
function collectReplacedArgs(messages: ProviderMessage[]): Map<string, string> {
  const replaced = new Map<string, string>();
  messages.forEach(({ toolCalls = [] }) => toolCalls.forEach(({ id, args }) => {
    const text = replacedArgsText(args);
    if (text != null) replaced.set(id, text);
  }));
  return replaced;
}

/**
 * True for a tool message holding a failed `ToolEnvelope` (`{"ok":false,...}`). Parsed defensively: any other text,
 * including invalid JSON, is not treated as an error.
 */
function isFailedEnvelope(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) && parsed.ok === false;
  } catch {
    // Not an envelope (plain text or invalid JSON): nothing says it failed.
    return false;
  }
}

function toToolUseBlock(call: ToolCall): AnthropicToolUseBlock {
  const { id, name, args } = call;
  return { type: 'tool_use', id, name, input: toToolInput(args) };
}

/** The API rejects text blocks that are empty or only whitespace. */
function hasVisibleText(text: string): boolean {
  return text.trim() !== '';
}

/** Copied field for field, never trimmed or re-encoded: the signature covers the exact text. */
function toThinkingWireBlock(block: ThinkingBlock): AnthropicThinkingBlock | AnthropicRedactedThinkingBlock {
  if (block.type === 'redacted-thinking') return { type: 'redacted_thinking', data: block.data };
  const { thinking, signature } = block;
  return { type: 'thinking', thinking, signature };
}

/**
 * Undefined for an assistant turn that said nothing and called no tools: the API rejects `content: []` (except as the
 * final prefill message) and whitespace-only text, so such a turn is dropped rather than padded with invented text.
 * Thinking blocks go first, as the API requires them ahead of the turn's `tool_use` blocks when thinking is on.
 */
function toAssistantMessage(message: ProviderMessage): AnthropicMessage | undefined {
  const { text = '', toolCalls = [], thinkingBlocks = [] } = message;
  const textBlocks: AnthropicTextBlock[] = hasVisibleText(text) ? [{ type: 'text', text }] : [];
  const answer = [...textBlocks, ...toolCalls.map(toToolUseBlock)];
  if (answer.length === 0) return undefined;
  return { role: 'assistant', content: [...thinkingBlocks.map(toThinkingWireBlock), ...answer] };
}

interface WireMessageParams {
  message: ProviderMessage;
  /** Call id → original args text, for calls replayed with `input: {}`. */
  replacedArgs: ReadonlyMap<string, string>;
}

/**
 * A call replayed as `{}` would otherwise appear next to a validation error about arguments it no longer shows, so
 * the result starts with a note quoting what the model actually sent.
 */
function toToolResultMessage(params: WireMessageParams): AnthropicMessage {
  const { message: { toolCallId = '', text = '' }, replacedArgs } = params;
  const replaced = replacedArgs.get(toolCallId);
  const content = replaced == null ? text : `${REPLACED_ARGS_NOTE}${replaced}${NOTE_SEPARATOR}${text}`;
  const block: AnthropicToolResultBlock = { type: 'tool_result', tool_use_id: toolCallId, content };
  return { role: 'user', content: [isFailedEnvelope(text) ? { ...block, is_error: true } : block] };
}

function toWireMessage(params: WireMessageParams): AnthropicMessage | undefined {
  const { message } = params;
  const { role, text = '' } = message;
  switch (role) {
    case 'system':
      return undefined;
    case 'user':
      return { role: 'user', content: text };
    case 'assistant':
      return toAssistantMessage(message);
    case 'tool':
      return toToolResultMessage(params);
  }
}

function toUserBlocks(content: string | AnthropicUserBlock[]): AnthropicUserBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** Joins two same-role messages into one, keeping block order (so tool results stay ahead of any following text). */
function mergeSameRole(params: { previous: AnthropicMessage; next: AnthropicMessage }): AnthropicMessage | undefined {
  const { previous, next } = params;
  if (previous.role === 'user' && next.role === 'user') {
    return { role: 'user', content: [...toUserBlocks(previous.content), ...toUserBlocks(next.content)] };
  }
  if (previous.role === 'assistant' && next.role === 'assistant') {
    return { role: 'assistant', content: [...previous.content, ...next.content] };
  }
  return undefined;
}

/**
 * Maps conversation messages (system ones excluded) and merges adjacent same-role messages, so roles alternate as the
 * API requires: consecutive tool results become ONE user message (the API wants every result for an assistant turn
 * together), a user message after them joins it as text after the results, and dropping an empty assistant turn
 * cannot leave two user messages in a row.
 */
function toAnthropicMessages(messages: ProviderMessage[]): AnthropicMessage[] {
  const replacedArgs = collectReplacedArgs(messages);
  return messages.reduce<AnthropicMessage[]>((wire, message) => {
    const next = toWireMessage({ message, replacedArgs });
    if (next == null) return wire;
    const previous = wire.at(-1);
    const merged = previous == null ? undefined : mergeSameRole({ previous, next });
    return merged == null ? [...wire, next] : [...wire.slice(0, -1), merged];
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

/** Translates a normalised request into the Anthropic streaming Messages API body, plus any non-reserved `providerOptions`. */
export function toAnthropicMessagesRequest(request: ProviderRequest, adapterSettings: AnthropicRequestSettings): AnthropicMessagesBody {
  const { model, messages, tools, settings = {} } = request;
  const { defaultMaxTokens } = adapterSettings;
  const promptCaching = settings.promptCaching ?? adapterSettings.promptCaching;
  const system = toSystem({ messages, promptCaching });
  return {
    ...bodyOptions({ providerOptions: settings.providerOptions, reserved: ANTHROPIC_RESERVED_BODY_FIELDS }),
    model,
    stream: true,
    ...toAnthropicSettingsFields({ settings, defaultMaxTokens }),
    ...(system == null ? {} : { system }),
    messages: toAnthropicMessages(messages),
    ...(tools.length === 0 ? {} : { tools: tools.map(toAnthropicTool) }),
  };
}
