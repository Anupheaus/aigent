import { ANTHROPIC_RESERVED_BODY_FIELDS, toAnthropicSettingsFields } from './anthropic-settings.js';
import { bodyOptions } from './provider-options.js';
import type {
  AnthropicCacheControl, AnthropicMessage, AnthropicMessagesBody, AnthropicRedactedThinkingBlock, AnthropicTextBlock, AnthropicThinkingBlock, AnthropicTool,
  AnthropicToolResultBlock, AnthropicToolUseBlock, AnthropicUserBlock,
} from './anthropic-wire-types.js';
import type { ProviderMessage, ProviderRequest, ProviderToolSpec, ThinkingBlock, ToolCall } from './provider-types.js';

export interface AnthropicRequestSettings {
  /** Used when the request has no `maxOutputTokens` setting; the API rejects requests without `max_tokens`. */
  defaultMaxTokens: number;
  /**
   * Marks the system block (which also caches the tools, as they come first) and, when the request ends in a volatile
   * block, the last stable message block as ephemeral cache breakpoints, unless the request's `promptCaching` says otherwise.
   */
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

/** The message with an ephemeral cache breakpoint on its last block (the end of the stable prefix). */
function withBreakpoint(message: AnthropicMessage): AnthropicMessage {
  if (message.role === 'assistant') {
    const blocks = message.content;
    const last = blocks.at(-1);
    // Assistant turns always end in text or tool_use (thinking blocks come first), both of which may carry a breakpoint.
    if (last == null || (last.type !== 'text' && last.type !== 'tool_use')) return message;
    return { role: 'assistant', content: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL_CACHE }] };
  }
  const blocks = toUserBlocks(message.content);
  const last = blocks.at(-1);
  if (last == null) return message;
  return { role: 'user', content: [...blocks.slice(0, -1), { ...last, cache_control: EPHEMERAL_CACHE }] };
}

interface ToAnthropicMessagesParams {
  messages: ProviderMessage[];
  /** Puts a breakpoint on the last block before the volatile block, when the request has one. */
  promptCaching: boolean;
  /** The request's breakpoints; when present they replace the volatile-block rule. */
  cacheBreakpoints?: number[];
}

/**
 * Breakpoints Anthropic allows on messages: four per request in all, and the system block (which also caches the
 * tools) always takes one.
 */
const MAX_MESSAGE_BREAKPOINTS = 3;

/**
 * The request's breakpoints that can carry a marker (not system messages, which live in the system block, nor the
 * volatile block), keeping the latest ones when there are too many: a later breakpoint caches everything before it.
 */
function markedIndices(params: { messages: ProviderMessage[]; cacheBreakpoints: number[] }): ReadonlySet<number> {
  const { messages, cacheBreakpoints } = params;
  const eligible = cacheBreakpoints.filter(index => {
    const message = messages[index];
    return message != null && message.role !== 'system' && message.volatile !== true;
  });
  return new Set(eligible.slice(-MAX_MESSAGE_BREAKPOINTS));
}

/**
 * Explicit breakpoints: each indicated message is marked on its own last block before it is merged with its
 * neighbours, so the marker stays at the end of that message's content even inside a merged user turn.
 */
function toMarkedMessages(params: { messages: ProviderMessage[]; marked: ReadonlySet<number> }): AnthropicMessage[] {
  const { messages, marked } = params;
  const replacedArgs = collectReplacedArgs(messages);
  return messages.reduce<AnthropicMessage[]>((wire, message, index) => {
    const converted = toWireMessage({ message, replacedArgs });
    if (converted == null) return wire;
    const next = marked.has(index) ? withBreakpoint(converted) : converted;
    const previous = wire.at(-1);
    const merged = previous == null ? undefined : mergeSameRole({ previous, next });
    return merged == null ? [...wire, next] : [...wire.slice(0, -1), merged];
  }, []);
}

/**
 * Maps conversation messages (system ones excluded) and merges adjacent same-role messages, so roles alternate as the
 * API requires: consecutive tool results become ONE user message (the API wants every result for an assistant turn
 * together), a user message after them joins it as text after the results, and dropping an empty assistant turn
 * cannot leave two user messages in a row.
 *
 * With prompt caching, a request that ends in a volatile block gets an ephemeral breakpoint on the last block of the
 * stable history before it, so everything up to there (tools, system, every earlier turn) is read from the cache on the
 * next turn. The breakpoint is placed before the volatile text is merged in: when that text joins the last tool-result
 * message, the breakpoint stays on the tool result, never on the text that changes every turn.
 */
function toAnthropicMessages(params: ToAnthropicMessagesParams): AnthropicMessage[] {
  const { messages, promptCaching, cacheBreakpoints } = params;
  if (cacheBreakpoints != null) {
    const marked = promptCaching ? markedIndices({ messages, cacheBreakpoints }) : new Set<number>();
    return toMarkedMessages({ messages, marked });
  }
  const replacedArgs = collectReplacedArgs(messages);
  const append = (wire: AnthropicMessage[], message: ProviderMessage): AnthropicMessage[] => {
    const next = toWireMessage({ message, replacedArgs });
    if (next == null) return wire;
    const previous = wire.at(-1);
    const merged = previous == null ? undefined : mergeSameRole({ previous, next });
    return merged == null ? [...wire, next] : [...wire.slice(0, -1), merged];
  };
  const stable = messages.filter(({ volatile }) => volatile !== true).reduce(append, []);
  const volatileMessages = messages.filter(({ volatile }) => volatile === true);
  const lastStable = stable.at(-1);
  const isMarked = promptCaching && volatileMessages.length > 0 && lastStable != null;
  const marked = isMarked ? [...stable.slice(0, -1), withBreakpoint(lastStable)] : stable;
  return volatileMessages.reduce(append, marked);
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
  const { model, messages, tools, settings = {}, cacheBreakpoints } = request;
  const { defaultMaxTokens } = adapterSettings;
  const promptCaching = settings.promptCaching ?? adapterSettings.promptCaching;
  const system = toSystem({ messages, promptCaching });
  return {
    ...bodyOptions({ providerOptions: settings.providerOptions, reserved: ANTHROPIC_RESERVED_BODY_FIELDS }),
    model,
    stream: true,
    ...toAnthropicSettingsFields({ settings, defaultMaxTokens }),
    ...(system == null ? {} : { system }),
    messages: toAnthropicMessages({ messages, promptCaching, ...(cacheBreakpoints == null ? {} : { cacheBreakpoints }) }),
    ...(tools.length === 0 ? {} : { tools: tools.map(toAnthropicTool) }),
  };
}
