import { toOpenAiSettingsFields } from './openai-settings.js';
import { bodyOptions } from './provider-options.js';
import type { OpenAiSettingsFields, OpenAiTokenLimitField } from './openai-settings.js';
import type { JsonSchema, ProviderMessage, ProviderRequest, ProviderToolSpec, ToolCall } from './provider-types.js';

/** Wire shapes of the OpenAI Chat Completions request (only the fields we send). */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema; strict: boolean };
}

export interface OpenAiChatRequest extends OpenAiSettingsFields {
  model: string;
  messages: OpenAiMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: OpenAiTool[];
}

/** The request plus any `providerOptions` fields, which may add fields but never replace a reserved one. */
export type OpenAiChatBody = OpenAiChatRequest & Record<string, unknown>;

function toOpenAiToolCall(call: ToolCall): OpenAiToolCall {
  const { id, name, args } = call;
  // String args are the model's own (possibly malformed) JSON; echo them back untouched.
  const serialised = typeof args === 'string' ? args : JSON.stringify(args);
  return { id, type: 'function', function: { name, arguments: serialised } };
}

function toOpenAiMessage(message: ProviderMessage): OpenAiMessage {
  const { role, text = '', toolCalls = [], toolCallId = '' } = message;
  switch (role) {
    case 'system':
    case 'user':
      return { role, content: text };
    case 'assistant':
      // OpenAI wants `null` rather than an empty string when the turn only called tools.
      return toolCalls.length === 0
        ? { role, content: text === '' ? null : text }
        : { role, content: text === '' ? null : text, tool_calls: toolCalls.map(toOpenAiToolCall) };
    case 'tool':
      return { role, tool_call_id: toolCallId, content: text };
  }
}

/** An assistant turn that said nothing and called no tools: OpenAI rejects it (`content: null` without `tool_calls`). */
function isEmptyAssistant(message: ProviderMessage): boolean {
  const { role, text = '', toolCalls = [] } = message;
  return role === 'assistant' && toolCalls.length === 0 && text.trim() === '';
}

/** Separates the texts of user messages merged into one. */
const USER_TEXT_SEPARATOR = '\n\n';

/**
 * Drops empty assistant turns rather than inventing text for them, then merges the user messages that end up adjacent:
 * some OpenAI-compatible servers (e.g. deepseek-reasoner) reject consecutive user messages.
 */
function toOpenAiMessages(messages: ProviderMessage[]): OpenAiMessage[] {
  return messages
    .filter(message => !isEmptyAssistant(message))
    .map(toOpenAiMessage)
    .reduce<OpenAiMessage[]>((wire, message) => {
      const previous = wire.at(-1);
      if (previous?.role !== 'user' || message.role !== 'user') return [...wire, message];
      return [...wire.slice(0, -1), { role: 'user', content: `${previous.content}${USER_TEXT_SEPARATOR}${message.content}` }];
    }, []);
}

function toOpenAiTool(tool: ProviderToolSpec): OpenAiTool {
  const { name, description, parameters, strict } = tool;
  return { type: 'function', function: { name, description, parameters, strict } };
}

/** How this server wants some settings sent. */
export interface OpenAiRequestSettings {
  tokenLimitField: OpenAiTokenLimitField;
}

/** Body fields this adapter sets itself; `providerOptions` cannot replace them (see `bodyOptions`). */
export const OPENAI_RESERVED_BODY_FIELDS: readonly string[] = [
  'model', 'messages', 'stream', 'stream_options', 'tools', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed', 'reasoning_effort',
];

/** Translates a normalised request into the OpenAI streaming Chat Completions body, plus any non-reserved `providerOptions`. */
export function toOpenAiChatRequest(request: ProviderRequest, adapterSettings: OpenAiRequestSettings): OpenAiChatBody {
  const { model, messages, tools, settings = {} } = request;
  const { tokenLimitField } = adapterSettings;
  return {
    ...bodyOptions({ providerOptions: settings.providerOptions, reserved: OPENAI_RESERVED_BODY_FIELDS }),
    model,
    messages: toOpenAiMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tools: tools.map(toOpenAiTool) }),
    ...toOpenAiSettingsFields({ settings, tokenLimitField }),
  };
}
